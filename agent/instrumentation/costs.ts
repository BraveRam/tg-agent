import { defineInstrumentation } from "eve/instrumentation";
import { store } from "../lib/store";

// Provider calls include retries and specialist calls; protocol step totals do not.
export default defineInstrumentation({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
  events: {
    "model.call.completed": (event) => {
      const s = store();
      const { sessionId, turnId, stepIndex } = event.scope;
      const cost = event.usage.costUsd;
      if (cost !== undefined) {
        s.recordUsage(event.idempotencyKey, cost);
        s.set(`priced.step:${sessionId}:${turnId}:${stepIndex}`, true);
      }
      s.event(
        "model.call",
        {
          sessionId,
          cost: cost ?? null,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        },
        event.idempotencyKey,
      );
    },
  },
});
