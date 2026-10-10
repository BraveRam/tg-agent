import { z } from "zod";

import { requireControl } from "./security";
import { store, type Store } from "./store";

export const customSkillsKey = "agent.customSkills";
export const customSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(500),
  markdown: z.string().trim().min(1).max(24000),
});
export const customSkillsInput = z.object({
  action: z.enum(["create", "list", "get", "update", "delete"]),
  name: z.string().optional(),
  description: z.string().optional(),
  markdown: z.string().optional(),
});
type CustomSkill = z.infer<typeof customSkillSchema>;

export function listCustomSkills(s: Store = store()) {
  return s.get<CustomSkill[]>(customSkillsKey, []);
}

export function executeCustomSkills(
  raw: z.infer<typeof customSkillsInput>,
  ctx: any,
  s: Store = store(),
) {
  requireControl(ctx);
  const input = customSkillsInput.parse(raw);
  const skills = listCustomSkills(s);
  if (input.action === "list")
    return skills.map(({ name, description }) => ({ name: `custom-${name}`, description }));
  if (input.action === "get") {
    const skill = skills.find(
      (item) => `custom-${item.name}` === input.name || item.name === input.name,
    );
    if (!skill) throw new Error("Custom skill not found");
    return { ...skill, name: `custom-${skill.name}` };
  }
  const created = input.action === "create" ? customSkillSchema.parse(input) : null;
  return s.operation(`custom-skill:${ctx.session.id}:${ctx.callId}`, () => {
    const current = listCustomSkills(s);
    if (input.action === "update" || input.action === "delete") {
      const index = current.findIndex(
        (item) => item.name === input.name || `custom-${item.name}` === input.name,
      );
      if (index === -1) throw new Error("Custom skill not found");
      const existing = current[index];
      if (input.action === "delete") {
        s.set(
          customSkillsKey,
          current.filter((_, position) => position !== index),
        );
        return {
          name: `custom-${existing.name}`,
          status: "deleted",
          available: "Removed from the skill catalog starting on the next turn.",
        };
      }
      if (input.description === undefined && input.markdown === undefined)
        throw new Error("Provide description or markdown to update");
      const updated = customSkillSchema.parse({
        ...existing,
        description: input.description ?? existing.description,
        markdown: input.markdown ?? existing.markdown,
      });
      current[index] = updated;
      s.set(customSkillsKey, current);
      return {
        ...updated,
        name: `custom-${updated.name}`,
        status: "updated",
        available: "Updated content is loadable starting on the next turn; saved across restarts.",
      };
    }
    const skill = created!;
    if (current.some((item) => item.name === skill.name))
      throw new Error(
        "A custom skill with this name already exists. Use action=update to edit it.",
      );
    if (current.length >= 50) throw new Error("Custom skill limit reached (50)");
    s.set(customSkillsKey, [...current, skill]);
    return {
      name: `custom-${skill.name}`,
      description: skill.description,
      markdown: skill.markdown,
      status: "created",
      available: "Loadable with load_skill starting on the next turn; saved across restarts.",
    };
  });
}
