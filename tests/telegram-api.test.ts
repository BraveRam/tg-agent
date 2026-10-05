import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeTelegramApi, type ApiTransport } from "../agent/lib/telegram-api";
import { ownerJoinReferences } from "../agent/lib/source-authorization";
import { Store } from "../agent/lib/store";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tg-api-"));
  const s = new Store(dir);
  const owner = process.env.TELEGRAM_OWNER_ID,
    token = process.env.TELEGRAM_BOT_TOKEN;

  process.env.TELEGRAM_OWNER_ID = "12345";
  process.env.TELEGRAM_BOT_TOKEN = "test-credential";
  s.saveChannel({
    chatId: "-1001",
    name: "Test",
    language: "en",
    style: "Brief",
    timezone: "Africa/Nairobi",
    images: "never",
  });
  s.saveSource({ reference: "@source", chatId: "-1002" });

  const ctx: any = {
    session: {
      id: "api",
      auth: {
        current: {
          authenticator: "telegram",
          principalType: "user",
          principalId: "12345",
          attributes: { privateChat: "true" },
        },
      },
    },
    channel: { kind: "telegram" },
    callId: "call",
    getSandbox: async () => ({
      readBinaryFile: async () => Buffer.from("file bytes"),
      writeBinaryFile: async () => {},
    }),
  };

  return {
    s,
    ctx,

    cleanup() {
      s.close();

      if (owner === undefined) delete process.env.TELEGRAM_OWNER_ID;
      else process.env.TELEGRAM_OWNER_ID = owner;

      if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = token;

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("generic API enforces private ownership, runtime protection, nested targets and replay", async () => {
  const f = fixture();
  let calls = 0;
  const transport: ApiTransport = async () => {
    calls++;

    return Response.json({ ok: true, result: { message_id: 7, text: "test-credential" } });
  };

  try {
    const input = {
      method: "sendPoll",
      params: { chat_id: "-1001", question: "Test?", options: [{ text: "Yes" }, { text: "No" }] },
    };
    const result = await executeTelegramApi(input, f.ctx, f.s, transport);

    assert.equal(result.status, "sent");
    assert.equal(result.result.text, "[redacted]");
    await executeTelegramApi(input, f.ctx, f.s, transport);
    assert.equal(calls, 1);
    await assert.rejects(
      executeTelegramApi(
        input,
        {
          ...f.ctx,
          session: {
            ...f.ctx.session,
            auth: {
              current: { ...f.ctx.session.auth.current, attributes: { privateChat: "false" } },
            },
          },
        },
        f.s,
        transport,
      ),
      /private/,
    );
    await assert.rejects(
      executeTelegramApi(
        input,
        {
          ...f.ctx,
          session: {
            ...f.ctx.session,
            auth: { current: { ...f.ctx.session.auth.current, attributes: { runId: "run" } } },
          },
        },
        f.s,
        transport,
      ),
      /Scheduled/,
    );
    await assert.rejects(
      executeTelegramApi({ method: "setWebhook", params: {} }, f.ctx, f.s, transport),
      /application-owned/,
    );
    await assert.rejects(
      executeTelegramApi({ method: "madeUpMethod", params: {} }, f.ctx, f.s, transport),
      /Unknown/,
    );
    await assert.rejects(
      executeTelegramApi(
        { method: "sendMessage", params: { chat_id: "999", text: "No" } },
        f.ctx,
        f.s,
        transport,
      ),
      /not registered/,
    );
    await assert.rejects(
      executeTelegramApi(
        {
          method: "setMyCommands",
          params: { commands: [], scope: { type: "chat", chat_id: "999" } },
        },
        f.ctx,
        f.s,
        transport,
      ),
      /not registered/,
    );
    await assert.rejects(
      executeTelegramApi(
        { method: "editMessageText", params: { inline_message_id: "opaque", text: "No" } },
        f.ctx,
        f.s,
        transport,
      ),
      /Indirect/,
    );
    await assert.rejects(
      executeTelegramApi(
        {
          method: "setMyCommands",
          params: { commands: [], scope: JSON.stringify({ type: "chat", chat_id: "999" }) },
        },
        f.ctx,
        f.s,
        transport,
      ),
      /not registered/,
    );
    await assert.rejects(
      executeTelegramApi(
        { method: "getUserProfilePhotos", params: { user_id: 999 } },
        f.ctx,
        f.s,
        transport,
      ),
      /Unscoped/,
    );
    assert.equal(calls, 1);
  } finally {
    f.cleanup();
  }
});

test("generic API uploads albums and thumbnails, downloads privately, and preserves ambiguous mutations", async () => {
  const f = fixture();

  try {
    const transport: ApiTransport = async (_url, init) => {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("chat_id"), "-1001");
      assert.equal(await (init.body.get("image") as File).text(), "file bytes");
      assert.equal(await (init.body.get("thumb") as File).text(), "file bytes");

      return Response.json({ ok: true, result: [{ message_id: 8 }] });
    };
    const input = {
      method: "sendMediaGroup",
      params: {
        chat_id: "-1001",
        media: [{ type: "video", media: "attach://image", thumbnail: "attach://thumb" }],
      },
      files: { image: { path: "image.png" }, thumb: { path: "thumb.jpg" } },
    };

    assert.equal((await executeTelegramApi(input, f.ctx, f.s, transport)).status, "sent");

    let written: any;
    const ctx = {
      ...f.ctx,
      callId: "download",
      getSandbox: async () => ({
        writeBinaryFile: async (options: any) => {
          written = options;
        },
      }),
    };
    const download: ApiTransport = async (url) =>
      String(url).includes("/getFile")
        ? Response.json({ ok: true, result: { file_path: "documents/file.bin" } })
        : new Response("download bytes");

    const result = await executeTelegramApi(
      { method: "getFile", params: { file_id: "file" }, downloadTo: "download.bin" },
      ctx,
      f.s,
      download,
    );

    assert.equal(result.result.sandboxPath, "download.bin");
    assert.equal(Buffer.from(written.content).toString(), "download bytes");
    assert.ok(!JSON.stringify(result).includes("test-credential"));

    let attempts = 0;
    const failed: ApiTransport = async () => {
      attempts++;
      throw new Error("test-credential leaked transport error");
    };
    const mutation = { method: "sendMessage", params: { chat_id: "12345", text: "Test" } };
    const uncertainCtx = { ...f.ctx, callId: "uncertain" };

    assert.equal(
      (await executeTelegramApi(mutation, uncertainCtx, f.s, failed)).status,
      "uncertain",
    );
    await executeTelegramApi(mutation, uncertainCtx, f.s, failed);
    assert.equal(attempts, 1);

    const flood: ApiTransport = async () =>
      new Response(
        JSON.stringify({ ok: false, description: "Flood wait", parameters: { retry_after: 10 } }),
        { status: 429 },
      );
    const rateCtx = { ...f.ctx, callId: "rate" };
    const rate = await executeTelegramApi(mutation, rateCtx, f.s, flood);

    assert.equal(rate.status, "failed");
    assert.equal(rate.errorCode, 429);
    assert.deepEqual(rate.parameters, { retry_after: 10 });
    assert.equal(rate.retryAfter, 10);
    assert.equal((await executeTelegramApi(mutation, rateCtx, f.s, failed)).status, "failed");
    assert.equal(attempts, 1);
  } finally {
    f.cleanup();
  }
});

test("event batches are fixed, persistent, isolated and retry without losing later updates", () => {
  const f = fixture();

  try {
    const channel = f.s.channels()[0];

    f.s.source("@source", [{ id: 1, text: "Bootstrap" }], 1, true);

    const job = f.s.saveJob({
      channelId: channel.id,
      name: "Live",
      task: "News",
      sources: [{ kind: "telegram", reference: "@source", trust: "verify" }],
      trigger: "source_updates",
      schedule: { kind: "interval", minutes: 5 },
      freshnessHours: 24,
    });
    const now = Date.now();

    f.s.source("@source", [{ id: 2, text: "Fresh" }]);
    f.s.source("@source", [{ id: 2, text: "Fresh" }]);
    assert.equal((f.s.db.prepare("SELECT COUNT(*) AS n FROM source_updates").get() as any).n, 1);
    assert.equal(f.s.claimEventJobs(now + 1000).length, 0);
    assert.equal(f.s.claimDue(now + 999999).length, 0);

    const first = f.s.claimEventJobs(now + 16000)[0];

    assert.ok(first);
    assert.equal(f.s.claimEventJobs(now + 17000).length, 0);
    f.s.source("@source", [{ id: 3, text: "Later" }]);
    f.s.runState(first.id, "failed");
    assert.equal(f.s.get("job.eventCursor:" + job.id, 0), 0);
    f.s.set("job.eventRetryAt:" + job.id, 0);

    const retry = f.s.claimEventJobs(now + 32000)[0];

    assert.notEqual(retry.id, first.id);
    assert.equal(f.s.get<any[]>("run.eventMessages:" + retry.id, []).length, 2);
    f.s.runState(retry.id, "completed");
    assert.equal(f.s.claimEventJobs(now + 60000).length, 0);
    f.s.enableJob(job.id, false);
    f.s.source("@source", [{ id: 4, text: "Paused" }]);
    assert.equal(f.s.claimEventJobs(now + 60000).length, 0);
    f.s.enableJob(job.id, true);
    assert.equal(f.s.claimEventJobs(now + 60000).length, 1);
  } finally {
    f.cleanup();
  }
});

test("channel join grants come only from explicit owner text naming the source", () => {
  assert.deepEqual(ownerJoinReferences("Monitor https://t.me/SourceNews"), ["@sourcenews"]);
  assert.deepEqual(ownerJoinReferences("Join https://t.me/+InviteHash"), [
    "https://t.me/+InviteHash",
  ]);
  assert.deepEqual(ownerJoinReferences("Research news using @source"), []);
  assert.deepEqual(ownerJoinReferences("Stop monitoring @source"), []);
  assert.deepEqual(ownerJoinReferences("Join @source", true), []);
});

test("Telegram rejects parameters directly and corrected calls retain replay protection", async () => {
  const f = fixture();
  let requests = 0;
  const invalid = {
    method: "sendPoll",
    params: {
      chat_id: "-1001",
      question: "Powerhouse of the cell?",
      type: "quiz",
      options: ["Ribosome", "Mitochondrion"],
      correct_option_id: 1,
    },
  };
  const transport: ApiTransport = async (_url, init) => {
    requests++;

    const params = JSON.parse(String(init?.body));

    if (requests === 1) {
      assert.deepEqual(params, invalid.params);

      return Response.json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse options: expected an Object; test-credential",
          parameters: { migrate_to_chat_id: -1001, token: "test-credential" },
        },
        { status: 400 },
      );
    }

    assert.deepEqual(params.correct_option_ids, [1]);
    assert.deepEqual(params.options, [{ text: "Ribosome" }, { text: "Mitochondrion" }]);

    return Response.json({ ok: true, result: { message_id: 91 } });
  };

  try {
    const failed = await executeTelegramApi(invalid, f.ctx, f.s, transport);

    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, 400);
    assert.equal(failed.error, "Bad Request: can't parse options: expected an Object; [redacted]");
    assert.deepEqual(failed.parameters, { migrate_to_chat_id: -1001, token: "[redacted]" });
    assert.equal(requests, 1);

    const corrected = {
      method: "sendPoll",
      params: {
        chat_id: "-1001",
        question: "Powerhouse of the cell?",
        type: "quiz",
        options: [{ text: "Ribosome" }, { text: "Mitochondrion" }],
        correct_option_ids: [1],
      },
    };
    const nextCall = { ...f.ctx, callId: "corrected" };

    assert.equal((await executeTelegramApi(corrected, nextCall, f.s, transport)).status, "sent");
    await executeTelegramApi(corrected, nextCall, f.s, transport);
    assert.equal(requests, 2);
  } finally {
    f.cleanup();
  }
});

test("new optional and nested parameters reach Telegram without a local schema", async () => {
  const f = fixture();
  const params = {
    chat_id: "-1001",
    text: "Hello",
    future_parameter: { future_nested_field: true },
  };

  try {
    const result = await executeTelegramApi(
      { method: "sendMessage", params },
      f.ctx,
      f.s,
      async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), params);

        return Response.json({ ok: true, result: { message_id: 92 } });
      },
    );

    assert.equal(result.status, "sent");
  } finally {
    f.cleanup();
  }
});
