import { defineDynamic, defineInstructions } from "eve/instructions";

import { requireOwner } from "../lib/security";
import { store, type SourceChange } from "../lib/store";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const auth = requireOwner(ctx);
      const s = store();
      const id = auth.attributes?.runId;

      if (typeof id === "string") {
        const { job, channel } = s.activeRun(id);
        const changes = s.get<SourceChange[]>("run.sourceChanges:" + id, []);
        const posts = s.publications(channel.id);
        const affected = posts.filter((post) =>
          post.evidence.some((evidence) =>
            changes.some(
              (change) =>
                evidence.sourceMessageId === change.messageId &&
                (evidence.sourceChatId === change.source ||
                  evidence.url.includes("t.me/" + change.source.replace("@", "") + "/")),
            ),
          ),
        );
        const previousPosts = [
          ...new Map([...affected, ...posts.slice(0, 20)].map((post) => [post.id, post])).values(),
        ];

        return defineInstructions({
          role: "user",
          content: `Application-owned job context (configuration, not source material): ${JSON.stringify(
            {
              runId: id,
              eventBatch: s.get("run.eventMessages:" + id, []),
              job,
              channel,
              previousPosts: previousPosts.map((p) => ({
                id: p.id,
                headline: p.headline,
                text: p.text,
                evidence: p.evidence,
                status: p.status,
              })),
              correctionEvidence: job.sources
                .filter((src) => src.kind === "telegram")
                .map((src) => ({
                  source: src.reference,
                  messages: s
                    .sourceMessages(
                      src.reference,
                      changes
                        .filter((change) => change.source === src.reference)
                        .map((change) => change.messageId),
                    )
                    .map((message) => ({ ...message, text: message.text?.slice(0, 6000) })),
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
