import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { config } from "../lib/config";
import { userbotScope } from "../lib/userbot-scope";

export default defineTool({
  description:
    "Download photo, video or document from a configured source or destination CHANNEL message into the sandbox. Not for incoming owner private-chat attachments: use telegram_api getFile with injected incomingAttachments file_id and downloadTo for those. Protected channel media is unavailable.",
  inputSchema: z.object({
    channel: z.string(),
    messageId: z.number().int().positive(),
    path: z.string(),
  }),

  async execute({ channel, messageId, path }, ctx) {
    if ([config().ownerId, "telegram", "private"].includes(channel))
      throw new Error(
        "Private-chat attachments use telegram_api getFile with incomingAttachments file_id and downloadTo; source_media reads channels only",
      );

    const response = await fetch(`http://127.0.0.1:${config().userbotPort}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer " + userbotScope(ctx) },
      body: JSON.stringify({ channel, messageId }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) throw new Error("Source media is unavailable or outside caller scope");

    const media = await response.json();

    if (!/^[0-9a-f-]{36}\.[a-zA-Z0-9]+$/.test(media.fileId))
      throw new Error("Invalid media handle");

    const bytes = await readFile(join(config().dataDir, "media", media.fileId));

    if (bytes.length > 50 * 1024 * 1024) throw new Error("Media exceeds 50 MB");

    await (await ctx.getSandbox()).writeBinaryFile({ path, content: bytes });

    return { path, mediaType: media.mediaType, bytes: bytes.length };
  },
});
