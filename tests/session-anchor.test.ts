import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

const { HookNotFoundError } = await import(
  "../node_modules/eve/dist/src/compiled/@workflow/errors/index.js" as string
);

const { signalSessionAnchorStep } = await import(
  "../node_modules/eve/dist/src/execution/session/handoff-steps.js" as string
);

test("missing session anchors settle only when the original workflow is terminal", async () => {
  const token = "wrun_original:anchor";
  const input = { token, result: { output: "" } };
  let status = "cancelled";
  let failure: Error | null = new HookNotFoundError(token);
  const reads: string[] = [];
  const signals: unknown[] = [];
  // Execute the installed patched step with controlled I/O, without the SDK's
  // host-specific waitUntil integration or touching live workflow storage.
  const signal = runInNewContext(`(${signalSessionAnchorStep.toString()})`, {
    HookNotFoundError,
    resumeHook: async (...args: unknown[]) => {
      signals.push(args);

      if (failure) throw failure;
    },
    getRun: (id: string) => {
      reads.push(id);

      return { status: Promise.resolve(status) };
    },
  });

  for (status of ["cancelled", "completed", "failed"]) await signal(input);

  assert.deepEqual(reads, Array(3).fill("wrun_original"));

  for (status of ["pending", "running"])
    await assert.rejects(signal(input), (error: unknown) => error === failure);

  failure = new Error("Storage unavailable");
  await assert.rejects(signal(input), (error: unknown) => error === failure);
  assert.equal(reads.length, 5);
  failure = new HookNotFoundError("not-an-anchor");
  await assert.rejects(
    signal({ ...input, token: "not-an-anchor" }),
    (error: unknown) => error === failure,
  );
  assert.equal(reads.length, 5);
  failure = null;
  await signal(input);
  assert.equal(reads.length, 5);
  assert.deepEqual(signals.at(-1), [token, input.result]);
});
