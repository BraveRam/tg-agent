import { defineDynamic, defineSkill } from "eve/skills";

import { listCustomSkills } from "../lib/custom-skills";
import { requireOwner } from "../lib/security";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      requireOwner(ctx);
      return Object.fromEntries(
        listCustomSkills().map((skill) => [
          `custom-${skill.name}`,
          defineSkill({ description: skill.description, markdown: skill.markdown }),
        ]),
      );
    },
  },
});
