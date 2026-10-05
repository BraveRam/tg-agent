import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordTyping, refreshTyping } from "../agent/lib/typing";
import { Store } from "../agent/lib/store";
import { TelegramError } from "../agent/lib/telegram";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tg-typing-"));
  const s = new Store(dir);
  const owner = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "12345";

  const ctx: any = {
    session: {
      id: "owner",
      auth: {
        current: {
          authenticator: "telegram",
          principalType: "user",
          principalId: "12345",
          attributes: { privateChat: "true" },
        },
      },
    },
    agent: { nodeId: "root" },
  };
  let next = 0;
  const event = (type: string, turnId = "turn", extra = {}) => ({
    type,
    data: { turnId, ...extra },
    meta: { id: String(next++) },
  });

  return {
    dir,
    s,
    ctx,
    event,

    cleanup() {
      s.close();

      if (owner === undefined) delete process.env.TELEGRAM_OWNER_ID;
      else process.env.TELEGRAM_OWNER_ID = owner;

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("typing persists across long tools and restart, pauses for input, and ends with the turn", async () => {
  const f = fixture();
  const calls: unknown[] = [];
  const send = async (method: string, body: unknown) => {
    assert.equal(method, "sendChatAction");
    calls.push(body);
  };

  try {
    const start = f.event("turn.started");

    recordTyping(start, f.ctx, f.s);
    await refreshTyping(f.s, send, 0);
    await refreshTyping(f.s, send, 3000);
    await refreshTyping(f.s, send, 6000);
    recordTyping(f.event("turn.waiting", "turn", { on: "tasks" }), f.ctx, f.s);

    const reopened = new Store(f.dir);

    try {
      await refreshTyping(reopened, send, 9000);
      recordTyping(f.event("turn.waiting", "turn", { on: "input" }), f.ctx, reopened);
      await refreshTyping(reopened, send, 12000);
      assert.equal(calls.length, 4);
      recordTyping(f.event("step.started"), f.ctx, reopened);
      await refreshTyping(reopened, send, 15000);
      assert.equal(calls.length, 5);
      recordTyping(f.event("turn.completed"), f.ctx, reopened);
      recordTyping(start, f.ctx, reopened);
      await refreshTyping(reopened, send, 18000);
      assert.equal(calls.length, 5);
      assert.ok(
        calls.every(
          (body) => JSON.stringify(body) === JSON.stringify({ chat_id: "12345", action: "typing" }),
        ),
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
});

test("typing rejects unauthorized and child sessions and survives overlapping work", async () => {
  const f = fixture();
  let calls = 0;
  const send = async () => {
    calls++;
  };

  try {
    recordTyping(
      f.event("turn.started"),
      { ...f.ctx, session: { ...f.ctx.session, auth: { current: null } } },
      f.s,
    );
    recordTyping(f.event("turn.started"), { ...f.ctx, agent: { nodeId: "research" } }, f.s);
    await refreshTyping(f.s, send);
    assert.equal(calls, 0);
    recordTyping(f.event("turn.started", "old"), f.ctx, f.s);
    recordTyping(f.event("turn.started", "new"), f.ctx, f.s);
    recordTyping(f.event("turn.cancelled", "old"), f.ctx, f.s);
    await refreshTyping(f.s, send);
    assert.equal(calls, 1);

    const other = { ...f.ctx, session: { ...f.ctx.session, id: "other" } };

    recordTyping(f.event("turn.started"), other, f.s);
    recordTyping(f.event("turn.failed", "new"), f.ctx, f.s);
    await refreshTyping(f.s, send);
    assert.equal(calls, 2);
    recordTyping(f.event("session.failed"), other, f.s);
    await refreshTyping(f.s, send);
    assert.equal(calls, 2);
  } finally {
    f.cleanup();
  }
});

test("typing failures are harmless and honor Telegram flood waits", async () => {
  const f = fixture();
  let attempts = 0;

  try {
    recordTyping(f.event("turn.started"), f.ctx, f.s);

    const send = async () => {
      attempts++;
      throw new TelegramError("Flood wait", false, 10);
    };

    await refreshTyping(f.s, send, 1000);
    await refreshTyping(f.s, send, 4000);
    assert.equal(attempts, 1);
    await refreshTyping(f.s, send, 11000);
    assert.equal(attempts, 2);
    recordTyping(f.event("turn.cancelled"), f.ctx, f.s);
    await refreshTyping(f.s, send, 50000);
    assert.equal(attempts, 2);
  } finally {
    f.cleanup();
  }
});
