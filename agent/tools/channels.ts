import { defineTool } from "eve/tools";
import { z } from "zod";

import { channelSchema } from "../lib/types";
import { store } from "../lib/store";
import { requireControl } from "../lib/security";
import { bot, checkDestination } from "../lib/telegram";

export default defineTool({
  availableInSubagents: false,
  description:
    "List, register or update your destination channels. Register by Telegram @username or numeric chat ID. Return saved settings.",
  inputSchema: z.object({
    action: z.enum(["list", "save"]),
    reference: z.string().optional(),
    settings: channelSchema.omit({ chatId: true }).optional(),
  }),

  async execute(input, ctx) {
    requireControl(ctx);

    if (input.action === "list") return store().channels();

    if (!input.reference || !input.settings)
      throw new Error("Channel reference and settings required");

    const chat = await bot("getChat", { chat_id: input.reference });

    await checkDestination(String(chat.id));

    return store().saveChannel(channelSchema.parse({ ...input.settings, chatId: String(chat.id) }));
  },
});
