import { chatSessionKey } from "./cancel-command";
import { ownerUpdate } from "./security";
import { store, type Store } from "./store";
import { notify } from "./telegram";

type Compact = (sessionId: string) => Promise<{ status: "accepted" | "no_active_session" }>;

export async function handleCompactCommand(
  update: any,
  compact: Compact,
  s: Store = store(),
  reply: (text: string, key: string) => Promise<unknown> = notify,
) {
  if (!ownerUpdate(update) || !/^\/compact(?:@\w+)?\s*$/i.test(update.message?.text ?? ""))
    return false;

  const key = `telegram.compact:${update.update_id}`;
  let command = s.get<{ sessionId: string | null; result?: string } | null>(key, null);

  if (!command) {
    command = { sessionId: s.get<string | null>(chatSessionKey, null) };
    s.set(key, command);
  }

  if (!command.result) {
    const result = command.sessionId
      ? await compact(command.sessionId)
      : { status: "no_active_session" };

    command.result =
      result.status === "accepted"
        ? "Context compaction requested. It runs after the current task settles, if one is active."
        : "No active chat to compact. Send a message first.";
    s.set(key, command);
  }

  await reply(command.result, key);

  return true;
}
