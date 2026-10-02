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
const evidence = z.object({
  url: z.string().url(),
  claim: z.string().min(1),
  sourceMessageId: z.number().int().optional(),
  sourceChatId: z.string().optional(),
});
const media = z.object({
  url: z.string().url().optional(),
  sourceChatId: z.string().optional(),
  sourceMessageId: z.number().int().optional(),
  credit: z.string().min(1),
  reuseAllowed: z.boolean(),
});
export default defineTool({
  availableInSubagents: false,
  description:
    "List prior posts, publish sourced text/photos/albums, verify/reconcile deliveries, or edit/delete a recorded post. For autonomous corrections cite the evidence in reason. Never resend an uncertain post. Media requires permission and attribution. Auto posts are restricted to the current job destination.",
  inputSchema: z.object({
    action: z.enum(["list", "publish", "verify", "reconcile", "edit", "delete"]),
    channelId: z.string().optional(),
    id: z.string().optional(),
    headline: z.string().optional(),
    text: z.string().optional(),
    evidence: z.array(evidence).optional(),
    media: z.array(media).max(10).optional(),
    reason: z.string().optional(),
  }),
  async execute(input, ctx) {
    requireOwner(ctx);
    const s = store();
    const rid = runId(ctx);
    if (rid) assertRun(ctx);
    if (input.action === "list") {
      if (rid) return s.publications(s.activeRun(rid).channel.id);
      return s.publications(input.channelId);
    }
    if (input.action === "publish") {
      if (!input.channelId || !input.headline || !input.text)
        throw new Error("Destination, headline and text required");
      const p = enqueuePost(
        {
          channelId: input.channelId,
          headline: input.headline,
          text: input.text,
          evidence: input.evidence ?? [],
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
    if (!input.reason) throw new Error("Reason required");
    const key = `revision:${ctx.session.id}:${ctx.callId}`;
    if (s.get(key, false)) return s.publication(input.id);
    s.set(key, true);
    await revisePublication(input.id, input.action, input.reason, input.text);
    return s.publication(input.id);
  },
});
