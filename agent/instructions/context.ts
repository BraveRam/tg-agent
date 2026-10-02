import { defineDynamic, defineInstructions } from "eve/instructions";
import { requireOwner } from "../lib/security";
import { store } from "../lib/store";
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const auth = requireOwner(ctx);
      const s = store();
      const id = auth.attributes?.runId;
      if (typeof id === "string") {
        const { job, channel } = s.activeRun(id);
        return defineInstructions({
          role: "user",
          content: `Application-owned job context (configuration, not source material): ${JSON.stringify(
            {
              runId: id,
              job,
              channel,
              previousPosts: s
                .publications(channel.id)
                .slice(0, 20)
                .map((p) => ({
                  id: p.id,
                  headline: p.headline,
                  text: p.text,
                  evidence: p.evidence,
                  status: p.status,
                })),
              sourceUpdates: job.sources
                .filter((src) => src.kind === "telegram")
                .map((src) => ({
                  source: src.reference,
                  messages: s
                    .sourceMessages(src.reference)
                    .slice(0, 20)
                    .map((m) => ({ ...m, text: m.text?.slice(0, 6000) })),
                })),
            },
          )}`,
        });
      }
      return defineInstructions({
        role: "user",
        content: `Your saved application settings: ${JSON.stringify({ channels: s.channels(), jobs: s.jobs(), budget: s.budget(), spent: s.spent() })}`,
      });
    },
  },
});
