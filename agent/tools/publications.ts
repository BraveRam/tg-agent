import { defineTool } from "eve/tools";
import { z } from "zod";

import { store } from "../lib/store";
import { assertRun, requireOwner, runId } from "../lib/security";
import {
  enqueuePost,
  deliverPublication,
  verifyPublication,
  reconcilePublication,
  revisePublication,
} from "../lib/publishing";

const media = z.object({
  url: z.string().url().optional(),
  sourceChatId: z.string().optional(),
  sourceMessageId: z.number().int().optional(),
});

export default defineTool({
  availableInSubagents: false,
  description:
    "List prior posts (newest first; paginate with limit/offset), publish text/photos/albums exactly as supplied, verify/reconcile Telegram delivery, or edit/delete a recorded post at the owner's request. Never resend an uncertain post. Scheduled posts are restricted to the current job destination; scheduled runs cannot edit or delete posts.",
  inputSchema: z.object({
    action: z.enum(["list", "publish", "verify", "reconcile", "edit", "delete"]),
    channelId: z.string().optional(),
    id: z.string().optional(),
    headline: z.string().optional(),
    text: z.string().optional(),
    media: z.array(media).max(10).optional(),
    reason: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),

  async execute(input, ctx) {
    requireOwner(ctx);

    const s = store();
    const rid = runId(ctx);

    if (rid) assertRun(ctx);

    if (input.action === "list") {
      if (rid) return s.publications(s.activeRun(rid).channel.id, input.limit ?? 100, input.offset);

      return s.publications(input.channelId, input.limit ?? 100, input.offset);
    }

    if (input.action === "publish") {
      if (!input.channelId || !input.headline || !input.text)
        throw new Error("Destination, headline and text required");

      const p = enqueuePost(
        {
          channelId: input.channelId,
          headline: input.headline,
          text: input.text,
          media: input.media ?? [],
        },
        rid,
      );

      await deliverPublication(p.id);

      return s.publication(p.id);
    }

    if (!input.id) throw new Error("Publication ID required");

    if (rid && s.publication(input.id).channelId !== s.activeRun(rid).channel.id)
      throw new Error("Wrong job destination");

    if (input.action === "verify") {
      await verifyPublication(input.id);

      return s.publication(input.id);
    }

    if (input.action === "reconcile") {
      await reconcilePublication(input.id);

      return s.publication(input.id);
    }

    if (rid) throw new Error("Only owner conversations may edit or delete posts");

    if (!input.reason) throw new Error("Reason required");

    const key = `revision:${ctx.session.id}:${ctx.callId}`;

    if (s.get(key, false)) return s.publication(input.id);

    s.set(key, true);
    await revisePublication(input.id, input.action, input.reason, input.text);

    return s.publication(input.id);
  },
});
