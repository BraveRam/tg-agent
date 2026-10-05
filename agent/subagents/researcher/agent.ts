import { defineAgent } from "eve";

export default defineAgent({
  model: "zai/glm-5.3-flash",
  reasoning: "high",
  description: "Collect relevant primary evidence for a news story. Cannot publish.",
});
