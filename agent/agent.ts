import { defineAgent } from "eve";

import { mainModelConfig } from "./lib/main-model";

export default defineAgent({
  ...mainModelConfig(),
  tool: false,
});
