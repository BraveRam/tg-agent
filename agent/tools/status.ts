import { defineTool } from "eve/tools";
import { z } from "zod";
import { store } from "../lib/store";
import { requireOwner, requireControl } from "../lib/security";
export default defineTool({
  description:
    "Inspect health, current recorded daily model spending, budget, jobs and unresolved publications. Change the autonomous daily model budget on owner request.",
  inputSchema: z.object({
    dailyBudgetUsd: z.number().min(0).max(1000).optional(),
    acknowledgeUnpricedPause: z.boolean().optional(),
  }),
  execute(input, ctx) {
    requireOwner(ctx);
    const s = store();
    if (input.dailyBudgetUsd !== undefined) {
      requireControl(ctx);
      s.set("budget.daily", input.dailyBudgetUsd);
    }
    if (input.acknowledgeUnpricedPause) {
      requireControl(ctx);
      s.set("budget.unpriced", false);
      s.event("budget.unpriced.acknowledged", {});
    }
    return {
      unpricedPause: s.get("budget.unpriced", false),
      dailyModelBudget: s.budget(),
      recordedModelCost: s.spent(),
      budgetAvailable: s.budgetAvailable(),
      services: s.get("services", {}),
      jobs: s.jobs(),
      unresolved: s
        .publications()
        .filter((p) => !["verified", "deleted", "cancelled"].includes(p.status)),
    };
  },
});
