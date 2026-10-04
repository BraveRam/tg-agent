import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
  description:
    "Review factual accuracy, duplication, source policy, and multilingual draft quality. Cannot publish.",
});
