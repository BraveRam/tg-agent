import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
  description: "Collect relevant primary evidence for a news story. Cannot publish.",
});
