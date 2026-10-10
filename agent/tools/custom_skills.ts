import { defineTool } from "eve/tools";

import { customSkillsInput, executeCustomSkills } from "../lib/custom-skills";

export default defineTool({
  availableInSubagents: false,
  description:
    "Create, update, delete, list or read persistent custom skills. Mutate skills only when the owner explicitly asks. Read an existing skill before editing it; use action=update rather than create, with name and the description and/or markdown to replace. Omitted fields remain unchanged. Delete uses action=delete and name. Get, update and delete accept the saved custom-<name> or unprefixed name. Create requires an unprefixed lowercase hyphenated name, a trigger description and reusable Markdown procedure. Changes apply to the load_skill catalog next turn and persist across restarts. Only custom skills can be changed; skills use existing tools and contain no credentials.",
  inputSchema: customSkillsInput,
  execute: (input, ctx) => executeCustomSkills(input, ctx),
});
