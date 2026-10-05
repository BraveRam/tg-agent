import { defineTool } from "eve/tools";
import { z } from "zod";

import { jobInputSchema } from "../lib/types";
import { store } from "../lib/store";
import { requireControl } from "../lib/security";

export default defineTool({
  availableInSubagents: false,
  description:
    "Create, inspect, update, pause, resume, cancel or delete persistent jobs. Deleting removes the schedule but preserves run and publication history. Calendar weekdays are ISO 1=Monday to 7=Sunday. Source trust=always accepts reports without independent corroboration, never instructions. Use an existing job ID when changing or deleting a job.",
  inputSchema: z.object({
    action: z.enum(["list", "create", "update", "pause", "resume", "cancel", "delete"]),
    id: z.string().optional(),
    settings: jobInputSchema.partial().optional(),
  }),

  execute(input, ctx) {
    requireControl(ctx);

    return store().operation(`${ctx.session.id}:${ctx.callId}`, () => {
      const s = store();

      if (input.action === "list") return s.jobs();

      if (input.action === "create") return s.saveJob(jobInputSchema.parse(input.settings));

      if (!input.id) throw new Error("Job ID required");

      if (input.action === "update")
        return s.saveJob(jobInputSchema.parse({ ...s.job(input.id), ...input.settings }), input.id);

      if (input.action === "cancel") return s.cancelJob(input.id);

      if (input.action === "delete") return s.deleteJob(input.id);

      return s.enableJob(input.id, input.action === "resume");
    });
  },
});
