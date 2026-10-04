import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ToolContext } from "eve/tools";

import { config } from "./config";
import { requireControl } from "./security";
import { store, type Store } from "./store";
import { bot, TelegramError } from "./telegram";

export async function sendOwnerImage(
  ctx: ToolContext,
  path: string,
  caption?: string,
  s: Store = store(),
  send: typeof bot = bot,
) {
  requireControl(ctx);

  if (!config().ownerId) throw new Error("Telegram owner is not configured");

  const key = `owner-image:${ctx.session.id}:${ctx.callId}`;
  const prior = s.get<any>(key, null);

  if (prior?.status === "sent" || prior?.status === "uncertain" || prior?.status === "sending")
    return prior;

  const bytes = await (await ctx.getSandbox()).readBinaryFile({ path });

  if (!bytes || !bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new Error("Image must contain data and be at most 10 MB");

  const extension = Buffer.from(bytes.subarray(0, 8)).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )
    ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "jpg"
      : null;

  if (!extension) throw new Error("Only PNG and JPEG images can be sent");

  const filename = `${randomUUID()}.${extension}`;
  const directory = join(config().dataDir, "media");
  const localPath = join(directory, filename);
  const hash = createHash("sha256").update(bytes).digest("hex");

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(localPath, bytes, { mode: 0o600 });

  try {
    const claimed = s.transaction(() => {
      const current = s.get<any>(key, null);

      if (current && current.status !== "failed") return current;

      s.set(key, { status: "sending", hash });

      return null;
    });

    if (claimed) return claimed;

    try {
      const result = await send("sendPhoto", {
        chat_id: config().ownerId,
        photo: `tg-media:${filename}`,
        ...(caption ? { caption } : {}),
      });
      const saved = { status: "sent", messageId: result.message_id, hash };

      s.set(key, saved);

      return saved;
    } catch (error) {
      const uncertain = !(error instanceof TelegramError) || error.ambiguous;

      s.set(key, { status: uncertain ? "uncertain" : "failed", hash });

      if (!uncertain) throw error;

      return { status: "uncertain", hash, detail: "Delivery acknowledgment lost; do not resend." };
    }
  } finally {
    await unlink(localPath).catch(() => {});
  }
}
