import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireControl } from "../lib/security";
import { store } from "../lib/store";
import { bot, checkDestination, userbot, TelegramError } from "../lib/telegram";

export default defineTool({
  description:
    "Explicit owner-directed edit or deletion of an existing message in a registered channel, including posts not in the publication ledger. Obtain the exact channel/message ID from the owner or readback. Unavailable to scheduled jobs.",
  availableInSubagents: false,
  inputSchema: z.object({
    channelId: z.string(),
    messageId: z.number().int().positive(),
    action: z.enum(["edit_text", "edit_caption", "delete"]),
    text: z.string().optional(),
  }),

  async execute(input, ctx) {
    requireControl(ctx);

    const s = store(),
      channel = s.channel(input.channelId),
      key = `owner-action:${ctx.session.id}:${ctx.callId}`;

    if (input.action !== "delete" && !input.text) throw new Error("Replacement text required");

    const prior = s.get<any>(key, null);

    if (prior?.status === "verified") return prior;

    if (!prior) {
      await checkDestination(channel.chatId);
      s.set(key, { status: "sending", input });

      try {
        await bot(
          input.action === "delete"
            ? "deleteMessage"
            : input.action === "edit_caption"
              ? "editMessageCaption"
              : "editMessageText",
          {
            chat_id: channel.chatId,
            message_id: input.messageId,
            ...(input.action === "edit_caption" ? { caption: input.text } : { text: input.text }),
          },
        );
      } catch (error) {
        if (!(error instanceof TelegramError && error.ambiguous)) {
          s.set(key, { status: "failed" });
          throw error;
        }
      }
    }

    let status = "uncertain";

    try {
      const { messages } = await userbot<{ messages: any[] }>("/messages", {
        channel: channel.chatId,
        ids: [input.messageId],
      });

      if (
        input.action === "delete"
          ? !messages.length
          : messages.length === 1 && messages[0].text === input.text
      )
        status = "verified";
    } catch {}

    const result = {
      status,
      channelId: channel.id,
      messageId: input.messageId,
      action: input.action,
    };

    s.set(key, result);
    s.event("owner.message.changed", result);

    return result;
  },
});
