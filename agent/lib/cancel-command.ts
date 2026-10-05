import { ownerUpdate } from "./security";
import { store, type Store } from "./store";
import { notify } from "./telegram";

export const chatTurnKey = "telegram.chat.currentTurn";

type Target = { sessionId: string; turnId: string };

type Cancel = (target: Target) => Promise<{ status: string }>;

export async function handleCancelCommand(
  update: any,
  cancel: Cancel,
  s: Store = store(),
  reply: (text: string, key: string) => Promise<unknown> = notify,
) {
  if (!ownerUpdate(update) || !/^\/cancel(?:@\w+)?\s*$/i.test(update.message?.text ?? ""))
    return false;

  const key = `telegram.cancel:${update.update_id}`;
  let command = s.get<{ target: Target | null; result?: string } | null>(key, null);

  if (!command) {
    command = { target: s.get<Target | null>(chatTurnKey, null) };
    s.set(key, command);
  }

  if (!command.result) {
    const result = command.target ? await cancel(command.target) : { status: "no_active_turn" };

    command.result =
      result.status === "accepted" ? "Stopping current task." : "No active task to cancel.";
    s.set(key, command);

    if (result.status === "accepted" && command.target) {
      s.transaction(() => {
        const typing = s.get<Record<string, string>>("telegram.typing.active", {});

        if (typing[command.target!.sessionId] === command.target!.turnId)
          delete typing[command.target!.sessionId];

        s.set("telegram.typing.active", typing);
      });
    }
  }

  await reply(command.result, key);

  return true;
}
