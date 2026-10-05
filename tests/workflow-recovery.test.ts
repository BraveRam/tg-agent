import { test } from "node:test";
import assert from "node:assert/strict";

const { reenqueueActiveDevelopmentRuns } = await import(
  "../node_modules/eve/dist/src/internal/workflow/development-world-server.js" as string
);

test("dev recovery resumes interrupted steps and skips settled work and unavailable generations", async () => {
  const calls: unknown[] = [];
  const stepReads: string[] = [];

  await reenqueueActiveDevelopmentRuns({
    prefix: "local_",
    canRecover: async (id: string) => id === "retained",
    enqueue: async (topic: string, payload: unknown) => calls.push([topic, payload]),
    world: {
      runs: {
        list: async ({ status }: { status: string }) => ({
          data:
            status === "running"
              ? [
                  { runId: "chat", deploymentId: "retained", workflowName: "session" },
                  { runId: "old", deploymentId: "missing", workflowName: "session" },
                ]
              : [],
          hasMore: false,
        }),
      },
      steps: {
        list: async ({ runId, pagination }: any) => {
          stepReads.push(runId);

          return pagination.cursor
            ? { data: [{ stepId: "queued", stepName: "turn", status: "pending" }], hasMore: false }
            : {
                data: [
                  { stepId: "model", stepName: "turn", status: "running" },
                  { stepId: "sent", stepName: "publish", status: "completed" },
                  { stepId: "error", stepName: "turn", status: "failed" },
                  { stepId: "stopped", stepName: "turn", status: "cancelled" },
                ],
                hasMore: true,
                cursor: "next",
              };
        },
      },
    },
  });

  assert.deepEqual(stepReads, ["chat", "chat"]);
  assert.deepEqual(calls, [
    ["local_session", { runId: "chat" }],
    ["local_session", { runId: "chat", stepId: "model", stepName: "turn" }],
    ["local_session", { runId: "chat", stepId: "queued", stepName: "turn" }],
  ]);
});
