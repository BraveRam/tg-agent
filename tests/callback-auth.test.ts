import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  telegramChannel,
  renderTelegramInputRequest,
  resolveTelegramInputResponses,
} from "eve/channels/telegram";

import { ownerCallbackResponse } from "../agent/lib/callback-auth";
import { requireControl } from "../agent/lib/security";
import { sendActivity } from "../agent/lib/activity";
import { Store } from "../agent/lib/store";

test("native button response resumes with owner auth and delivers a reply without another message", async () => {
  const owner = process.env.TELEGRAM_OWNER_ID;
  const dir = mkdtempSync(join(tmpdir(), "tg-callback-auth-"));
  const s = new Store(dir);

  process.env.TELEGRAM_OWNER_ID = "12345";

  try {
    const state: any = {};
    const prompt = renderTelegramInputRequest(
      {
        requestId: "language",
        kind: "question",
        action: { callId: "ask-language", kind: "tool-call", toolName: "ask_question", input: {} },
        prompt: "Choose language",
        options: [{ id: "english", label: "English" }],
      },
      state,
    );
    const requests: any[] = [];
    let resumed = 0;
    const channel = telegramChannel({
      credentials: { botToken: "test-token", webhookSecretToken: "test-secret" },
      onInputResponse: (_ctx, query) => ownerCallbackResponse(query),
      api: {
        fetch: (async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));

          return new Response(JSON.stringify({ ok: true, result: true }));
        }) as typeof fetch,
      },
    });
    const waits: Promise<unknown>[] = [];
    const context: any = {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      from: () => ({
        respond: async (responses: any[], delivery: any) => {
          const resolved = resolveTelegramInputResponses(state, responses);

          assert.deepEqual(resolved, [{ requestId: "language", optionId: "english" }]);

          const ctx: any = {
            session: { id: "callback-session", auth: { current: delivery.auth } },
            agent: { nodeId: "root" },
          };

          assert.equal(requireControl(ctx).principalId, "12345");
          await sendActivity(
            ctx,
            "callback-reply",
            "You chose English.",
            s,
            async (method, body) => {
              requests.push({ method, body });

              return { message_id: 45 };
            },
            async () => {},
          );
          resumed++;
        },
      }),
    };
    const callback = {
      callback_query: {
        id: "selected",
        data: (prompt.replyMarkup as any).inline_keyboard[0][0].callback_data,
        from: { id: 12345, is_bot: false },
        message: { message_id: 44, chat: { id: 12345, type: "private" } },
      },
    };
    const response = await (channel.routes[0] as any).handler(
      new Request("http://localhost/eve/v1/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
        body: JSON.stringify(callback),
      }),
      context,
    );

    assert.equal(response.status, 200);
    await Promise.all(waits);
    assert.equal(resumed, 1);
    assert.ok(
      requests.some((r) => r.method === "sendMessage" && r.body.text === "You chose English."),
    );

    waits.length = 0;
    callback.callback_query.from.id = 999;
    await (channel.routes[0] as any).handler(
      new Request("http://localhost/eve/v1/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
        body: JSON.stringify(callback),
      }),
      context,
    );
    await Promise.all(waits);
    assert.equal(resumed, 1);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });

    if (owner === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = owner;
  }
});

test("button auth rejects other users, chats and bot actors without inheriting join authority", () => {
  const owner = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "12345";

  try {
    const query: any = {
      from: { id: "12345" },
      message: { chat: { id: "12345", type: "private" } },
    };

    assert.equal(ownerCallbackResponse(query)?.auth.principalId, "12345");
    assert.deepEqual(ownerCallbackResponse(query)?.auth.attributes, { privateChat: "true" });
    assert.equal(ownerCallbackResponse({ ...query, from: { id: "999" } }), null);
    assert.equal(ownerCallbackResponse({ ...query, from: { id: "12345", isBot: true } }), null);
    assert.equal(ownerCallbackResponse({ ...query, message: undefined }), null);
    assert.equal(
      ownerCallbackResponse({ ...query, message: { chat: { id: "999", type: "private" } } }),
      null,
    );
    assert.equal(
      ownerCallbackResponse({ ...query, message: { chat: { id: "12345", type: "group" } } }),
      null,
    );
  } finally {
    if (owner === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = owner;
  }
});
