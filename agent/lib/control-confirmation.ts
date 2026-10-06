import { chatSessionKey, chatTurnKey } from "./cancel-command";
import { queueCallbackKeyboardRemoval } from "./callback-keyboard";
import { config } from "./config";
import { ownerUpdate } from "./security";
import { store, type Store } from "./store";
import { bot } from "./telegram";

type Confirmation = {
  action: "cancel" | "reset";
  update: any;
  target: unknown;
  expires: number;
  consumed: boolean;
};

export async function handleControlConfirmation(
  update: any,
  execute: (update: any) => Promise<unknown>,
  s: Store = store(),
  send: (method: string, body: unknown) => Promise<any> = bot,
) {
  if (!ownerUpdate(update)) return false;

  const command = /^\/(cancel|reset)(?:@\w+)?\s*$/i.exec(update.message?.text ?? "");

  if (command) {
    const action = command[1].toLowerCase() as Confirmation["action"];
    const key = `telegram.confirm:${update.update_id}`;

    if (s.get(key, null)) return true;

    const target = s.get(action === "cancel" ? chatTurnKey : chatSessionKey, null);

    if (!target) {
      await execute(update);

      return true;
    }

    s.set(key, { action, update, target, expires: Date.now() + 300000, consumed: false });
    await send("sendMessage", {
      chat_id: config().ownerId,
      text:
        action === "reset"
          ? "Reset this conversation? Its chat context will be cleared. Saved preferences and jobs are kept."
          : "Cancel the current task? Completed actions will remain. Scheduled jobs keep running.",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: action === "reset" ? "Confirm reset" : "Confirm cancel",
              callback_data: `control:${update.update_id}:yes`,
            },
            { text: "Keep it", callback_data: `control:${update.update_id}:no` },
          ],
        ],
      },
    });

    return true;
  }

  const query = update.callback_query;
  const match = /^control:(\d+):(yes|no)$/.exec(query?.data ?? "");

  if (!match) return false;

  queueCallbackKeyboardRemoval(update, s);

  const key = `telegram.confirm:${match[1]}`;
  const confirmation = s.get<Confirmation | null>(key, null);
  const valid = confirmation && !confirmation.consumed && confirmation.expires > Date.now();

  await send("answerCallbackQuery", {
    callback_query_id: query.id,
    text: valid
      ? match[2] === "yes"
        ? "Confirmed"
        : "Kept"
      : "This confirmation is no longer active.",
  });

  if (!valid) return true;

  confirmation.consumed = true;
  s.set(key, confirmation);

  const current = s.get(confirmation.action === "cancel" ? chatTurnKey : chatSessionKey, null);

  if (match[2] === "yes" && JSON.stringify(current) === JSON.stringify(confirmation.target))
    await execute(confirmation.update);

  await send("editMessageText", {
    chat_id: config().ownerId,
    message_id: query.message.message_id,
    text:
      match[2] === "no"
        ? "Kept. No changes made."
        : JSON.stringify(current) !== JSON.stringify(confirmation.target)
          ? "The active conversation or task changed. Send the command again."
          : "Confirmation accepted.",
    reply_markup: { inline_keyboard: [] },
  });

  return true;
}
