import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("free NVIDIA calls keep background work active; unpriced providers still pause it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-provider-costs-"));

  try {
    // A separate process keeps the production Store singleton away from real data
    // and other tests while exercising both instrumentation and the budget hook.
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import costs from "./agent/instrumentation/costs.ts";
      import audit from "./agent/hooks/audit.ts";
      import { store } from "./agent/lib/store.ts";
      const s = store();
      let index = 0;
      for (const [model, reportedCost, shouldPause] of [
        [{provider: "nvidia.chat", modelId: "meta/muse-glimmer-30b"}, undefined, false],
        [{provider: "gateway", modelId: "openai/gpt-6-luna"}, 0.01, false],
        [{provider: "gateway", modelId: "meta/muse-glimmer-30b"}, undefined, true],
        [{provider: "nvidia.chat", modelId: "other"}, undefined, true],
      ]) {
        index++;
        s.set("budget.unpriced", false);
        const scope = {sessionId: "cost-check", turnId: "turn", stepIndex: index, attemptId: "attempt-" + index};
        await costs.events["model.call.started"]({scope, model});
        await costs.events["model.call.completed"]({scope, usage: {costUsd: reportedCost, inputTokens: 10, outputTokens: 5}, idempotencyKey: "call-" + index});
        let cancelled = false;
        await audit.events["step.completed"]({data: {turnId: "turn", stepIndex: index, usage: {costUsd: reportedCost}}, meta: {id: "step-" + index}}, {
          session: {id: "cost-check", auth: {current: {attributes: {runId: "job"}}}},
          cancel: () => { cancelled = true; },
        });
        assert.equal(cancelled, shouldPause);
        assert.equal(s.get("budget.unpriced", false), shouldPause);
      }
      assert.equal(s.spent(), 0.01);
      s.close();
    `,
      ],
      { env: { ...process.env, TG_DATA_DIR: dir }, stdio: "pipe" },
    );
  } catch (error: any) {
    assert.fail(error.stderr?.toString() || error.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
