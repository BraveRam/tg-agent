import type { HookContext } from "eve/hooks";

import { config } from "./config";
import { requireOwner } from "./security";
import { store, type Store } from "./store";
import { bot, TelegramError } from "./telegram";
import { chatSessionKey, chatTurnKey } from "./cancel-command";

const key = "telegram.typing.active";

export function recordTyping(
  event: { type: string; data?: any; meta: { id?: string } },
  ctx: HookContext,
  s: Store = store(),
) {
  try {
    requireOwner(ctx);
  } catch {
    return;
  }

  if (ctx.session.parent || (ctx.agent.nodeId && ctx.agent.nodeId !== "root")) return;

  const auth = ctx.session.auth.current;
  const turnId = event.data?.turnId;

  const start = ["turn.started", "step.started"].includes(event.type);
  const stop =
    [
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "session.waiting",
      "session.failed",
      "session.completed",
    ].includes(event.type) ||
    (event.type === "turn.waiting" && event.data?.on === "input");

  if (!start && !stop) return;

  s.transaction(() => {
    const marker = event.meta.id ? "telegram.typing.event:" + event.meta.id : null;

    if (marker && s.get(marker, false)) return;

    if (
      auth?.attributes?.privateChat === "true" &&
      !auth.attributes.runId &&
      !auth.attributes.jobId
    ) {
      if (["turn.started", "step.started"].includes(event.type) && turnId)
        s.set(chatTurnKey, { sessionId: ctx.session.id, turnId });
      else if (
        [
          "turn.completed",
          "turn.failed",
          "turn.cancelled",
          "session.completed",
          "session.failed",
        ].includes(event.type)
      ) {
        const current = s.get<any>(chatTurnKey, null);

        if (current?.sessionId === ctx.session.id && (!turnId || current.turnId === turnId))
          s.set(chatTurnKey, null);
      }

      if (["turn.started", "step.started"].includes(event.type))
        s.set(chatSessionKey, ctx.session.id);
    }

    const active = s.get<Record<string, string>>(key, {});

    if (start && turnId) active[ctx.session.id] = turnId;
    else if (!turnId || active[ctx.session.id] === turnId) delete active[ctx.session.id];

    s.set(key, active);

    if (marker) s.set(marker, true);
  });
}

function removeInactiveJobTyping(s: Store, now: number) {
  const active = s.get<Record<string, string>>(key, {});
  let changed = false;

  for (const sessionId of Object.keys(active)) {
    const run = s.db
      .prepare("SELECT status,lease_until FROM runs WHERE session_id=?")
      .get(sessionId) as { status: string; lease_until: number } | undefined;

    if (run && (!(run.status === "claimed" || run.status === "running") || run.lease_until < now)) {
      delete active[sessionId];
      changed = true;
    }
  }

  if (changed) s.set(key, active);

  return active;
}

export async function refreshTyping(
  s: Store = store(),
  send: (method: string, body: unknown) => Promise<unknown> = bot,
  now = Date.now(),
) {
  const active = removeInactiveJobTyping(s, now);

  if (!config().ownerId || !Object.keys(active).length || s.get("telegram.typing.retryAt", 0) > now)
    return;

  try {
    await send("sendChatAction", { chat_id: config().ownerId, action: "typing" });
  } catch (error) {
    // Typing is best effort; it must never interrupt model work or duplicate a message.
    if (error instanceof TelegramError && error.retryAfter)
      s.set("telegram.typing.retryAt", now + error.retryAfter * 1000);
  }
}
