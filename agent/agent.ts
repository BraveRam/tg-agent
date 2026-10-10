import { defineAgent, defineDynamic } from "eve";

import { selectedModelConfig } from "./lib/selected-model";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": () => {
        const { model, reasoning, modelContextWindowTokens } = selectedModelConfig();
        return { model, reasoning, modelContextWindowTokens };
      },
    },
  }),
  compaction: { thresholdPercent: 230_000 / 1_050_000 },
  tool: false,
});
