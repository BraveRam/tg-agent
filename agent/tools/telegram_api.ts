import { defineTool } from "eve/tools";
import { z } from "zod";

import { executeTelegramApi } from "../lib/telegram-api";

export default defineTool({
  availableInSubagents: false,
  description:
    "Call a documented Telegram Bot API method by name and parameters. First use action=describe with the method to inspect current parameters and nested types when unfamiliar; then action=call (default) with params. Validation errors mean nothing was sent: correct the indicated fields and retry. Owner private conversation only; target your chat or registered channels. Credentials are injected outside the sandbox. Upload sandbox files using files and attach://name in params. getFile supports downloadTo. Never repeat an uncertain mutation. Scheduled publishing uses publications instead.",
  inputSchema: z.object({
    action: z.enum(["call", "describe"]).default("call"),
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
