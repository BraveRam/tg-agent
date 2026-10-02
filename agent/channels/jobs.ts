import { defineChannel, POST, GET } from "eve/channels";
import { z } from "zod";
import { store } from "../lib/store";
import { config } from "../lib/config";
import { internalRequest } from "../lib/security";
export default defineChannel({
  routes: [
    POST("/internal/jobs/:runId", async (request, { params, from, resolveSession }) => {
      if (!internalRequest(request)) return new Response("Unauthorized", { status: 401 });
      const s = store();
      const id = params.runId;
      let active;
      try {
        active = s.activeRun(id);
      } catch {
        return Response.json({ error: "Run inactive" }, { status: 409 });
      }
      if (!s.budgetAvailable()) return Response.json({ error: "Budget reached" }, { status: 429 });
      const existing = await resolveSession(id);
      if (existing) {
        s.runState(id, "running", existing.id);
        return Response.json({ sessionId: existing.id });
      }
      const mode = s.get<string>("run.mode:" + id, "news");
      const session = await from(id).send(
        `Execute saved ${mode} run ${id}. Read authoritative job settings from injected context. ${mode === "correction" ? "Review source updates against your recorded posts and make evidenced corrections or retractions." : "Research new material, review relevant previous posts for corrections, and publish only worthwhile nonduplicate content."} Use no_reply when nothing needs publishing.`,
        {
          auth: {
            authenticator: "internal-job",
            principalId: config().ownerId,
            principalType: "user",
            attributes: { runId: id, jobId: active.job.id },
          },
        },
      );
      s.runState(id, "running", session.id);
      return Response.json({ sessionId: session.id });
    }),
    POST("/internal/sources", async (request) => {
      if (!internalRequest(request)) return new Response("Unauthorized", { status: 401 });
      const body = z
        .object({
          source: z.string(),
          messages: z.array(
            z
              .object({ id: z.number().int(), text: z.string(), deleted: z.boolean().optional() })
              .passthrough(),
          ),
        })
        .parse(await request.json());
      const s = store();
      const previous = s.sourceMessages(body.source);
      const changed = body.messages.filter((m) =>
        previous.some((old) => old.id === m.id && (old.text !== m.text || m.deleted)),
      );
      s.source(body.source, body.messages);
      if (changed.length) {
        for (const j of s.jobs())
          if (j.sources.some((src) => src.kind === "telegram" && src.reference === body.source))
            s.set("correction.pending:" + j.id, true);
        s.event("source.changed", { source: body.source, messageIds: changed.map((m) => m.id) });
      }
      return Response.json({ ok: true });
    }),
    GET("/internal/sources", async (request) => {
      if (!internalRequest(request)) return new Response("Unauthorized", { status: 401 });
      const s = store();
      return Response.json({
        sources: [
          ...new Set(
            s
              .jobs()
              .filter((j) => j.enabled)
              .flatMap((j) =>
                j.sources.filter((src) => src.kind === "telegram").map((src) => src.reference),
              ),
          ),
        ].map((source) => ({
          source,
          cursor: s.get("source.cursor:" + source, 0),
          trackedIds: [
            ...new Set(
              s
                .publications()
                .flatMap((p) =>
                  p.evidence
                    .filter(
                      (e) =>
                        e.sourceMessageId &&
                        (e.sourceChatId === source ||
                          e.url.includes("t.me/" + source.replace("@", "") + "/")),
                    )
                    .map((e) => e.sourceMessageId!),
                ),
            ),
          ],
        })),
      });
    }),
  ],
  events: {
    "turn.completed": async (_event, channel, ctx) => {
      const id = ctx.session.auth.current?.attributes?.runId;
      if (typeof id === "string") {
        const s = store();
        s.runState(id, "completed");
        const fingerprint = s.get("run.fingerprint:" + id, "");
        if (fingerprint) s.set("job.fingerprint:" + s.run(id).jobId, fingerprint);
      }
    },
    "turn.failed": async (_event, _channel, ctx) => {
      const id = ctx.session.auth.current?.attributes?.runId;
      if (typeof id === "string") store().runState(id, "failed");
    },
  },
});
