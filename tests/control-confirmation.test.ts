import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../agent/lib/store";
import { chatTurnKey, chatSessionKey } from "../agent/lib/cancel-command";
import { handleControlConfirmation } from "../agent/lib/control-confirmation";

test("control confirmations require the owner, reject stale targets, and execute once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-confirm-"));
  const s = new Store(dir);
  const oldOwner = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "123";

  const chat = { id: 123, type: "private" };
  const command = (id: number, action: string) => ({
    update_id: id,
    message: { text: "/" + action, from: { id: 123 }, chat },
  });
  const click = (id: number, choice = "yes", owner = 123) => ({
    callback_query: {
      id: "q" + id,
      data: `control:${id}:${choice}`,
      from: { id: owner },
      message: { message_id: 99, chat },
    },
  });
  const executed: any[] = [];
  const calls: any[] = [];
  const execute = async (update: any) => {
    executed.push(update);
  };
  const send = async (method: string, body: any) => {
    calls.push({ method, body });
  };

  try {
    s.set(chatTurnKey, { sessionId: "chat", turnId: "one" });
    s.set(chatSessionKey, "chat");
    await handleControlConfirmation(command(1, "cancel"), execute, s, send);
    assert.equal(executed.length, 0);
    assert.equal(calls[0].body.reply_markup.inline_keyboard[0].length, 2);
    assert.equal(await handleControlConfirmation(click(1, "yes", 999), execute, s, send), false);
    await handleControlConfirmation(click(1), execute, s, send);
    await handleControlConfirmation(click(1), execute, s, send);
    assert.equal(executed.length, 1);
    await handleControlConfirmation(command(2, "reset"), execute, s, send);
    await handleControlConfirmation(click(2, "no"), execute, s, send);
    assert.equal(executed.length, 1);
    await handleControlConfirmation(command(3, "cancel"), execute, s, send);
    s.set(chatTurnKey, { sessionId: "chat", turnId: "two" });
    await handleControlConfirmation(click(3), execute, s, send);
    assert.equal(executed.length, 1);
    await handleControlConfirmation(command(4, "reset"), execute, s, send);

    const pending = s.get<any>("telegram.confirm:4", null);

    s.set("telegram.confirm:4", { ...pending, expires: 0 });
    await handleControlConfirmation(click(4), execute, s, send);
    assert.equal(executed.length, 1);
    await handleControlConfirmation(command(5, "reset"), execute, s, send);
    await handleControlConfirmation(click(5), execute, s, send);
    assert.equal(executed.length, 2);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });

    if (oldOwner === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = oldOwner;
  }
});
