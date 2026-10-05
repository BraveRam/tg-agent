import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../agent/lib/store";
import { nextDue } from "../agent/lib/schedule";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tg-agent-"));
  const s = new Store(dir);
  const c = s.saveChannel({
    chatId: "-100123",
    name: "News",
    language: "en",
    style: "Brief",
    timezone: "Africa/Nairobi",
    images: "auto",
  });
  const j = s.saveJob({
    channelId: c.id,
    name: "AI",
    task: "AI news",
    sources: [{ kind: "telegram", reference: "@source" }],
    schedule: { kind: "interval", minutes: 5 },
    freshnessHours: 24,
  });

  return {
    s,
    c,
    j,
    dir,

    clean() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("clock times use timezone and weekdays", () => {
  const after = Date.parse("2026-10-02T05:00:00Z");

  assert.equal(
    nextDue({ kind: "calendar", times: ["07:00", "15:00"], timezone: "Africa/Nairobi" }, after),
    Date.parse("2026-10-02T12:00:00Z"),
  );
  assert.equal(
    nextDue(
      { kind: "calendar", times: ["07:00"], weekdays: [1], timezone: "Africa/Nairobi" },
      after,
    ),
    Date.parse("2026-10-05T04:00:00Z"),
  );
});

test("persistent settings, cursors, inbox and deduplicated publication", () => {
  const f = fixture();

  f.s.source("@source", [{ id: 10, text: "News" }], 10);
  f.s.ingest([{ update_id: 9 }, { update_id: 9 }]);

  const p = { channelId: f.c.id, headline: "Story", text: "Text", media: [] };

  assert.equal(f.s.enqueue(p, "story", null).id, f.s.enqueue(p, "story", null).id);
  f.s.close();

  const reopened = new Store(f.dir);

  assert.deepEqual(reopened.job(f.j.id).sources[0], { kind: "telegram", reference: "@source" });
  assert.equal(reopened.get("source.cursor:@source", 0), 10);
  assert.equal(reopened.inbox().length, 1);
  assert.equal(reopened.get("poll.offset", 0), 10);
  reopened.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("overlapping dispatchers cannot claim active job twice; paused and changed jobs invalidate runs", () => {
  const f = fixture();

  try {
    const now = f.j.nextDue + 1;
    const a = f.s.claimDue(now);

    assert.equal(a.length, 1);
    assert.equal(f.s.claimDue(now + 600000).length, 0);
    assert.ok(f.s.activeRun(a[0].id));
    f.s.enableJob(f.j.id, false);
    assert.throws(() => f.s.activeRun(a[0].id));
  } finally {
    f.clean();
  }
});

test("live source edits persist without starting correction work or advancing history checkpoints", () => {
  const f = fixture();

  try {
    f.s.source("@source", [{ id: 10, text: "Original" }], 10);
    f.s.source(
      "@source",
      Array.from({ length: 60 }, (_, i) => ({ id: i + 100, text: "New" })),
    );
    assert.equal(f.s.get("source.cursor:@source", 0), 10);
    assert.deepEqual(f.s.source("@source", [{ id: 10, text: "Corrected" }]), [10]);
    assert.equal(f.s.recoverRuns().length, 0);
    assert.deepEqual(f.s.source("@source", [{ id: 10, text: "Corrected" }]), []);
    assert.deepEqual(f.s.source("@source", [{ id: 10, text: "", deleted: true }]), [10]);
    assert.deepEqual(f.s.source("@source", [{ id: 10, text: "", deleted: true }]), []);

    f.s.source("@source", [{ id: 11, text: "Missed message" }], 11);
    assert.equal(f.s.get("source.cursor:@source", 0), 11);
    f.s.source("@source", [], 5);
    assert.equal(f.s.get("source.cursor:@source", 0), 11);

    const reopened = new Store(f.dir);

    assert.equal(reopened.get("source.cursor:@source", 0), 11);
    assert.equal(reopened.sourceMessages("@source", [10])[0].deleted, true);
    reopened.close();
  } finally {
    f.clean();
  }
});

test("calendar restart skips missed slots and publication claims are exclusive", () => {
  const f = fixture();

  try {
    const j = f.s.saveJob({
      ...f.j,
      schedule: { kind: "calendar", times: ["07:00", "15:00"], timezone: "Africa/Nairobi" },
    });

    f.s.db.prepare("UPDATE jobs SET next_due=0 WHERE id=?").run(j.id);
    f.s.resetMissedCalendar();
    assert.ok(f.s.job(j.id).nextDue > Date.now());

    const p = f.s.enqueue(
      { channelId: f.c.id, headline: "Story", text: "Text", media: [] },
      "key",
      null,
    );

    assert.equal(f.s.claimPublication(p.id), true);
    assert.equal(f.s.claimPublication(p.id), false);
  } finally {
    f.clean();
  }
});

test("authoritative publication history retains old records and supports explicit paging", () => {
  const f = fixture();

  try {
    const ids = Array.from(
      { length: 125 },
      (_, i) =>
        f.s.enqueue(
          {
            channelId: f.c.id,
            headline: "Story " + i,
            text: "Text",
            media: [],
          },
          "story:" + i,
          null,
        ).id,
    );

    assert.equal(f.s.publications(f.c.id).length, 125);
    assert.equal(f.s.publications(f.c.id).at(-1)?.id, ids[0]);
    assert.deepEqual(
      f.s.publications(f.c.id, 5, 120).map((p) => p.id),
      ids.slice(0, 5).reverse(),
    );
  } finally {
    f.clean();
  }
});

test("usage is replay-safe and daily budget blocks autonomous work", () => {
  const f = fixture();

  try {
    f.s.set("budget.daily", 2);
    f.s.recordUsage("step1", 1.5);
    f.s.recordUsage("step1", 1.5);
    assert.equal(f.s.spent(), 1.5);
    f.s.recordUsage("step2", 0.6);
    assert.equal(f.s.budgetAvailable(), false);
  } finally {
    f.clean();
  }
});

test("legacy jobs can be deleted while foreign keys and publication history survive restart", () => {
  const f = fixture();

  try {
    const run = f.s.claimDue(f.j.nextDue + 1)[0];
    const publication = f.s.enqueue(
      { channelId: f.c.id, headline: "Stored history", text: "History", media: [] },
      "history",
      run.id,
    );

    // Reproduce a database created before job deletion was introduced.
    f.s.db.exec("ALTER TABLE jobs DROP COLUMN deleted_at; PRAGMA user_version=2");
    f.s.close();

    const migrated = new Store(f.dir);

    try {
      const result = migrated.operation("delete-job", () => migrated.deleteJob(f.j.id));

      assert.equal(result.deleted, true);
      assert.equal(result.cancelledRuns, 1);
      assert.equal(result.preservedRuns, 1);
      assert.equal(result.preservedPublications, 1);
      assert.deepEqual(migrated.jobs(), []);
      assert.equal(migrated.run(run.id).status, "cancelled");
      assert.equal(migrated.publication(publication.id).text, "History");
      assert.ok(migrated.job(f.j.id).deletedAt);
      assert.throws(() => migrated.enableJob(f.j.id, true), /deleted/);
      assert.throws(() => migrated.saveJob(f.j, f.j.id), /deleted/);
      assert.throws(() => migrated.activeRun(run.id));
      assert.deepEqual(migrated.claimDue(f.j.nextDue + 600000), []);
      assert.deepEqual(migrated.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.deepEqual(
        migrated.operation("delete-job", () => {
          throw new Error("replayed deletion");
        }),
        result,
      );
    } finally {
      migrated.close();
    }

    const reopened = new Store(f.dir);

    try {
      assert.deepEqual(reopened.jobs(), []);
      assert.equal(reopened.publication(publication.id).runId, run.id);
      assert.equal(reopened.run(run.id).jobId, f.j.id);
      assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
