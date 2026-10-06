import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../agent/lib/store";
import { chatSessionKey } from "../agent/lib/cancel-command";
import { handleCompactCommand } from "../agent/lib/compact-command";

test("compact targets the owner chat, suppresses replay, and handles inactive sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-compact-"));
  const s = new Store(dir);
  const previous = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "123";

  const update = {
    update_id: 1,
    message: {
      text: "/compact@mybot",
      from: { id: 123 },
      chat: { id: 123, type: "private" },
    },
  };
  const calls: string[] = [];
  const replies: string[] = [];
  const compact = async (sessionId: string) => {
    calls.push(sessionId);

    return { status: "accepted" as const };
  };
  const reply = async (text: string) => {
    replies.push(text);
  };

  try {
    s.set(chatSessionKey, "original");
    assert.equal(
      await handleCompactCommand(
        {
          ...update,
          message: {
            ...update.message,
            from: { id: 456 },
          },
        },
        compact,
        s,
        reply,
      ),
      false,
    );
    assert.equal(calls.length, 0);
    assert.equal(await handleCompactCommand(update, compact, s, reply), true);
    assert.match(replies[0], /requested/);
    s.set(chatSessionKey, "new-chat");
    await handleCompactCommand(update, compact, s, reply);
    assert.deepEqual(calls, ["original"]);
    assert.equal(replies[0], replies[1]);
    await handleCompactCommand(
      { ...update, update_id: 2 },
      async () => ({ status: "no_active_session" }),
      s,
      reply,
    );
    assert.match(replies.at(-1)!, /No active chat/);
    s.set(chatSessionKey, null);
    await handleCompactCommand({ ...update, update_id: 3 }, compact, s, reply);
    assert.deepEqual(calls, ["original"]);
    assert.match(replies.at(-1)!, /No active chat/);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });

    if (previous === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = previous;
  }
});
