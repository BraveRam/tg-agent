import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activityText, activityChunks, sendActivity } from "../agent/lib/activity";
import { activityHook } from "../agent/hooks/telegram_activity";
import { Store } from "../agent/lib/store";
import { TelegramError } from "../agent/lib/telegram";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tg-activity-"));
  const s = new Store(dir);
  const owner = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "12345";

  const calls: any[] = [];
  const pauses: number[] = [];
  const ctx: any = {
    session: {
      id: "session",
      auth: {
        current: {
          authenticator: "telegram",
          principalId: "12345",
          principalType: "user",
          attributes: {},
        },
      },
    },
    agent: { name: "tg-agent", nodeId: "root" },
    channel: { kind: "telegram" },
  };
  const send = async (method: string, body: unknown) => {
    calls.push({ method, body });

    return { message_id: calls.length };
  };
  const pause = async (ms: number) => {
    pauses.push(ms);
  };

  return {
    dir,
    s,
    ctx,
    send,
    pause,
    calls,
    pauses,

    clean() {
      s.close();

      if (owner === undefined) delete process.env.TELEGRAM_OWNER_ID;
      else process.env.TELEGRAM_OWNER_ID = owner;

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("activity sends full assistant text within Telegram limits and does not duplicate on replay or restart", async () => {
  const f = fixture();

  try {
    const text = "a".repeat(4095) + "😀" + "b".repeat(4100);
    const chunks = activityChunks(text);

    assert.equal(chunks.join(""), text);
    assert.ok(chunks.every((chunk) => chunk.length <= 4096 && !/[\uD800-\uDBFF]$/.test(chunk)));
    await Promise.all([
      sendActivity(f.ctx, "message:turn:0:1", text, f.s, f.send, f.pause),
      sendActivity(f.ctx, "message:turn:0:1", text, f.s, f.send, f.pause),
    ]);
    assert.equal(f.calls.map((call) => call.body.text).join(""), text);
    assert.ok(
      f.calls.every((call) => call.method === "sendMessage" && call.body.chat_id === "12345"),
    );

    const reopened = new Store(f.dir);

    await sendActivity(f.ctx, "message:turn:0:1", text, reopened, f.send, f.pause);
    reopened.close();
    assert.equal(f.calls.length, chunks.length);
  } finally {
    f.clean();
  }
});

test("activity rejects unauthorized sessions and redacts credentials in messages and tool inputs", async () => {
  const f = fixture();
  const old = process.env.TG_INTERNAL_TOKEN;

  process.env.TG_INTERNAL_TOKEN = "private-integration-token";

  try {
    const safe = activityText({
      token: "test-secret",
      nested: { password: "test-password", query: "Bearer private-bearer" },
      text: "private-integration-token",
    });

    await sendActivity(f.ctx, "call:1", safe, f.s, f.send, f.pause);

    const body = f.calls[0].body.text;

    assert.ok(!/test-secret|test-password|private-bearer|private-integration-token/.test(body));
    await sendActivity(
      { ...f.ctx, session: { ...f.ctx.session, auth: { current: null } } },
      "call:2",
      "Unauthorized",
      f.s,
      f.send,
      f.pause,
    );
    await sendActivity(
      {
        ...f.ctx,
        session: {
          ...f.ctx.session,
          auth: {
            current: { authenticator: "telegram", principalId: "other", principalType: "user" },
          },
        },
      },
      "call:3",
      "Wrong owner",
      f.s,
      f.send,
      f.pause,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    if (old === undefined) delete process.env.TG_INTERNAL_TOKEN;
    else process.env.TG_INTERNAL_TOKEN = old;

    f.clean();
  }
});

test("lost activity acknowledgments are not resent, and flood waits retry only rejected sends", async () => {
  const f = fixture();

  try {
    let attempts = 0;
    const ambiguous = async () => {
      attempts++;
      throw new TelegramError("Lost acknowledgment", true);
    };

    await sendActivity(f.ctx, "call:uncertain", "Uncertain", f.s, ambiguous, f.pause);
    await sendActivity(f.ctx, "call:uncertain", "Uncertain", f.s, ambiguous, f.pause);
    assert.equal(attempts, 1);

    let rateAttempts = 0;
    const rateLimited = async () => {
      if (++rateAttempts === 1) throw new TelegramError("Flood wait", false, 2);

      return { message_id: 99 };
    };

    await sendActivity(f.ctx, "call:flood", "Rate limited", f.s, rateLimited, f.pause);
    assert.equal(rateAttempts, 2);
    assert.ok(f.pauses.includes(2000));
  } finally {
    f.clean();
  }
});

test("activity hook shows interim and final messages, nested tools, skills and task outcomes", async () => {
  const f = fixture();
  const deliver: typeof sendActivity = (ctx, id, text) =>
    sendActivity(ctx, id, text, f.s, f.send, f.pause);
  const hook = activityHook(deliver);

  try {
    const common = { turnId: "turn", stepIndex: 0, sequence: 1 };

    for (const finishReason of ["tool-calls", "stop"] as const)
      await hook.events!["message.completed"]!(
        {
          type: "message.completed",
          data: {
            ...common,
            message: finishReason === "stop" ? "Answer" : "Checking sources",
            finishReason,
          },
          meta: { id: finishReason, at: "" },
        },
        f.ctx,
      );

    await hook.events!["actions.requested"]!(
      {
        type: "actions.requested",
        data: {
          ...common,
          actions: [
            {
              kind: "tool-call",
              callId: "fetch",
              toolName: "fetch",
              parentCallId: "connection",
              input: { url: "https://example.com" },
            },
            { kind: "load-skill", callId: "skill", input: { name: "news" } },
          ],
        },
        meta: { id: "actions", at: "" },
      },
      f.ctx,
    );
    await hook.events!["action.result"]!(
      {
        type: "action.result",
        data: {
          ...common,
          result: { kind: "tool-result", callId: "fetch", toolName: "fetch", output: null },
          status: "failed",
          error: { code: "offline", message: "Network unavailable" },
        },
        meta: { id: "result", at: "" },
      },
      f.ctx,
    );

    const texts = f.calls.map((call) => call.body.text);

    assert.ok(texts.includes("Checking sources"));
    assert.ok(texts.includes("Answer"));
    assert.ok(texts.some((text) => text.includes("fetch") && text.includes("https://example.com")));
    assert.ok(texts.some((text) => text.includes("load-skill") && text.includes("news")));
    assert.ok(
      texts.some((text) => text.includes("failed") && text.includes("Network unavailable")),
    );
  } finally {
    f.clean();
  }
});
