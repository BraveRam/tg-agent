import { defineTool } from "eve/tools";
import { z } from "zod";

import { executeTelegramApi } from "../lib/telegram-api";

export default defineTool({
  availableInSubagents: false,
  description:
    "Call a documented Telegram Bot API method by name and parameters. Owner private conversation only; target your chat or registered channels. Credentials are injected outside the sandbox. Consult https://core.telegram.org/bots/api for method parameters. Upload sandbox files using files and attach://name in params. getFile supports downloadTo. Never repeat an uncertain mutation. Scheduled publishing uses publications instead.",
  inputSchema: z.object({
    method: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
    files: z
      .record(
        z.string(),
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
