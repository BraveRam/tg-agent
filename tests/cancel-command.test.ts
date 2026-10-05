import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatTurnKey, handleCancelCommand } from "../agent/lib/cancel-command";
import { recordTyping } from "../agent/lib/typing";
import { Store } from "../agent/lib/store";

test("cancel is owner-only, guarded to the recorded turn, replay-safe, and preserves jobs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-cancel-"));
  const s = new Store(dir);
  const oldOwner = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "123";

  const target = { sessionId: "owner-chat", turnId: "turn-1" };
  const update = {
    update_id: 1,
    message: { text: "/cancel", from: { id: 123 }, chat: { id: 123, type: "private" } },
  };
  const calls: unknown[] = [];
  const replies: string[] = [];
  const cancel = async (value: unknown) => {
    calls.push(value);

    return { status: "accepted" };
  };
  const reply = async (text: string) => {
    replies.push(text);
  };

  try {
    s.set(chatTurnKey, target);
    s.set("telegram.typing.active", { "owner-chat": "turn-1", background: "job-turn" });
    assert.equal(
      await handleCancelCommand(
        { ...update, message: { ...update.message, from: { id: 456 } } },
        cancel,
        s,
        reply,
      ),
      false,
    );
    assert.equal(
      await handleCancelCommand(
        { ...update, message: { ...update.message, text: "please /cancel" } },
        cancel,
        s,
        reply,
      ),
      false,
    );
    assert.equal(calls.length, 0);
    assert.equal(await handleCancelCommand(update, cancel, s, reply), true);
    assert.deepEqual(calls, [target]);
    assert.deepEqual(s.get("telegram.typing.active", {}), { background: "job-turn" });
    assert.equal(replies[0], "Cancellation requested. The task may take a moment to stop.");
    s.set(chatTurnKey, { sessionId: "owner-chat", turnId: "turn-2" });
    await handleCancelCommand(update, cancel, s, reply);
    assert.equal(calls.length, 1);
    s.set(chatTurnKey, null);
    await handleCancelCommand({ ...update, update_id: 2 }, cancel, s, reply);
    assert.equal(
      replies.at(-1),
      "No active task in this private chat. /cancel does not control scheduled jobs.",
    );
    assert.equal(calls.length, 1);
  } finally {
    s.close();

    if (oldOwner === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = oldOwner;

    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel target survives input waiting and ignores scheduled, specialist, and old turn completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-cancel-turn-"));
  const s = new Store(dir);
  const oldOwner = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "123";

  const ctx: any = {
    session: {
      id: "owner-chat",
      auth: {
        current: {
          authenticator: "telegram",
          principalType: "user",
          principalId: "123",
          attributes: { privateChat: "true" },
        },
      },
    },
    agent: { nodeId: "root" },
  };
  let next = 0;
  const event = (type: string, turnId = "turn-1", extra = {}) => ({
    type,
    data: { turnId, ...extra },
    meta: { id: String(next++) },
  });

  try {
    recordTyping(event("turn.started"), ctx, s);
    recordTyping(event("turn.waiting", "turn-1", { on: "input" }), ctx, s);
    assert.deepEqual(s.get(chatTurnKey, null), { sessionId: "owner-chat", turnId: "turn-1" });
    recordTyping(
      event("turn.started", "background"),
      {
        ...ctx,
        session: {
          ...ctx.session,
          id: "job",
          auth: {
            current: {
              ...ctx.session.auth.current,
              attributes: { privateChat: "true", runId: "run" },
            },
          },
        },
      },
      s,
    );
    recordTyping(
      event("turn.started", "child"),
      { ...ctx, session: { ...ctx.session, parent: "owner-chat" } },
      s,
    );
    recordTyping(event("turn.completed", "old-turn"), ctx, s);
    assert.deepEqual(s.get(chatTurnKey, null), { sessionId: "owner-chat", turnId: "turn-1" });
    recordTyping(event("turn.cancelled"), ctx, s);
    assert.equal(s.get(chatTurnKey, null), null);
  } finally {
    s.close();

    if (oldOwner === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = oldOwner;

    rmSync(dir, { recursive: true, force: true });
  }
});
