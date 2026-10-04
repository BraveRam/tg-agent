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
    sources: [{ kind: "telegram", reference: "@source", trust: "always" }],
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

  f.s.source("@source", [{ id: 10, text: "News" }]);
  f.s.ingest([{ update_id: 9 }, { update_id: 9 }]);

  const p = { channelId: f.c.id, headline: "Story", text: "Text", evidence: [], media: [] };

  assert.equal(f.s.enqueue(p, "story", null).id, f.s.enqueue(p, "story", null).id);
  f.s.close();

  const reopened = new Store(f.dir);

  assert.equal(reopened.job(f.j.id).sources[0].trust, "always");
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
      { channelId: f.c.id, headline: "Story", text: "Text", evidence: [], media: [] },
      "key",
      null,
    );

    assert.equal(f.s.claimPublication(p.id), true);
    assert.equal(f.s.claimPublication(p.id), false);
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
