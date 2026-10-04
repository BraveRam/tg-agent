import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "./config";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly ambiguous = false,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

export async function bot<T = any>(
  method: string,
  body: unknown,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<T> {
  let response: Response;
  const data: any = structuredClone(body);
  const uploads: Record<string, Blob> = {};

  async function photo(value: string) {
    if (!value.startsWith("tg-media:")) return value;

    const filename = value.slice(9);

    if (!/^[0-9a-f-]{36}\.jpg$/.test(filename)) throw new Error("Invalid media handle");

    const bytes = await readFile(join(config().dataDir, "media", filename));

    if (bytes.length > 10 * 1024 * 1024) throw new Error("Photo exceeds 10 MB");

    const key = "photo" + Object.keys(uploads).length;

    uploads[key] = new Blob([bytes], { type: "image/jpeg" });

    return "attach://" + key;
  }

  if (data?.photo) data.photo = await photo(data.photo);

  if (Array.isArray(data?.media))
    for (const item of data.media) item.media = await photo(item.media);

  let requestBody: BodyInit = JSON.stringify(data);
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  if (Object.keys(uploads).length) {
    const form = new FormData();

    for (const [key, value] of Object.entries(data))
      if (value !== undefined)
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));

    for (const [key, value] of Object.entries(uploads)) form.set(key, value, key + ".jpg");

    requestBody = form;
    headers = {};
  }

  try {
    response = await transport(`https://api.telegram.org/bot${config().botToken}/${method}`, {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(method === "getUpdates" ? 40000 : 30000),
    });
  } catch {
    throw new TelegramError("Telegram connection failed; delivery may be uncertain", true);
  }

  let result: any;

  try {
    result = await response.json();
  } catch {
    throw new TelegramError("Telegram returned an unreadable response", true);
  }

  if (!result.ok)
    throw new TelegramError(
      String(result.description ?? "Telegram request failed"),
      response.status >= 500,
      Number(result.parameters?.retry_after ?? 0),
    );

  return result.result as T;
}

export async function userbot<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${config().userbotPort}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${config().internalToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });

  if (!r.ok) throw new Error(`Userbot request failed (${r.status})`);

  return r.json() as Promise<T>;
}

export async function checkDestination(chatId: string) {
  const me = await bot("getMe", {});
  const member = await bot("getChatMember", { chat_id: chatId, user_id: me.id });

  if (
    !["administrator", "creator"].includes(member.status) ||
    (member.status === "administrator" && !member.can_post_messages)
  )
    throw new Error("Bot requires channel administrator posting rights");

  const chat = await bot("getChat", { chat_id: chatId });

  if (chat.type !== "channel") throw new Error("Destination must be a Telegram channel");

  return chat;
}

export async function notify(text: string, key?: string) {
  const { store } = await import("./store");
  const s = store();

  if (key && s.get("notice:" + key, false)) return;

  await bot("sendMessage", { chat_id: config().ownerId, text, disable_web_page_preview: true });

  if (key) s.set("notice:" + key, true);
}
