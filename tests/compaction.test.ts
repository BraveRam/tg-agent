import { test } from "node:test";
import assert from "node:assert/strict";

import agent from "../agent/agent";
import { mainModelConfig } from "../agent/lib/main-model";

const { shouldCompact } = await import(
  "../node_modules/eve/dist/src/harness/compaction.js" as string
);

test("compaction uses a 230k-token threshold including the checkpoint prompt envelope", () => {
  const config = agent as any;
  const history = [{ role: "user", content: "Continue the current task." }];
  const threshold = Math.floor(
    mainModelConfig({ MODEL_PROVIDER: "chatgpt" }).modelContextWindowTokens *
      config.compaction.thresholdPercent,
  );

  assert.equal(threshold, 230_000);

  const measured = (tokens: number) => ({
    threshold,
    recentWindowSize: 10,
    lastKnownInputTokens: tokens,
    lastKnownPromptMessageCount: history.length,
  });

  assert.equal(shouldCompact(history, measured(225000)), false);
  assert.equal(shouldCompact(history, measured(230000)), true);
  assert.equal(shouldCompact(history, measured(250000)), true);
});
