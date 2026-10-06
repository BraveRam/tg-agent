import { defineInstrumentation } from "eve/instrumentation";

import { store } from "../lib/store";
import { isFreeNvidiaModel } from "../lib/main-model";

// Provider calls include retries and specialist calls; protocol step totals do not.
export default defineInstrumentation({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
  events: {
    "model.call.started": (event) => {
      store().set(`model.attempt:${event.scope.attemptId}`, event.model);
    },
    "model.call.completed": (event) => {
      const s = store();
      const { sessionId, turnId, stepIndex } = event.scope;
      const model = s.get<{ provider: string; modelId: string } | null>(
        `model.attempt:${event.scope.attemptId}`,
        null,
      );
      // Only this explicitly configured NVIDIA free endpoint has a known zero price.
      const cost = event.usage.costUsd ?? (isFreeNvidiaModel(model) ? 0 : undefined);

      if (cost !== undefined) {
        s.recordUsage(event.idempotencyKey, cost);
        s.set(`priced.step:${sessionId}:${turnId}:${stepIndex}`, true);
      }

      s.event(
        "model.call",
        {
          sessionId,
          model,
          cost: cost ?? null,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        },
        event.idempotencyKey,
      );
    },
  },
});
