import { chatSessionKey } from "./cancel-command";
import { ownerUpdate } from "./security";
import { store, type Store } from "./store";
import { notify } from "./telegram";

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
  const n = (value: number) => value.toLocaleString("en-US");
  const limit = info?.contextWindowTokens;
  const model = stats?.model ?? info?.modelId ?? "Unavailable";
  const lines = [
    "Context",
    `Model: ${model}${info?.reasoning ? " · " + info.reasoning + " reasoning" : ""}`,
    `Window: ${limit ? n(limit) + " tokens" : "Unavailable"}`,
  ];

  if (stats?.fresh && stats.inputTokens !== undefined) {
    const percent = limit ? ` (${((stats.inputTokens / limit) * 100).toFixed(2)}%)` : "";

    lines.push(`Latest input: ${n(stats.inputTokens)} tokens${percent}`);
  } else
    lines.push(
      stats?.inputTokens !== undefined
        ? "Usage: awaiting a fresh measurement after compaction"
        : "Usage: no provider measurement yet",
    );

  if (stats?.outputTokens !== undefined && stats.fresh)
    lines.push(`Latest output: ${n(stats.outputTokens)} tokens`);

  if (stats?.cacheReadTokens !== undefined && stats.fresh)
    lines.push(`Cached input: ${n(stats.cacheReadTokens)} tokens (included above)`);

  lines.push(`State: ${stats?.activity ?? "no chat session"}`);
  lines.push(`Compactions: ${stats?.compactions ?? 0}${stats?.compacting ? " · in progress" : ""}`);
  lines.push(`Skills loaded this/last turn: ${stats?.loadedSkills.join(", ") || "none"}`);
  lines.push(`Previously loaded in this session: ${stats?.previousSkills.join(", ") || "none"}`);

  if (info) {
    lines.push(`Available skills: ${info.skills.join(", ") || "none"}`);
    lines.push(`Available tools: ${info.toolCount}`);
  }

  if (stats?.measuredAt) lines.push(`Measured: ${stats.measuredAt}`);

  lines.push(
    "Usage is the last model request, not cumulative spending. Later messages and tool results appear in the next measurement. Previously loaded skills may have been summarized.",
  );

  return lines.join("\n");
}

export async function handleContextCommand(
  update: any,
  io: ContextIO,
  s: Store = store(),
  reply: (text: string, key: string) => Promise<unknown> = notify,
) {
  if (!ownerUpdate(update) || !/^\/context(?:@\w+)?\s*$/i.test(update.message?.text ?? ""))
    return false;

  const key = `telegram.context.command:${update.update_id}`;
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
