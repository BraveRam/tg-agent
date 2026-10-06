import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../agent/lib/store";
import { chatSessionKey } from "../agent/lib/cancel-command";
import {
  contextKey,
  reduceContext,
  recordContext,
  handleContextCommand,
  formatContext,
  replyContext,
} from "../agent/lib/context-command";

const info = {
  modelId: "xiaomi/mimo-v2.6-pro",
  reasoning: "medium",
  contextWindowTokens: 1048576,
  skills: ["news", "english"],
  toolCount: 25,
};

const step = (inputTokens: number) => ({
  type: "step.completed",
  data: { usage: { inputTokens, outputTokens: 100, cacheReadTokens: 1024 } },
  meta: { at: "2026-10-05T22:00:00Z" },
});

const skill = (name: string, failed = false) => ({
  type: "action.result",
  data: {
    status: failed ? "failed" : "completed",
    result: { kind: "load-skill-result", name, isError: failed },
  },
});

test("context reports the latest request, not cumulative usage, and only successful loaded skills", () => {
  let stats = reduceContext(null, { type: "turn.started", data: { turnId: "one" } });

  stats = reduceContext(stats, step(50000));
  stats = reduceContext(stats, step(32768));
  stats = reduceContext(stats, skill("news"));
  stats = reduceContext(stats, skill("news"));
  stats = reduceContext(stats, skill("english", true));

  assert.deepEqual(stats.loadedSkills, ["news"]);
  assert.equal(stats.inputTokens, 32768);

  const rendered = formatContext(stats, info);

  assert.doesNotMatch(rendered, /Cached input|reasoning|Latest|State|Compactions/);
  assert.match(rendered, /Context used<\/b><br>32,768 tokens · 3\.13%/);
  assert.match(rendered, /<b>Model<\/b><br><code>xiaomi\/mimo-v2.6-pro<\/code>/);
  assert.match(rendered, /<b>Context window<\/b><br>1,048,576 tokens/);
  assert.match(rendered, /<b>Available skills<\/b><br>news · english/);

  stats = reduceContext(stats, { type: "turn.started", data: { turnId: "two" } });
  assert.deepEqual(stats.loadedSkills, []);
  assert.deepEqual(stats.previousSkills, ["news"]);
});

test("compaction invalidates the previous measurement until another model call; clear removes skill history", () => {
  let stats = reduceContext(null, step(800000));

  stats = reduceContext(stats, skill("news"));
  stats = reduceContext(stats, { type: "compaction.requested" });
  assert.equal(stats.compacting, true);
  stats = reduceContext(stats, { type: "compaction.completed" });
  assert.equal(stats.compactions, 1);
  assert.match(formatContext(stats, info), /Awaiting a fresh measurement/);
  assert.doesNotMatch(formatContext(stats, info), /800,000/);
  stats = reduceContext(stats, step(20000));
  assert.match(formatContext(stats, info), /20,000 tokens · 1\.91%/);
  stats = reduceContext(stats, { type: "context.cleared" });
  assert.deepEqual(stats.previousSkills, []);
  assert.equal(stats.inputTokens, undefined);
  assert.match(formatContext(stats, null), /Context window<\/b><br>Unavailable/g);
});

test("context event records survive restart and replayed compaction events do not double count", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-context-"));
  const s = new Store(dir);

  try {
    const event = { type: "compaction.completed", meta: { id: "compact-one" } };

    recordContext(step(20000), "chat", s);
    recordContext(event, "chat", s);
    recordContext(event, "chat", s);

    const reopened = new Store(dir);

    assert.equal(reopened.get<any>(contextKey("chat"), null).compactions, 1);
    assert.equal(reopened.get<any>(contextKey("chat"), null).fresh, false);
    reopened.close();
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context command is owner-only, hydrates old sessions, replays its result, and follows reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-context-command-"));
  const s = new Store(dir);
  const previousOwner = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "123";

  const update = {
    update_id: 1,
    message: { text: "/context", from: { id: 123 }, chat: { id: 123, type: "private" } },
  };
  let reads = 0;
  const io = {
    inspect: async () => info,
    snapshot: async (id: string) => {
      reads++;
      assert.equal(id, "chat");

      return [step(32768), skill("news")];
    },
  };
  const replies: string[] = [];
  const reply = async (text: string) => {
    replies.push(text);
  };

  try {
    s.set(chatSessionKey, "chat");
    assert.equal(
      await handleContextCommand(
        { ...update, message: { ...update.message, from: { id: 999 } } },
        io,
        s,
        reply,
      ),
      false,
    );
    assert.equal(reads, 0);
    assert.equal(await handleContextCommand(update, io, s, reply), true);
    assert.match(replies[0], /32,768 tokens · 3\.13%/);
    assert.match(replies[0], /Available skills<\/b><br>news · english/);
    await handleContextCommand(update, io, s, reply);
    assert.equal(reads, 1);
    assert.equal(replies[1], replies[0]);
    s.set(chatSessionKey, null);
    await handleContextCommand({ ...update, update_id: 2 }, io, s, reply);
    assert.match(replies[2], /xiaomi\/mimo-v2.6-pro/);
    assert.doesNotMatch(replies[2], /32,768/);
    assert.match(replies[2], /No measurement yet/);

    await handleContextCommand(
      { ...update, update_id: 3 },
      {
        inspect: async () => {
          throw new Error("Offline");
        },
        snapshot: io.snapshot,
      },
      s,
      reply,
    );
    assert.match(replies[3], /Context window<\/b><br>Unavailable/g);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });

    if (previousOwner === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = previousOwner;
  }
});

test("context rich delivery uses sendRichMessage and suppresses replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-context-rich-"));
  const s = new Store(dir);
  const calls: unknown[] = [];
  const send = async (method: string, body: unknown) => {
    calls.push({ method, body });
  };

  try {
    const html = formatContext(null, { ...info, modelId: "<model&>", skills: ["<skill>"] });

    assert.match(html, /&lt;model&amp;&gt;/);
    assert.match(html, /&lt;skill&gt;/);
    await replyContext(html, "test", s, send);
    await replyContext(html, "test", s, send);
    assert.deepEqual(calls, [
      {
        method: "sendRichMessage",
        body: {
          chat_id: process.env.TELEGRAM_OWNER_ID ?? "",
          rich_message: { html },
        },
      },
    ]);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
