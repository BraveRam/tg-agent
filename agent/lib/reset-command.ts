import { chatSessionKey, chatTurnKey } from "./cancel-command";
import { ownerUpdate } from "./security";
import { store, type Store } from "./store";
import { notify } from "./telegram";

type ResetResult = { status: "reset" | "no_active_session" };

type Reset = (sessionId: string) => Promise<ResetResult>;

export async function handleResetCommand(
  update: any,
  reset: Reset,
  s: Store = store(),
  reply: (text: string, key: string) => Promise<unknown> = notify,
) {
  if (!ownerUpdate(update) || !/^\/reset(?:@\w+)?\s*$/i.test(update.message?.text ?? ""))
    return false;

  const key = `telegram.reset:${update.update_id}`;
  let command = s.get<{ sessionId: string | null; result?: string } | null>(key, null);

  if (!command) {
    command = { sessionId: s.get<string | null>(chatSessionKey, null) };
    s.set(key, command);
  }

  if (!command.result) {
    if (!command.sessionId) command.result = "No chat session to reset yet.";
    else {
      const result = await reset(command.sessionId);

      command.result = "Chat reset. Send a message to start fresh.";
      s.set(key, command);

      if (result.status === "reset" || result.status === "no_active_session") {
        s.transaction(() => {
          if (s.get(chatSessionKey, null) === command.sessionId) s.set(chatSessionKey, null);

          const turn = s.get<{ sessionId: string; turnId: string } | null>(chatTurnKey, null);

          if (turn?.sessionId === command.sessionId) s.set(chatTurnKey, null);

          const typing = s.get<Record<string, string>>("telegram.typing.active", {});

          delete typing[command.sessionId!];
          s.set("telegram.typing.active", typing);
        });
      }
    }
  }

  s.set(key, command);
  await reply(command.result, key);

  return true;
}
