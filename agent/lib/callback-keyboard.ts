import { config } from "./config";
import { ownerUpdate } from "./security";
import { store, type Store } from "./store";
import { bot, TelegramError } from "./telegram";

const prefix = "telegram.callbackKeyboard:";

interface Cleanup {
  chatId: string;
  messageId: number;
  status: "pending" | "done" | "failed";
  attempts: number;
  retryAt: number;
}

export function queueCallbackKeyboardRemoval(update: any, s: Store = store()) {
  const query = update.callback_query;
  const messageId = query?.message?.message_id;

  if (
    !ownerUpdate({ callback_query: query }) ||
    typeof query?.id !== "string" ||
    typeof query?.data !== "string" ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0
  )
    return;

  const key = prefix + query.id;

  if (s.get(key, null)) return;

  s.set(key, {
    chatId: String(query.message.chat.id),
    messageId,
    status: "pending",
    attempts: 0,
    retryAt: 0,
  } satisfies Cleanup);
}

export async function clearCallbackKeyboards(
  s: Store = store(),
  send: (method: string, body: unknown) => Promise<unknown> = bot,
  now = Date.now(),
) {
  const pending = s.db
    .prepare(
      "SELECT key,value FROM kv WHERE key LIKE ? AND json_extract(value,'$.status')='pending' LIMIT 20",
    )
    .all(prefix + "%") as { key: string; value: string }[];

  for (const row of pending) {
    const cleanup: Cleanup = JSON.parse(row.value);

    if (cleanup.retryAt > now) continue;

    if (cleanup.chatId !== config().ownerId) {
      s.set(row.key, { ...cleanup, status: "failed" });
      continue;
    }

    try {
      await send("editMessageReplyMarkup", {
        chat_id: cleanup.chatId,
        message_id: cleanup.messageId,
        reply_markup: { inline_keyboard: [] },
      });
      s.set(row.key, { ...cleanup, status: "done" });
    } catch (error) {
      // Clearing markup is idempotent, including after an accepted edit loses its acknowledgment.
      if (error instanceof TelegramError && /message is not modified/i.test(error.message)) {
        s.set(row.key, { ...cleanup, status: "done" });
        continue;
      }

      const attempts = cleanup.attempts + 1;

      s.set(row.key, {
        ...cleanup,
        attempts,
        status: attempts >= 5 ? "failed" : "pending",
        retryAt:
          now +
          Math.max(
            error instanceof TelegramError ? error.retryAfter * 1000 : 0,
            Math.min(60000, 1000 * 2 ** attempts),
          ),
      });
    }
  }
}
