import { defineHook } from "eve/hooks";

import { store } from "../lib/store";
import { notify } from "../lib/telegram";

export default defineHook({
  events: {
    "step.started": (_event, ctx) => {
      if (ctx.session.auth.current?.attributes?.runId && !store().budgetAvailable()) ctx.cancel();
    },
    "step.completed": (event, ctx) => {
      const cost = event.data.usage?.costUsd;

      if (cost !== undefined) {
        const priced = store().get(
          `priced.step:${ctx.session.id}:${event.data.turnId}:${event.data.stepIndex}`,
          false,
        );

        if (!priced) store().recordUsage(event.meta.id, cost);
      } else if (ctx.session.auth.current?.attributes?.runId) {
        store().set("budget.unpriced", true);
        ctx.cancel();
      }

      store().event("model.step", { sessionId: ctx.session.id, cost: cost ?? null }, event.meta.id);
    },
    "turn.failed": async (event, ctx) => {
      store().event("turn.failed", {
        sessionId: ctx.session.id,
        runId: ctx.session.auth.current?.attributes?.runId,
      });

      if (ctx.session.auth.current?.attributes?.runId)
        await notify(
          "A background run failed. Ask for status to inspect the job.",
          `runfailed:${ctx.session.id}:${event.data.turnId}`,
        );
    },
  },
});
