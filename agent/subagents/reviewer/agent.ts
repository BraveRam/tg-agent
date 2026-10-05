import { defineAgent } from "eve";

export default defineAgent({
  model: "zai/glm-5.3-flash",
  reasoning: "high",
  description:
    "Review factual accuracy, duplication, source policy, and multilingual draft quality. Cannot publish.",
});
