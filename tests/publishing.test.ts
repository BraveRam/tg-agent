import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../agent/lib/store";
import {
  enqueuePost,
  deliverPublication,
  verifyPublication,
  revisePublication,
  type PublisherIO,
} from "../agent/lib/publishing";
import { TelegramError } from "../agent/lib/telegram";

function fixture(mediaCount = 0, long = false) {
  const dir = mkdtempSync(join(tmpdir(), "tg-publish-"));
  const s = new Store(dir);
  const c = s.saveChannel({
    chatId: "-1001",
    name: "Test",
    language: "en",
    style: "Brief",
    timezone: "Africa/Nairobi",
    images: "auto",
  });
  const post = {
    channelId: c.id,
    headline: "New discovery",
    text: long ? "Story ".repeat(220) : "A sourced discovery.",
    media: Array.from({ length: mediaCount }, (_, i) => ({
      url: `https://example.com/${i}.jpg`,
    })),
  };
  let next = 1;
  const messages: any[] = [];
  const calls: string[] = [];
  let timeout = "",
    failRead = false,
    failSend = false;
  const io: PublisherIO = {
    check: async () => {},
    media: async (m) => m.url!,
    notice: async () => {},
    read: async (_chat, ids) => {
      if (failRead) throw new Error("Offline");

      return messages.filter((m) => !ids || ids.includes(m.id));
    },
    send: async (method, body: any) => {
      calls.push(method);

      if (failSend) throw new TelegramError("Forbidden");

      let result: any;
      const add = (text: string, hasMedia = false, groupedId: string | null = null) => {
        const m = { id: next++, text: text ?? "", hasMedia, groupedId, date: Date.now() / 1000 };

        messages.push(m);

        return { message_id: m.id };
      };

      if (method === "sendMessage") result = add(body.text);

      if (method === "sendPhoto") result = add(body.caption, true);

      if (method === "sendMediaGroup")
        result = body.media.map((m: any) => add(m.caption, true, "album"));

      if (method === "editMessageText" || method === "editMessageCaption") {
        messages.find((m) => m.id === body.message_id).text = body.text ?? body.caption;
        result = true;
      }

      if (method === "deleteMessage") {
        messages.splice(
          messages.findIndex((m) => m.id === body.message_id),
          1,
        );
        result = true;
      }

      if (timeout === method) {
        timeout = "";
        throw new TelegramError("Lost response", true);
      }

      return result;
    },
  };

  return {
    s,
    c,
    post,
    io,
    messages,
    calls,
    setTimeout: (v: string) => (timeout = v),
    setReadFailure: (v: boolean) => (failRead = v),
    setSendFailure: (v: boolean) => (failSend = v),

    clean() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const count of [0, 1, 3])
  test(`publish and verify ${count} photos`, async () => {
    const f = fixture(count);

    try {
      const p = enqueuePost(f.post, null, f.s);

      await deliverPublication(p.id, f.s, f.io);
      assert.equal(f.s.publication(p.id).status, "verified");
      assert.equal(f.s.publication(p.id).messageIds.length, count || 1);
      await deliverPublication(p.id, f.s, f.io);
      assert.equal(f.calls.length, 1);
    } finally {
      f.clean();
    }
  });

test("accepted text send with lost response reconciles without resend", async () => {
  const f = fixture();

  try {
    f.setTimeout("sendMessage");

    const p = enqueuePost(f.post, null, f.s);

    await deliverPublication(p.id, f.s, f.io);
    assert.equal(f.s.publication(p.id).status, "verified");
    assert.deepEqual(f.calls, ["sendMessage"]);
  } finally {
    f.clean();
  }
});

test("accepted album followed by ambiguous long-text response recovers all IDs", async () => {
  const f = fixture(3, true);

  try {
    f.setTimeout("sendMessage");

    const p = enqueuePost(f.post, null, f.s);

    await deliverPublication(p.id, f.s, f.io);
    assert.equal(f.s.publication(p.id).status, "verified");
    assert.equal(f.s.publication(p.id).messageIds.length, 4);
    assert.deepEqual(f.calls, ["sendMediaGroup", "sendMessage"]);
  } finally {
    f.clean();
  }
});

test("verification failure retries readback only", async () => {
  const f = fixture();

  try {
    f.setReadFailure(true);

    const p = enqueuePost(f.post, null, f.s);

    await deliverPublication(p.id, f.s, f.io);
    assert.equal(f.s.publication(p.id).status, "unverified");
    f.setReadFailure(false);
    await deliverPublication(p.id, f.s, f.io);
    assert.equal(f.s.publication(p.id).status, "verified");
    assert.deepEqual(f.calls, ["sendMessage"]);
  } finally {
    f.clean();
  }
});

test("unresolved ambiguous sends stay uncertain across restart", async () => {
  const f = fixture();

  try {
    f.io.send = async () => {
      throw new TelegramError("Lost response", true);
    };

    const p = enqueuePost(f.post, null, f.s);

    await deliverPublication(p.id, f.s, f.io);
    assert.equal(f.s.publication(p.id).status, "uncertain");
    await deliverPublication(p.id, f.s, f.io);
    assert.equal(f.s.publication(p.id).attempts, 1);
  } finally {
    f.clean();
  }
});

test("pausing a job prevents queued sends and a pause during permission check prevents sending", async () => {
  for (const during of [false, true]) {
    const f = fixture();

    try {
      const j = f.s.saveJob({
        channelId: f.c.id,
        name: "AI",
        task: "AI",
        sources: [],
        schedule: { kind: "interval", minutes: 1 },
        freshnessHours: 24,
      });
      const [run] = f.s.claimDue(j.nextDue);
      const p = enqueuePost(f.post, run.id, f.s);

      if (during)
        f.io.check = async () => {
          f.s.enableJob(j.id, false);
        };
      else f.s.enableJob(j.id, false);

      await deliverPublication(p.id, f.s, f.io);
      assert.equal(f.calls.length, 0);
    } finally {
      f.clean();
    }
  }
});

test("failed destination does not republish successful destination", async () => {
  const f = fixture(),
    g = fixture();

  try {
    const a = enqueuePost(f.post, null, f.s),
      b = enqueuePost(g.post, null, g.s);

    g.setSendFailure(true);
    await deliverPublication(a.id, f.s, f.io);
    await deliverPublication(b.id, g.s, g.io);
    await deliverPublication(a.id, f.s, f.io);
    assert.equal(f.s.publication(a.id).status, "verified");
    assert.equal(g.s.publication(b.id).status, "failed");
    assert.equal(f.calls.length, 1);
  } finally {
    f.clean();
    g.clean();
  }
});

test("owner edits and deletions preserve revisions and verify readback", async () => {
  const f = fixture();

  try {
    const p = enqueuePost(f.post, null, f.s);

    await deliverPublication(p.id, f.s, f.io);
    await revisePublication(
      p.id,
      "edit",
      "Primary source corrected claim",
      "Correction: revised discovery.",
      f.s,
      f.io,
    );
    assert.equal(f.s.publication(p.id).status, "verified");
    await revisePublication(p.id, "delete", "Primary source retracted claim", undefined, f.s, f.io);
    assert.equal(f.s.publication(p.id).status, "deleted");
    assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM revisions").get()!.n, 2);
  } finally {
    f.clean();
  }
});

test("duplicate headlines cannot enqueue repeated stories without source evidence", () => {
  const f = fixture();

  try {
    const a = enqueuePost(f.post, null, f.s);
    const b = enqueuePost(
      {
        ...f.post,
        text: "Another version of the same story",
      },
      null,
      f.s,
    );

    assert.equal(a.id, b.id);
  } finally {
    f.clean();
  }
});

test("album verification requires actual media grouping", async () => {
  const f = fixture(3);

  try {
    const p = enqueuePost(f.post, null, f.s);

    await deliverPublication(p.id, f.s, f.io);
    f.messages.forEach((m) => (m.groupedId = null));
    assert.equal(await verifyPublication(p.id, f.s, f.io), false);
  } finally {
    f.clean();
  }
});

test("publishing preserves supplied text and captions without source or credit footers", async () => {
  for (const count of [0, 1, 2]) {
    const f = fixture(count);

    try {
      const p = enqueuePost(f.post, null, f.s);

      await deliverPublication(p.id, f.s, f.io);
      assert.equal(f.s.publication(p.id).status, "verified");
      assert.equal(f.messages[0].text, f.post.text);
      assert.equal(
        f.messages.some((m) => /Sources:|Photos:/.test(m.text)),
        false,
      );
    } finally {
      f.clean();
    }
  }
});
