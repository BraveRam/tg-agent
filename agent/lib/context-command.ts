import { chatSessionKey } from "./cancel-command";
import { ownerUpdate } from "./security";
import { store, type Store } from "./store";
import { config } from "./config";
import { bot } from "./telegram";

export type ContextStats = {
  model?: string;
  turnId?: string;
  activity: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  measuredAt?: string;
  fresh: boolean;
  loadedSkills: string[];
  previousSkills: string[];
  compactions: number;
  compacting: boolean;
};

type Event = { type: string; data?: any; meta?: { id?: string; at?: string } };

export const contextKey = (sessionId: string) => "telegram.context:" + sessionId;

export function reduceContext(stats: ContextStats | null, event: Event): ContextStats {
  const next: ContextStats = stats
    ? { ...stats, loadedSkills: [...stats.loadedSkills], previousSkills: [...stats.previousSkills] }
    : {
        activity: "idle",
        fresh: false,
        loadedSkills: [],
        previousSkills: [],
        compactions: 0,
        compacting: false,
      };
  const data = event.data ?? {};

  if (event.type === "turn.started") {
    if (next.turnId !== data.turnId) next.loadedSkills = [];

    next.turnId = data.turnId;
    next.activity = "working";
  }

  if (event.type === "step.started") {
    next.model = data.modelId;
    next.activity = "working";
  }

  if (event.type === "step.completed") {
    const usage = data.usage ?? {};

    next.inputTokens = usage.inputTokens;
    next.outputTokens = usage.outputTokens;
    next.cacheReadTokens = usage.cacheReadTokens;
    next.fresh = typeof usage.inputTokens === "number";
    next.measuredAt = event.meta?.at;
  }

  if (event.type === "action.result" && data.status === "completed" && !data.result?.isError) {
    const result = data.result;

    if (result?.kind === "load-skill-result" && typeof result.name === "string") {
      next.loadedSkills = [...new Set([...next.loadedSkills, result.name])];
      next.previousSkills = [...new Set([...next.previousSkills, result.name])];
    }
  }

  if (event.type === "compaction.requested") next.compacting = true;

  if (event.type === "compaction.completed") {
    next.compactions++;
    next.compacting = false;
    next.fresh = false;
  }

  if (event.type === "context.cleared") {
    next.fresh = false;
    next.inputTokens = undefined;
    next.outputTokens = undefined;
    next.loadedSkills = [];
    next.previousSkills = [];
  }

  if (["turn.completed", "turn.cancelled", "session.waiting"].includes(event.type))
    next.activity = "idle";

  if (event.type === "turn.waiting") next.activity = "waiting for input";

  if (["turn.failed", "session.failed", "step.failed"].includes(event.type)) {
    next.activity = "failed";
    next.compacting = false;
  }

  return next;
}

export function recordContext(event: Event, sessionId: string, s: Store = store()) {
  if (
    ![
      "turn.started",
      "step.started",
      "step.completed",
      "action.result",
      "compaction.requested",
      "compaction.completed",
      "context.cleared",
      "turn.completed",
      "turn.cancelled",
      "session.waiting",
      "turn.waiting",
      "turn.failed",
      "session.failed",
      "step.failed",
    ].includes(event.type)
  )
    return;

  s.transaction(() => {
    const marker = event.meta?.id ? "telegram.context.event:" + event.meta.id : null;

    if (marker && s.get(marker, false)) return;

    s.set(contextKey(sessionId), reduceContext(s.get(contextKey(sessionId), null), event));

    if (marker) s.set(marker, true);
  });
}

type Inspection = {
  modelId?: string;
  reasoning?: string;
  contextWindowTokens?: number;
  skills: string[];
  toolCount: number;
};

type ContextIO = {
  inspect: () => Promise<Inspection>;
  snapshot: (sessionId: string) => Promise<readonly Event[]>;
};

export function formatContext(stats: ContextStats | null, info: Inspection | null) {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const model = info?.modelId ?? stats?.model ?? "Unavailable";
  const window = info?.contextWindowTokens
    ? info.contextWindowTokens.toLocaleString("en-US") + " tokens"
    : "Unavailable";
  const used =
    stats?.fresh && stats.inputTokens !== undefined
      ? stats.inputTokens.toLocaleString("en-US") +
        " tokens" +
        (info?.contextWindowTokens
          ? ` · ${((stats.inputTokens / info.contextWindowTokens) * 100).toFixed(2)}%`
          : "") +
        " <i>(last request)</i>"
      : stats?.inputTokens !== undefined
        ? "Awaiting a fresh measurement"
        : "No measurement yet";

  return [
    `<p><b>Model</b><br><code>${escape(model)}</code></p>`,
    `<p><b>Context window</b><br>${window}</p>`,
    `<p><b>Context used</b><br>${used}</p>`,
    `<p><b>Available skills</b><br>${escape(info ? info.skills.join(" · ") || "none" : "Unavailable")}</p>`,
  ].join("");
}

export async function replyContext(
  html: string,
  key: string,
  s: Store = store(),
  send: (method: string, body: unknown) => Promise<unknown> = bot,
) {
  if (s.get("notice:" + key, false)) return;

  await send("sendRichMessage", {
    chat_id: config().ownerId,
    rich_message: { html },
  });
  s.set("notice:" + key, true);
}

export async function handleContextCommand(
  update: any,
  io: ContextIO,
  s: Store = store(),
  reply: (text: string, key: string) => Promise<unknown> = (html, key) =>
    replyContext(html, key, s),
) {
  if (!ownerUpdate(update) || !/^\/context(?:@\w+)?\s*$/i.test(update.message?.text ?? ""))
    return false;

  const key = `telegram.context.command.rich:${update.update_id}`;
  let result = s.get<string | null>(key, null);

  if (!result) {
    const sessionId = s.get<string | null>(chatSessionKey, null);
    let stats = sessionId ? s.get<ContextStats | null>(contextKey(sessionId), null) : null;
    let info: Inspection | null = null;

    if (sessionId && !stats) {
      try {
        for (const event of await io.snapshot(sessionId)) stats = reduceContext(stats, event);

        const current = s.get<ContextStats | null>(contextKey(sessionId), null);

        if (current) stats = current;
        else if (stats) s.set(contextKey(sessionId), stats);
      } catch {}
    }

    try {
      info = await io.inspect();
    } catch {}

    result = formatContext(stats, info);
    s.set(key, result);
  }

  await reply(result, key);

  return true;
}
