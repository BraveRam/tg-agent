import { defineTool } from "eve/tools";
import { z } from "zod";

import { config } from "../lib/config";
import { requirePrivateControl } from "../lib/telegram-api";
import { store } from "../lib/store";
import { signUserbotScope } from "../lib/userbot-scope";

export default defineTool({
  availableInSubagents: false,
  description:
    "List, monitor, join or stop monitoring source channels. In the owner's private chat, join/monitor directly as needed to fulfill the task; no separate confirmation is required. Public usernames and private invite links accepted. stop preserves membership. Return actual saved membership and monitoring status.",
  inputSchema: z.object({
    action: z.enum(["list", "monitor", "join", "stop"]),
    reference: z.string().optional(),
  }),

  async execute(input, ctx) {
    requirePrivateControl(ctx);

    const s = store();

    if (input.action === "list") return s.sources();

    if (!input.reference) throw new Error("Source reference required");

    if (input.action === "stop")
      return s.saveSource({ reference: input.reference, monitoring: false });

    const old = s
      .sources()
      .find(
        (source) =>
          source.reference === input.reference || source.aliases.includes(input.reference!),
      );

    if (old && ["joined", "awaiting_approval"].includes(old.membership))
      return s.saveSource({ reference: old.reference, monitoring: true });

    s.saveSource({
      reference: old?.reference ?? input.reference,
      monitoring: true,
      membership: "joining",
    });

    try {
      const response = await fetch(`http://127.0.0.1:${config().userbotPort}/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer " + signUserbotScope({ channels: [], join: input.reference }),
        },
        body: JSON.stringify({ channel: input.reference }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) throw new Error("Joining rejected");

      const result = await response.json();

      return s.saveSource({
        reference: old?.reference ?? input.reference,
        ...result,
        monitoring: true,
      });
    } catch {
      s.saveSource({ reference: old?.reference ?? input.reference, membership: "failed" });
      throw new Error("Joining failed; inspect source status and worker health before retrying");
    }
  },
});
