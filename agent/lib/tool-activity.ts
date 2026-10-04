import { createHash } from "node:crypto";

import type { HookContext } from "eve/hooks";

import {
  activityText,
  activityRequest,
  orderedDelivery,
  type ActivitySend,
  type ActivityPause,
} from "./activity";
import { config } from "./config";
import { requireOwner } from "./security";
import { store, type Store } from "./store";
import { bot, TelegramError } from "./telegram";

export interface ToolActivity {
  callId: string;
  name: string;
  input?: unknown;
  error?: string;
}

interface CardCall {
  callId: string;
  name: string;
  preview: string;
  language: string;
  error?: string;
}

interface Entity {
  type: "bold" | "pre";
  offset: number;
  length: number;
  language?: string;
}

interface CardPage {
  text: string;
  entities: Entity[];
}

interface Delivery {
  status: string;
  messageId?: number;
  hash?: string;
}

function terminal(name: string) {
  return /^(bash|terminal|shell|exec_command|run_command)$/.test(name);
}

function preview(call: ToolActivity): CardCall {
  const input =
    call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  const value = terminal(call.name)
    ? (input.command ?? input.cmd ?? call.input)
    : (input.query ?? input.url ?? input.path ?? input.message ?? input.prompt ?? call.input);
  const empty = value == null || (typeof value === "object" && !Object.keys(value).length);
  const formatted = empty
    ? ""
    : typeof value === "object" && Object.keys(value).length === 1 && "action" in value
      ? String(value.action)
      : activityText(value);

  return {
    callId: call.callId,
    name: activityText(call.name),
    preview: formatted.slice(0, 1800) + (formatted.length > 1800 ? "\n…" : ""),
    language: terminal(call.name) ? "shell" : typeof value === "object" ? "json" : "text",
    error: call.error ? activityText(call.error).slice(0, 500) : undefined,
  };
}

export function renderToolCards(calls: CardCall[], prefix = ""): CardPage[] {
  if (!calls.length) return [];

  const shell = calls.every((call) => terminal(call.name));
  const title = prefix + (shell ? "💻 terminal" : "🛠 Tools");
  const pages: CardPage[] = [];
  let page: CardPage = {
    text: title,
    entities: [{ type: "bold", offset: 0, length: title.length }],
  };

  for (const call of calls) {
    const heading = shell ? "" : call.name;
    const error = call.error ? `\n⚠ ${call.error}` : "";
    const block = (heading ? heading + "\n" : "") + call.preview + error;
    const addition = "\n\n" + block;

    if (page.text.length + addition.length > 4000) {
      pages.push(page);
      page = { text: title, entities: [{ type: "bold", offset: 0, length: title.length }] };
    }

    const offset = page.text.length + 2;

    page.text += addition;

    if (heading) page.entities.push({ type: "bold", offset, length: heading.length });

    if (call.preview)
      page.entities.push({
        type: "pre",
        offset: offset + (heading ? heading.length + 1 : 0),
        length: call.preview.length,
        language: call.language,
      });
  }

  pages.push(page);

  return pages;
}

export function closeToolBatch(ctx: HookContext, turnId: string, messageKey: string, s = store()) {
  try {
    requireOwner(ctx);
  } catch {
    return;
  }

  s.transaction(() => {
    const marker = `activity.batch.closed:${ctx.session.id}:${messageKey}`;

    if (s.get(marker, false)) return;

    const key = `activity.batch:${ctx.session.id}:${turnId}`;

    s.set(key, s.get(key, 0) + 1);
    s.set(marker, true);
  });
}

export async function updateToolActivity(
  ctx: HookContext,
  turnId: string,
  updates: ToolActivity[],
  s: Store = store(),
  send: ActivitySend = bot,
  pause: ActivityPause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  try {
    requireOwner(ctx);
  } catch {
    return;
  }

  if (!config().ownerId || !updates.length) return;

  return orderedDelivery(async () => {
    const batch = s.get(`activity.batch:${ctx.session.id}:${turnId}`, 0);
    const currentKey = `activity.card:${ctx.session.id}:${turnId}:${batch}`;
    const groups = new Map<string, ToolActivity[]>();

    for (const update of updates) {
      const locator = `activity.card.call:${ctx.session.id}:${update.callId}`;
      const key = s.get(locator, currentKey);
      const group = groups.get(key) ?? [];

      group.push(update);
      groups.set(key, group);
      s.set(locator, key);
    }

    for (const [key, group] of groups) {
      const calls = s.get<CardCall[]>(key, []);

      for (const update of group) {
        const old = calls.find((call) => call.callId === update.callId);

        if (old) {
          if (!old.preview && update.input !== undefined) {
            const next = preview(update);

            old.preview = next.preview;
            old.language = next.language;
          }

          if (update.error) old.error = activityText(update.error).slice(0, 500);
        } else calls.push(preview(update));
      }

      s.set(key, calls);

      const jobId = ctx.session.auth.current?.attributes?.jobId;
      const prefix =
        (typeof jobId === "string" ? `Job: ${s.job(jobId).name}\n` : "") +
        (ctx.agent.nodeId && ctx.agent.nodeId !== "root" ? `${ctx.agent.name}\n` : "");
      const pages = renderToolCards(calls, activityText(prefix));

      for (const [index, page] of pages.entries()) {
        const deliveryKey = `${key}:page:${index}`;
        const prior = s.get<Delivery | null>(deliveryKey, null);
        const hash = createHash("sha256").update(JSON.stringify(page)).digest("hex");

        if (prior?.hash === hash) continue;

        // Accepted-but-unacknowledged sends cannot be safely repeated.
        if (prior && !prior.messageId && ["sending", "uncertain"].includes(prior.status)) return;

        if (!prior?.messageId) s.set(deliveryKey, { status: "sending" });

        try {
          const method = prior?.messageId ? "editMessageText" : "sendMessage";
          const result = await activityRequest(
            method,
            {
              chat_id: config().ownerId,
              ...page,
              disable_web_page_preview: true,
              ...(prior?.messageId ? { message_id: prior.messageId } : {}),
            },
            s,
            send,
            pause,
          );

          s.set(deliveryKey, {
            status: "sent",
            messageId: prior?.messageId ?? result.message_id,
            hash,
          });
        } catch (error) {
          if (!prior?.messageId)
            s.set(deliveryKey, {
              status: error instanceof TelegramError && !error.ambiguous ? "failed" : "uncertain",
            });

          s.event("activity.delivery_failed", { sessionId: ctx.session.id, card: true });

          return;
        }
      }
    }
  });
}
