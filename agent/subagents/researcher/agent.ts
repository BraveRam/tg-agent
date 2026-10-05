import { defineAgent } from "eve";

export default defineAgent({
  model: "xiaomi/mimo-v2.6-pro",
  reasoning: "medium",
  description: "Retrieve relevant source material and media for a news story. Cannot publish.",
});
