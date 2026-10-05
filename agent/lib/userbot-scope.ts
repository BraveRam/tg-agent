import { createHmac } from "node:crypto";

import { config } from "./config";
import { requireOwner } from "./security";
import { store } from "./store";

export function signUserbotScope(claims: Record<string, unknown>) {
  const token = config().internalToken;

  if (!token) throw new Error("Userbot signing credential missing");

  const body = Buffer.from(
    JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 300 }),
  ).toString("base64url");

  return body + "." + createHmac("sha256", token).update(body).digest("base64url");
}

export function userbotScope(ctx: any) {
  const auth = requireOwner(ctx);
  const s = store();
  const runId = auth.attributes?.runId;
  const active = typeof runId === "string" ? s.activeRun(runId) : null;
  const refs = active
    ? active.job.sources
        .filter((source) => source.kind === "telegram")
        .map((source) => source.reference)
    : s.sources().flatMap((source) => [source.reference, ...source.aliases]);
  const sourceRecords = s
    .sources()
    .filter(
      (source) =>
        refs.includes(source.reference) || source.aliases.some((alias) => refs.includes(alias)),
    );
  const channels = [
    ...refs,
    ...sourceRecords.flatMap((source) => [source.chatId, ...source.aliases].filter(Boolean)),
    ...(active ? [active.channel.chatId] : s.channels().map((channel) => channel.chatId)),
  ];

  return signUserbotScope({ channels });
}
