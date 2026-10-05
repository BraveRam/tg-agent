import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import type config from "./evals.config";

export default defineEval<typeof config>({
  description: "Natural-language creation, twice-daily clock times, configured sources, and pause",

  async test(t) {
    await t.send(
      `Use registered channel ${t.context.channel.id}. Create an AI news job at 07:00 and 15:00 every day in Africa/Nairobi. Use @ai_source as the source. Keep occasional photos.`,
    );
    t.calledTool("jobs", { input: { action: "create" } });

    const saved = t.context.s.jobs()[0];

    t.check(saved?.sources[0]?.reference, equals("@ai_source"));
    t.check(
      saved?.schedule,
      equals({ kind: "calendar", times: ["07:00", "15:00"], timezone: "Africa/Nairobi" }),
    );
    await t.send(`Pause saved job ${saved?.id}.`);
    t.check(t.context.s.job(saved.id).enabled, equals(false));
    t.succeeded();
  },
});
