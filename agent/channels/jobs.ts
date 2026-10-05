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
          bootstrap: z.boolean().optional(),
          cursor: z.number().int().nonnegative().optional(),
          messages: z.array(
            z
              .object({ id: z.number().int(), text: z.string(), deleted: z.boolean().optional() })
              .passthrough(),
          ),
        })
        .parse(await request.json());
      const s = store();

      s.source(body.source, body.messages, body.cursor, body.bootstrap);

      return Response.json({ ok: true });
    }),
    POST("/internal/source-state", async (request) => {
      if (!internalRequest(request)) return new Response("Unauthorized", { status: 401 });

      const body = z
        .object({
          reference: z.string(),
          chatId: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          membership: z
            .enum(["unknown", "joining", "awaiting_approval", "joined", "failed"])
            .optional(),
        })
        .parse(await request.json());

      return Response.json(store().saveSource(body));
    }),
    GET("/internal/sources", async (request) => {
      if (!internalRequest(request)) return new Response("Unauthorized", { status: 401 });

      const s = store();

      return Response.json({
        sources: s
          .sources()
          .filter((record) => record.monitoring)
          .map((record) => ({
            chatId: record.chatId,
            membership: record.membership,

            source: record.reference,
            cursor: s.get("source.cursor:" + record.reference, 0),
            trackedIds: [
              ...new Set(
                s
                  .publications()
                  .flatMap((p) =>
                    p.evidence
                      .filter(
                        (e) =>
                          e.sourceMessageId &&
                          (e.sourceChatId === record.reference ||
                            e.url.includes("t.me/" + record.reference.replace("@", "") + "/")),
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
