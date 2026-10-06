import { test } from "node:test";
import assert from "node:assert/strict";

import agent from "../agent/agent";

const { shouldCompact } = await import(
  "../node_modules/eve/dist/src/harness/compaction.js" as string
);

test("compaction reacts to provider-reported growth well before MiMo's native limit", () => {
  const config = agent as any;
  const history = [{ role: "user", content: "Continue the current task." }];
  const threshold = Math.floor(1_048_576 * config.compaction.thresholdPercent);
  const measured = (tokens: number) => ({
    threshold,
    recentWindowSize: 10,
    lastKnownInputTokens: tokens,
    lastKnownPromptMessageCount: history.length,
  });

  assert.equal(shouldCompact(history, measured(18000)), false);
  assert.equal(shouldCompact(history, measured(30000)), true);
  assert.equal(shouldCompact(history, measured(161000)), true);
});
