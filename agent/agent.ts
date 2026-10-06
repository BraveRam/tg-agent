import { defineAgent } from "eve";

export default defineAgent({
  model: "xiaomi/mimo-v2.6-pro",
  reasoning: "low",
  tool: false,
  // About 26k tokens on MiMo's 1M-token window, including instructions and tools.
  compaction: { thresholdPercent: 0.025 },
});
