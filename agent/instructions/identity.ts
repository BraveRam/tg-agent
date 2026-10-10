import { defineDynamic, defineInstructions } from "eve/instructions";

import { selectedModelConfig } from "../lib/selected-model";

export default defineDynamic({
  events: {
    "turn.started": () => {
      const config = selectedModelConfig();

      return defineInstructions({
        role: "system",
        content: `Your model is ${config.model.modelId}.`,
      });
    },
  },
});
