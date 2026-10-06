import { defineTool } from "eve/tools";
import { z } from "zod";

import { executeTelegramApi } from "../lib/telegram-api";

export default defineTool({
  availableInSubagents: false,
  description:
    "Call a documented Telegram Bot API method by name and params. Consult https://core.telegram.org/bots/api with web tools when needed. Telegram validates parameters; its errors, errorCode and response parameters are returned. On a definite rejection, research and correct the request before making a new tool call; honor retryAfter. Owner private conversation only; target your chat or registered channels. Credentials are injected outside the sandbox. Upload sandbox files using files and attach://name in params. getFile supports downloadTo; use the file_id from injected incomingAttachments to save owner-uploaded images or PDFs in your sandbox. Never repeat an uncertain mutation. Scheduled publishing uses publications instead.",
  inputSchema: z.object({
    method: z.string(),
    params: z.object({}).catchall(z.unknown()).default({}),
    files: z
      .object({})
      .catchall(
        z.object({
          path: z.string(),
          filename: z.string().optional(),
          contentType: z.string().optional(),
        }),
      )
      .optional(),
    downloadTo: z.string().optional(),
  }),

  execute(input, ctx) {
    return executeTelegramApi(input, ctx);
  },
});
