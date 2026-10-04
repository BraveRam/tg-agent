import { defineHook } from "eve/hooks";

import { activityText, sendActivity } from "../lib/activity";

export function activityHook(deliver: typeof sendActivity = sendActivity) {
  return defineHook({
    events: {
      "message.completed": async (event, ctx) => {
        const { turnId, stepIndex, sequence, message } = event.data;

        await deliver(ctx, `message:${turnId}:${stepIndex}:${sequence}`, message);
      },
      "actions.requested": async (event, ctx) => {
        for (const action of event.data.actions) {
          const name =
            "toolName" in action ? action.toolName : "name" in action ? action.name : action.kind;
          const input = "input" in action ? action.input : action;

          await deliver(ctx, `call:${action.callId}`, `🔧 ${name}\n${activityText(input)}`);
        }
      },
      "action.result": async (event, ctx) => {
        const { result, status, error } = event.data;
        const name =
          "toolName" in result
            ? result.toolName
            : "subagentName" in result
              ? result.subagentName
              : (result.name ?? result.kind);

        await deliver(
          ctx,
          `result:${result.callId}`,
          `${status === "completed" ? "✅" : "❌"} ${name}: ${status}${error ? "\n" + activityText(error.message) : ""}`,
        );
      },
      "task.started": async (event, ctx) => {
        await deliver(ctx, `task-start:${event.data.callId}`, `▶️ ${event.data.name}: started`);
      },
      "task.settled": async (event, ctx) => {
        const { callId, name, status } = event.data;

        await deliver(
          ctx,
          `task:${callId}`,
          `${status === "completed" ? "✅" : "❌"} ${name ?? "Task"}: ${status}`,
        );
      },
    },
  });
}

export default activityHook();
