import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";

import { config } from "./config";
import { nextDue } from "./schedule";
import type { Channel, Job, Run, Publication, Post } from "./types";

let singleton: Store | undefined;

export type SourceChange = { source: string; messageId: number };

export function store() {
  return (singleton ??= new Store(config().dataDir));
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "agent.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,chat_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id),data TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,next_due INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),version INTEGER NOT NULL,due INTEGER NOT NULL,status TEXT NOT NULL,lease_until INTEGER NOT NULL,session_id TEXT,UNIQUE(job_id,due));
 CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id),run_id TEXT,story_key TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,sent_at INTEGER,operation TEXT NOT NULL DEFAULT 'send',attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(channel_id,story_key));
 CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,publication_id TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS inbox(update_id INTEGER PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memories(key TEXT PRIMARY KEY,content TEXT NOT NULL,version INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS source_messages(source TEXT NOT NULL,message_id INTEGER NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(source,message_id));
 CREATE TABLE IF NOT EXISTS usage(operation_key TEXT PRIMARY KEY,day TEXT NOT NULL,cost REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
 PRAGMA user_version=1;`);
  }

  close() {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const v = fn();

      this.db.exec("COMMIT");

      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  get<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as
      | { value: string }
      | undefined;

    return r ? JSON.parse(r.value) : fallback;
  }

  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value));
  }

  event(type: string, data: unknown, id: string = randomUUID()) {
    this.db
      .prepare("INSERT OR IGNORE INTO events VALUES(?,?,?,?)")
      .run(id, type, JSON.stringify(data), Date.now());
  }

  channels(): Channel[] {
    return this.db
      .prepare("SELECT id,data FROM channels")
      .all()
      .map((r: any) => ({ ...JSON.parse(r.data), id: r.id }));
  }

  channel(id: string): Channel {
    const r = this.db
      .prepare("SELECT id,data FROM channels WHERE id=? OR chat_id=?")
      .get(id, id) as any;

    if (!r) throw new Error("Channel not registered");

    return { ...JSON.parse(r.data), id: r.id };
  }

  saveChannel(data: Omit<Channel, "id">): Channel {
    const prior = this.db
      .prepare("SELECT id FROM channels WHERE chat_id=?")
      .get(data.chatId) as any;
    const id = prior?.id ?? randomUUID();

    this.db
      .prepare(
        "INSERT INTO channels VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET data=excluded.data",
      )
      .run(id, data.chatId, JSON.stringify(data));

    if (prior) this.db.prepare("UPDATE jobs SET version=version+1 WHERE channel_id=?").run(id);

    this.event("channel.saved", { id });

    return { ...data, id };
  }

  jobs(): Job[] {
    return this.db
      .prepare("SELECT * FROM jobs")
      .all()
      .map((r: any) => this.decodeJob(r));
  }

  private decodeJob(r: any): Job {
    return {
      ...JSON.parse(r.data),
      id: r.id,
      enabled: !!r.enabled,
      version: r.version,
      nextDue: r.next_due,
    };
  }

  job(id: string): Job {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);

    if (!r) throw new Error("Unknown job");

    return this.decodeJob(r);
  }

  saveJob(data: Omit<Job, "id" | "enabled" | "version" | "nextDue">, id?: string): Job {
    this.channel(data.channelId);

    const old = id ? this.job(id) : undefined;
    const key = id ?? randomUUID();
    const due = nextDue(data.schedule, Date.now());

    this.db
      .prepare(
        "INSERT INTO jobs VALUES(?,?,?,1,1,?) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,data=excluded.data,version=jobs.version+1,next_due=excluded.next_due",
      )
      .run(key, data.channelId, JSON.stringify(data), due);
    this.event("job.saved", { id: key });

    return this.job(key);
  }

  enableJob(id: string, enabled: boolean) {
    const j = this.job(id);

    this.db
      .prepare("UPDATE jobs SET enabled=?,version=version+1,next_due=? WHERE id=?")
      .run(+enabled, nextDue(j.schedule, Date.now()), id);

    return this.job(id);
  }

  cancelJob(id: string) {
    this.enableJob(id, false);
    this.db
      .prepare(
        "UPDATE runs SET status='cancelled' WHERE job_id=? AND status IN ('claimed','running')",
      )
      .run(id);

    return this.job(id);
  }

  resetMissedCalendar(now = Date.now()) {
    for (const j of this.jobs())
      if (j.schedule.kind === "calendar" && j.nextDue < now)
        this.db
          .prepare("UPDATE jobs SET next_due=? WHERE id=?")
          .run(nextDue(j.schedule, now), j.id);
  }

  claimDue(now = Date.now()): Run[] {
    return this.transaction(() => {
      const result: Run[] = [];

      for (const j of this.jobs()) {
        if (
          Number(
            (
              this.db
                .prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('claimed','running')")
                .get() as any
            ).n,
          ) >= 2
        )
          break;

        if (!j.enabled || j.nextDue > now) continue;

        const active = this.db
          .prepare("SELECT id FROM runs WHERE job_id=? AND status IN ('claimed','running')")
          .get(j.id);

        if (active) continue;

        const id = randomUUID();

        this.db
          .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,NULL)")
          .run(id, j.id, j.version, j.nextDue, "claimed", now + 600000);
        this.db
          .prepare("UPDATE jobs SET next_due=? WHERE id=?")
          .run(nextDue(j.schedule, now), j.id);
        result.push(this.run(id));
      }

      return result;
    });
  }

  claimCorrection(jobId: string, now = Date.now()): Run | null {
    return this.transaction(() => {
      const job = this.job(jobId);
      const active = this.recoverRuns();

      if (
        !job.enabled ||
        !this.get("correction.pending:" + jobId, false) ||
        this.get("correction.retryAt:" + jobId, 0) > now ||
        active.length >= 2 ||
        active.some((run) => run.jobId === jobId)
      )
        return null;

      const id = randomUUID();

      this.db
        .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,NULL)")
        .run(id, job.id, job.version, now, "claimed", now + 600000);
      this.set("run.mode:" + id, "correction");
      this.set(
        "run.sourceChanges:" + id,
        this.get<SourceChange[]>("correction.changes:" + jobId, []),
      );
      this.set("correction.changes:" + jobId, []);
      this.set("correction.pending:" + jobId, false);

      return this.run(id);
    });
  }

  run(id: string): Run {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as any;

    if (!r) throw new Error("Unknown run");

    return {
      id: r.id,
      jobId: r.job_id,
      version: r.version,
      due: r.due,
      status: r.status,
      leaseUntil: r.lease_until,
      sessionId: r.session_id,
    };
  }

  activeRun(id: string) {
    const r = this.run(id),
      j = this.job(r.jobId);

    if (!j.enabled || j.version !== r.version || !["claimed", "running"].includes(r.status))
      throw new Error("Job paused, changed, or run inactive");

    return { run: r, job: j, channel: this.channel(j.channelId) };
  }

  runState(id: string, status: string, sessionId?: string) {
    this.transaction(() => {
      const run = this.run(id);

      if (
        ["failed", "cancelled"].includes(status) &&
        ["claimed", "running"].includes(run.status) &&
        this.get<string>("run.mode:" + id, "news") === "correction"
      ) {
        this.queueCorrection(run.jobId, this.get<SourceChange[]>("run.sourceChanges:" + id, []));
        this.set("correction.retryAt:" + run.jobId, Date.now() + 60000);
      }

      this.db
        .prepare(
          "UPDATE runs SET status=?,session_id=COALESCE(?,session_id),lease_until=? WHERE id=?",
        )
        .run(status, sessionId ?? null, Date.now() + 600000, id);
    });
  }

  recoverRuns() {
    return this.db
      .prepare("SELECT id FROM runs WHERE status IN ('claimed','running')")
      .all()
      .map((r: any) => this.run(r.id));
  }

  enqueue(post: Post, storyKey: string, runId: string | null): Publication {
    const id = randomUUID();

    this.db
      .prepare(
        "INSERT OR IGNORE INTO publications(id,channel_id,run_id,story_key,data,status) VALUES(?,?,?,?,?,'queued')",
      )
      .run(id, post.channelId, runId, storyKey, JSON.stringify({ ...post, messageIds: [] }));

    const r = this.db
      .prepare("SELECT id FROM publications WHERE channel_id=? AND story_key=?")
      .get(post.channelId, storyKey) as any;

    return this.publication(r.id);
  }

  publication(id: string): Publication {
    const r = this.db.prepare("SELECT * FROM publications WHERE id=?").get(id) as any;

    if (!r) throw new Error("Unknown publication");

    return {
      ...JSON.parse(r.data),
      id: r.id,
      channelId: r.channel_id,
      runId: r.run_id,
      storyKey: r.story_key,
      status: r.status,
      sentAt: r.sent_at,
      operation: r.operation,
      attempts: r.attempts,
      retryAt: r.retry_at,
      error: r.error,
    };
  }

  publications(channelId?: string, limit?: number, offset = 0): Publication[] {
    return this.db
      .prepare(
        "SELECT id FROM publications WHERE (? IS NULL OR channel_id=?) ORDER BY rowid DESC LIMIT ? OFFSET ?",
      )
      .all(channelId ?? null, channelId ?? null, limit ?? -1, offset)
      .map((r: any) => this.publication(r.id));
  }

  pendingPublications(): Publication[] {
    return this.db
      .prepare(
        "SELECT id FROM publications WHERE status IN ('queued','sending','sent','unverified') ORDER BY rowid",
      )
      .all()
      .map((r: any) => this.publication(r.id));
  }

  operation<T>(key: string, fn: () => T): T {
    return this.transaction(() => {
      const prior = this.get<{ result: T } | null>("operation:" + key, null);

      if (prior) return prior.result;

      const result = fn();

      this.set("operation:" + key, { result });

      return result;
    });
  }

  updatePublication(id: string, changes: Partial<Publication>) {
    const p = { ...this.publication(id), ...changes };

    this.db
      .prepare(
        "UPDATE publications SET data=?,status=?,sent_at=?,operation=?,attempts=?,retry_at=?,error=? WHERE id=?",
      )
      .run(JSON.stringify(p), p.status, p.sentAt, p.operation, p.attempts, p.retryAt, p.error, id);

    return p;
  }

  claimPublication(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE publications SET status='sending',attempts=attempts+1 WHERE id=? AND status='queued'",
        )
        .run(id).changes === 1
    );
  }

  revise(id: string, changes: Partial<Publication>) {
    const p = this.publication(id);

    this.db
      .prepare("INSERT INTO revisions VALUES(?,?,?,?)")
      .run(randomUUID(), id, JSON.stringify(p), Date.now());

    return this.updatePublication(id, changes);
  }

  ingest(updates: { update_id: number }[]) {
    this.transaction(() => {
      for (const u of updates)
        this.db
          .prepare("INSERT OR IGNORE INTO inbox(update_id,payload) VALUES(?,?)")
          .run(u.update_id, JSON.stringify(u));

      if (updates.length)
        this.set(
          "poll.offset",
          Math.max(this.get("poll.offset", 0), Math.max(...updates.map((u) => u.update_id)) + 1),
        );
    });
  }

  inbox() {
    return this.db
      .prepare(
        "SELECT update_id,payload,attempts FROM inbox WHERE status='pending' ORDER BY update_id LIMIT 20",
      )
      .all() as { update_id: number; payload: string; attempts: number }[];
  }

  inboxState(id: number, status: string) {
    this.db
      .prepare("UPDATE inbox SET status=?,attempts=attempts+1 WHERE update_id=?")
      .run(status, id);
  }

  source(source: string, messages: any[], cursor?: number) {
    return this.transaction(() => {
      const changed: number[] = [];
      const prior = this.db.prepare(
        "SELECT data FROM source_messages WHERE source=? AND message_id=?",
      );

      for (const m of messages) {
        const row = prior.get(source, m.id) as { data: string } | undefined;
        const old = row ? JSON.parse(row.data) : undefined;

        if (old && (old.text !== m.text || Boolean(old.deleted) !== Boolean(m.deleted)))
          changed.push(m.id);

        this.db
          .prepare(
            "INSERT INTO source_messages VALUES(?,?,?,?) ON CONFLICT(source,message_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
          )
          .run(source, m.id, JSON.stringify(m), Date.now());
      }

      // Only an acknowledged, ordered history batch advances the scan checkpoint.
      // Live events and edit/deletion refreshes may arrive beyond a history gap.
      if (cursor !== undefined)
        this.set(
          "source.cursor:" + source,
          Math.max(this.get("source.cursor:" + source, 0), cursor),
        );

      if (changed.length) {
        for (const j of this.jobs())
          if (j.sources.some((src) => src.kind === "telegram" && src.reference === source))
            this.queueCorrection(
              j.id,
              changed.map((messageId) => ({ source, messageId })),
            );

        this.event("source.changed", { source, messageIds: changed });
      }

      return changed;
    });
  }

  private queueCorrection(jobId: string, changes: SourceChange[]) {
    const pending = this.get<SourceChange[]>("correction.changes:" + jobId, []);
    const unique = new Map(
      [...pending, ...changes].map((change) => [JSON.stringify(change), change]),
    );

    this.set("correction.changes:" + jobId, [...unique.values()]);
    this.set("correction.pending:" + jobId, true);
  }

  sourceMessages(source: string, ids?: number[]) {
    if (ids) {
      const statement = this.db.prepare(
        "SELECT data FROM source_messages WHERE source=? AND message_id=?",
      );

      return [...new Set(ids)].flatMap((id) => {
        const row = statement.get(source, id) as { data: string } | undefined;

        return row ? [JSON.parse(row.data)] : [];
      });
    }

    return this.db
      .prepare("SELECT data FROM source_messages WHERE source=? ORDER BY message_id DESC LIMIT 50")
      .all(source)
      .map((r: any) => JSON.parse(r.data));
  }

  day(now = Date.now()) {
    return DateTime.fromMillis(now, { zone: config().timezone }).toISODate()!;
  }

  recordUsage(key: string, cost: number) {
    if (Number.isFinite(cost) && cost >= 0)
      this.db.prepare("INSERT OR IGNORE INTO usage VALUES(?,?,?)").run(key, this.day(), cost);
  }

  spent() {
    return Number(
      (
        this.db
          .prepare("SELECT COALESCE(SUM(cost),0) AS total FROM usage WHERE day=?")
          .get(this.day()) as any
      ).total,
    );
  }

  budget() {
    return this.get("budget.daily", config().dailyBudget);
  }

  budgetAvailable() {
    return !this.get("budget.unpriced", false) && this.spent() < this.budget();
  }
}
