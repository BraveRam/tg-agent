import { defineAgent } from "eve";

export default defineAgent({
  model: "xiaomi/mimo-v2.6-pro",
  reasoning: "high",
  description: "Collect relevant primary evidence for a news story. Cannot publish.",
});
