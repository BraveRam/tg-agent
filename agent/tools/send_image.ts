import { defineTool } from "eve/tools";
import { z } from "zod";

import { sendOwnerImage } from "../lib/owner-image";

export default defineTool({
  description:
    "Send a PNG or JPEG file from your sandbox to the owner's private Telegram chat. Use this after browser__screenshot when asked to send a screenshot here, or to share generated images. Returns actual delivery status. Does not post to channels.",
  availableInSubagents: false,
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Sandbox file path, such as the path returned by browser__screenshot."),
    caption: z.string().max(1024).optional(),
  }),

  async execute({ path, caption }, ctx) {
    return sendOwnerImage(ctx, path, caption);
  },
});
