import { otel } from "eve/instrumentation/otel";

// Local traces contain metadata, not private conversations, credentials or source payloads.
export default otel({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
});
