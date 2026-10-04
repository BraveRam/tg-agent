import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { Client } from "eve/client";

import { config } from "../agent/lib/config";
import { store } from "../agent/lib/store";
import { bot, userbot, notify } from "../agent/lib/telegram";
import { ownerUpdate } from "../agent/lib/security";
import { deliverPublication, reconcilePublication } from "../agent/lib/publishing";

const c = config(),
  s = store();

let stopped = false;

process.on("SIGTERM", () => {
  stopped = true;
});

process.on("SIGINT", () => {
  stopped = true;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendRun(id: string) {
  const r = await fetch(`http://127.0.0.1:${c.port}/internal/jobs/${id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.internalToken}` },
    signal: AbortSignal.timeout(20000),
  });

  if (!r.ok) throw new Error(`Run dispatch rejected (${r.status})`);
}

async function poll() {
  const webhook = await bot("getWebhookInfo", {});

  if (webhook.url) throw new Error("This bot has a webhook. Remove it before using local polling.");

  while (!stopped) {
    try {
      const updates = await bot<any[]>("getUpdates", {
        offset: s.get("poll.offset", 0),
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });

      s.ingest(updates);
    } catch {
      s.set("poll.health", "degraded");
      await wait(3000);
    }

    for (const row of s.inbox()) {
      const update = JSON.parse(row.payload);

      if (!ownerUpdate(update)) {
        s.inboxState(row.update_id, "ignored");
        continue;
      }

      try {
        const r = await fetch(`http://127.0.0.1:${c.port}/eve/v1/telegram`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": c.webhookSecret,
          },
          body: row.payload,
          signal: AbortSignal.timeout(20000),
        });

        if (!r.ok) {
          s.inboxState(row.update_id, r.status >= 500 ? "uncertain" : "pending");
          continue;
        }

        s.inboxState(row.update_id, "delivered");
        s.set("poll.health", "ready");
      } catch {
        // A lost HTTP acknowledgment may hide an accepted turn; do not replay it.
        s.inboxState(row.update_id, "uncertain");
        await notify(
          "An owner message could not be delivered reliably. Please resend it if needed.",
          `inbox:${row.update_id}`,
        );
      }
    }
  }
}

async function correctionRuns() {
  for (const j of s.jobs()) {
    if (!j.enabled || !s.get("correction.pending:" + j.id, false)) continue;

    s.transaction(() => {
      if (
        Number(
          (
            s.db
              .prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('claimed','running')")
              .get() as any
          ).n,
        ) >= 2 ||
        s.db
          .prepare("SELECT id FROM runs WHERE job_id=? AND status IN ('claimed','running')")
          .get(j.id)
      )
        return;

      const id = crypto.randomUUID();

      s.db
        .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,NULL)")
        .run(id, j.id, j.version, Date.now(), "claimed", Date.now() + 600000);
      s.set("run.mode:" + id, "correction");
      s.set("correction.pending:" + j.id, false);
    });
  }
}

async function dispatch() {
  s.resetMissedCalendar();

  const client = new Client({ host: `http://127.0.0.1:${c.port}` });

  while (!stopped) {
    try {
      const services: Record<string, unknown> = {};

      for (const name of ["eve", "userbot", "coordinator"])
        try {
          services[name] = JSON.parse(readFileSync(join(c.dataDir, `${name}.health.json`), "utf8"));
        } catch {
          services[name] = { state: "unknown" };
        }

      try {
        services.userbot = await userbot("/health");
      } catch {
        services.userbot = { state: "degraded" };
      }

      services.telegram = s.get("poll.health", "starting");
      s.set("services", services);

      if (s.budgetAvailable()) {
        await correctionRuns();
        s.claimDue();
      } else
        await notify(
          `Background model work paused. Recorded model spending: $${s.spent().toFixed(2)} / $${s.budget().toFixed(2)}${s.get("budget.unpriced", false) ? ". A model step returned no price." : ""}. Owner chat remains available.`,
          `budget:${s.day()}`,
        );

      for (const run of s.recoverRuns()) {
        if (run.sessionId) {
          if (run.leaseUntil < Date.now()) {
            try {
              await client.sessions.attach(run.sessionId).cancel();
            } catch {}

            s.runState(run.id, "failed");
            await notify(`Run ${run.id} exceeded its ten-minute deadline.`, `timeout:${run.id}`);
          }

          continue;
        }

        if (!s.budgetAvailable()) continue;

        const job = s.job(run.jobId);

        if (!job.enabled || job.version !== run.version) {
          s.runState(run.id, "cancelled");
          continue;
        }

        if (
          job.sources.length &&
          job.sources.every((src) => src.kind === "telegram") &&
          s.get("run.mode:" + run.id, "news") === "news"
        ) {
          const fingerprint = createHash("sha256")
            .update(JSON.stringify(job.sources.map((src) => s.sourceMessages(src.reference))))
            .digest("hex");

          if (s.get("job.fingerprint:" + job.id, "") === fingerprint) {
            s.runState(run.id, "skipped");
            continue;
          }

          s.set("run.fingerprint:" + run.id, fingerprint);
        }

        try {
          await sendRun(run.id);
        } catch {
          s.event("dispatch.retry", { runId: run.id });
        }
      }

      for (const p of s.pendingPublications()) {
        if (p.status === "sending") await reconcilePublication(p.id);
        else if (["queued", "sent", "unverified"].includes(p.status) && p.retryAt <= Date.now())
          await deliverPublication(p.id);
      }
    } catch {
      s.event("coordinator.failed", { reason: "Service unavailable; retrying" });
    }

    await wait(5000);
  }
}

try {
  await Promise.all([poll(), dispatch()]);
} catch (e) {
  console.error(e instanceof Error ? e.message : "Coordinator failed");
  process.exitCode = 1;
} finally {
  stopped = true;
}
