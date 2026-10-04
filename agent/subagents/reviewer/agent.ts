import { defineAgent } from "eve";

export default defineAgent({
  model: "xiaomi/mimo-v2.6-pro",
  reasoning: "high",
  description:
    "Review factual accuracy, duplication, source policy, and multilingual draft quality. Cannot publish.",
});
