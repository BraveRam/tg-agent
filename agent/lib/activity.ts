import { createHash } from "node:crypto";

import type { HookContext } from "eve/hooks";

import { config } from "./config";
import { requireOwner } from "./security";
import { Store, store } from "./store";
import { bot, TelegramError } from "./telegram";

export function activityText(value: unknown): string {
  let text =
    typeof value === "string"
      ? value
      : (JSON.stringify(
          value,
          (key, item) =>
            /token|password|secret|authorization|cookie|api.?key/i.test(key) ? "[redacted]" : item,
          2,
        ) ?? "");

  for (const key of [
    "AI_GATEWAY_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_API_HASH",
    "TG_INTERNAL_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET_TOKEN",
  ]) {
    const secret = process.env[key];

    if (secret) text = text.split(secret).join("[redacted]");
  }

  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
}

export function activityChunks(text: string): string[] {
  const chunks: string[] = [];

  while (text.length) {
    let end = Math.min(4096, text.length);

    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;

    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }

  return chunks;
}

export type ActivitySend = (method: string, body: unknown) => Promise<any>;

export type ActivityPause = (ms: number) => Promise<void>;

let deliveries: Promise<void> = Promise.resolve();

export function orderedDelivery(operation: () => Promise<void>) {
  const next = deliveries.then(operation);

  deliveries = next.catch(() => {});

  return next;
}

export async function activityRequest(
  method: string,
  body: unknown,
  s: Store,
  send: ActivitySend,
  pause: ActivityPause,
) {
  const sendAt = s.transaction(() => {
    const at = Math.max(Date.now(), s.get("activity.nextSendAt", 0));

    s.set("activity.nextSendAt", at + 1100);

    return at;
  });

  if (sendAt > Date.now()) await pause(sendAt - Date.now());

  try {
    return await send(method, body);
  } catch (error) {
    if (
      method === "editMessageText" &&
      error instanceof TelegramError &&
      !error.ambiguous &&
      /message is not modified/i.test(error.message)
    )
      return true;

    if (!(error instanceof TelegramError) || error.ambiguous || !error.retryAfter) throw error;

    s.set("activity.nextSendAt", Date.now() + error.retryAfter * 1000 + 1100);

    if (error.retryAfter > 30) throw error;

    await pause(error.retryAfter * 1000);

    return send(method, body);
  }
}

export async function sendActivity(
  ctx: HookContext,
  identity: string,
  text: string,
  s: Store = store(),
  send: ActivitySend = bot,
  pause: ActivityPause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  try {
    requireOwner(ctx);
  } catch {
    return;
  }

  if (!config().ownerId || !text.trim()) return;

  const auth = ctx.session.auth.current;
  const jobId = auth?.attributes?.jobId;
  const prefix = typeof jobId === "string" ? `[Job: ${s.job(jobId).name}]\n` : "";
  const agent = ctx.agent.nodeId && ctx.agent.nodeId !== "root" ? `[${ctx.agent.name}]\n` : "";
  const safe = activityText(prefix + agent + text);
  const hash = createHash("sha256").update(safe).digest("hex");

  return orderedDelivery(async () => {
    for (const [index, chunk] of activityChunks(safe).entries()) {
      const key = `activity:${ctx.session.id}:${identity}:${hash}:${index}`;
      const claimed = s.transaction(() => {
        const prior = s.get<{ status: string } | null>(key, null);

        if (prior) return prior.status;

        s.set(key, { status: "sending" });

        return "claimed";
      });

      if (claimed === "sent") continue;

      if (claimed !== "claimed") return;

      try {
        const body = {
          chat_id: config().ownerId,
          text: chunk,
          disable_web_page_preview: true,
        };
        const result = await activityRequest("sendMessage", body, s, send, pause);

        s.set(key, { status: "sent", messageId: result.message_id });
      } catch (error) {
        const ambiguous = error instanceof TelegramError && error.ambiguous;

        s.set(key, { status: ambiguous ? "uncertain" : "failed" });
        s.event("activity.delivery_failed", { sessionId: ctx.session.id, uncertain: ambiguous });

        // Activity delivery must never repeat a tool or stop the agent's work.
        return;
      }
    }
  });
}
