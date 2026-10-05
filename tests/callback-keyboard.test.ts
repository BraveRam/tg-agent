import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearCallbackKeyboards,
  queueCallbackKeyboardRemoval,
} from "../agent/lib/callback-keyboard";
import { Store } from "../agent/lib/store";
import { TelegramError } from "../agent/lib/telegram";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tg-keyboard-"));
  const s = new Store(dir);
  const owner = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "12345";

  const update = {
    callback_query: {
      id: "selected",
      data: "eve:0",
      from: { id: 12345 },
      message: {
        message_id: 44,
        chat: { id: 12345, type: "private" },
        text: "Pick a post",
        reply_markup: { inline_keyboard: [[{ text: "Oromo post", callback_data: "eve:0" }]] },
      },
    },
  };

  return {
    dir,
    s,
    update,

    cleanup() {
      s.close();

      if (owner === undefined) delete process.env.TELEGRAM_OWNER_ID;
      else process.env.TELEGRAM_OWNER_ID = owner;

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("selected owner buttons are removed without changing prompt text or replaying the answer", async () => {
  const f = fixture();
  const requests: any[] = [];
  const send = async (method: string, body: unknown) => {
    requests.push({ method, body });
  };

  try {
    const original = structuredClone(f.update);

    queueCallbackKeyboardRemoval(
      { callback_query: { ...f.update.callback_query, from: { id: 999 } } },
      f.s,
    );
    queueCallbackKeyboardRemoval(
      {
        callback_query: {
          ...f.update.callback_query,
          message: { ...f.update.callback_query.message, chat: { id: 12345, type: "group" } },
        },
      },
      f.s,
    );
    queueCallbackKeyboardRemoval({ message: f.update.callback_query.message }, f.s);
    await clearCallbackKeyboards(f.s, send);
    assert.equal(requests.length, 0);
    queueCallbackKeyboardRemoval(f.update, f.s);
    await clearCallbackKeyboards(f.s, send);
    queueCallbackKeyboardRemoval(f.update, f.s);
    await clearCallbackKeyboards(f.s, send);
    assert.deepEqual(requests, [
      {
        method: "editMessageReplyMarkup",
        body: { chat_id: "12345", message_id: 44, reply_markup: { inline_keyboard: [] } },
      },
    ]);
    assert.deepEqual(f.update, original);
  } finally {
    f.cleanup();
  }
});

test("keyboard cleanup survives restart, handles lost acknowledgments and honors flood waits", async () => {
  const f = fixture();
  let attempts = 0;

  try {
    queueCallbackKeyboardRemoval(f.update, f.s);
    await clearCallbackKeyboards(
      f.s,
      async () => {
        attempts++;
        throw new TelegramError("Response lost", true);
      },
      1000,
    );

    const reopened = new Store(f.dir);

    try {
      const unchanged = async () => {
        attempts++;
        throw new TelegramError("Bad Request: message is not modified");
      };

      await clearCallbackKeyboards(reopened, unchanged, 2000);
      assert.equal(attempts, 1);
      await clearCallbackKeyboards(reopened, unchanged, 3000);
      await clearCallbackKeyboards(reopened, unchanged, 6000);
      assert.equal(attempts, 2);
      assert.equal(reopened.get<any>("telegram.callbackKeyboard:selected", null).status, "done");
      queueCallbackKeyboardRemoval(
        { callback_query: { ...f.update.callback_query, id: "another-selection" } },
        reopened,
      );

      const flood = async () => {
        attempts++;
        throw new TelegramError("Flood wait", false, 10);
      };

      await clearCallbackKeyboards(reopened, flood, 10000);
      await clearCallbackKeyboards(reopened, flood, 19000);
      assert.equal(attempts, 3);
      await clearCallbackKeyboards(
        reopened,
        async () => {
          attempts++;
        },
        20000,
      );
      assert.equal(attempts, 4);
      assert.equal(
        reopened.get<any>("telegram.callbackKeyboard:another-selection", null).status,
        "done",
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
});
