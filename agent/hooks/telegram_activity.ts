import { defineHook } from "eve/hooks";

import { sendActivity } from "../lib/activity";
import { closeToolBatch, updateToolActivity } from "../lib/tool-activity";

export function activityHook(
  deliver: typeof sendActivity = sendActivity,
  tools: typeof updateToolActivity = updateToolActivity,
  close: typeof closeToolBatch = closeToolBatch,
) {
  return defineHook({
    events: {
      "message.completed": async (event, ctx) => {
        const { turnId, stepIndex, sequence, message } = event.data;

        await deliver(ctx, `message:${turnId}:${stepIndex}:${sequence}`, message);
        close(ctx, turnId, `message:${turnId}:${stepIndex}:${sequence}`);
      },
      "actions.requested": async (event, ctx) => {
        const calls = event.data.actions.map((action) => {
          const name =
            "toolName" in action ? action.toolName : "name" in action ? action.name : action.kind;
          const input = "input" in action ? action.input : action;

          return { callId: action.callId, name, input };
        });

        await tools(ctx, event.data.turnId, calls);
      },
      "action.result": async (event, ctx) => {
        const { result, status, error } = event.data;

        if (status === "completed" && !result.isError) return;

        const name =
          "toolName" in result
            ? result.toolName
            : "subagentName" in result
              ? result.subagentName
              : (result.name ?? result.kind);

        await tools(ctx, event.data.turnId, [
          {
            callId: result.callId,
            name,
            error: error?.message ?? (status === "completed" ? "Tool reported an error" : status),
          },
        ]);
      },
      "task.started": async (event, ctx) => {
        await tools(ctx, event.data.turnId, [{ callId: event.data.callId, name: event.data.name }]);
      },
      "task.settled": async (event, ctx) => {
        const { callId, name, status } = event.data;

        if (status === "completed") return;

        await tools(ctx, event.data.turnId, [{ callId, name: name ?? "Task", error: status }]);
      },
    },
  });
}

export default activityHook();
