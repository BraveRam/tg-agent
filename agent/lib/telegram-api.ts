import { createHash } from "node:crypto";

import type { ToolContext } from "eve/tools";

import methods from "./bot-methods";
import { config } from "./config";
import { activityText } from "./activity";
import { requireControl } from "./security";
import { store, type Store } from "./store";
import { bot, TelegramError } from "./telegram";

export type ApiTransport = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiInput {
  method: string;
  params: Record<string, unknown>;
  files?: Record<string, { path: string; filename?: string; contentType?: string }>;
  downloadTo?: string;
}

const blocked = new Set(["getupdates", "setwebhook", "deletewebhook", "close", "logout"]);

const opaque =
  /^(inline_message_id|business_connection_id|managed_bot_id|guest_query_id|inline_query_id|shipping_query_id|pre_checkout_query_id|callback_query_id|chat_join_request_query_id|web_app_query_id|suggested_post_parameters)$/;

export function requirePrivateControl(ctx: any) {
  const auth = requireControl(ctx);

  if (
    auth.authenticator !== "telegram" ||
    auth.attributes?.privateChat !== "true" ||
    ctx.session.parent
  )
    throw new Error("Only the owner's private Telegram conversation may use this capability");

  return auth;
}

export async function executeTelegramApi(
  input: ApiInput,
  ctx: ToolContext,
  s: Store = store(),
  transport: ApiTransport = fetch,
  resolveChat: (reference: string) => Promise<string> = async (reference) =>
    String((await bot("getChat", { chat_id: reference })).id),
) {
  requirePrivateControl(ctx);

  const { method } = input;

  if (!methods.has(method) || blocked.has(method.toLowerCase()))
    throw new Error("Unknown or application-owned Bot API method");

  const params: any = structuredClone(input.params);
  const destinations = new Set([
    config().ownerId,
    ...s.channels().map((channel) => channel.chatId),
  ]);
  const sources = new Set([
    ...destinations,
    ...s
      .sources()
      .flatMap(
        (source) =>
          [source.reference, source.chatId, ...source.aliases].filter(Boolean) as string[],
      ),
  ]);
  let hasChat = false;

  async function targets(value: any) {
    if (!value || typeof value !== "object") return;

    for (const [key, original] of Object.entries(value)) {
      let item = original;

      // Telegram accepts serialized JSON for these scopes. Inspect it before authorizing targets.
      if (
        ["scope", "reply_parameters", "ephemeral_message_parameters"].includes(key) &&
        typeof item === "string"
      ) {
        try {
          item = value[key] = JSON.parse(item);
        } catch {
          // Invalid JSON cannot authorize an action; Telegram will return its parse error.
        }
      }

      if (opaque.test(key)) throw new Error("Indirect target cannot be verified");

      if (key.endsWith("chat_id")) {
        const reference = String(item);
        const id = /^-?\d+$/.test(reference) ? reference : await resolveChat(reference);
        const allowed = key === "from_chat_id" ? sources : destinations;

        if (!allowed.has(id)) throw new Error("Telegram chat is not registered for this operation");

        value[key] = id;

        if (key === "chat_id") hasChat = true;
      } else await targets(item);
    }
  }

  await targets(params);

  function users(value: any) {
    if (!value || typeof value !== "object") return;

    for (const [key, item] of Object.entries(value)) {
      if (
        (key === "receiver_user_id" || (key === "user_id" && !hasChat)) &&
        String(item) !== config().ownerId
      )
        throw new Error("Unscoped user target is not the owner");

      if (
        key.endsWith("user_ids") &&
        (!Array.isArray(item) || item.some((id) => String(id) !== config().ownerId))
      )
        throw new Error("Unscoped user collection cannot be verified");

      users(item);
    }
  }

  users(params);

  if (input.downloadTo && method !== "getFile")
    throw new Error("downloadTo is only valid for getFile");

  const operation = `telegram-api:${ctx.session.id}:${ctx.callId}`;
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const prior = s.get<any>(operation, null);

  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new Error("Operation key reused with different input");

    if (["sent", "uncertain", "sending"].includes(prior.status))
      return prior.status === "sending" ? { ...prior, status: "uncertain" } : prior;

    if (prior.retryAt > Date.now()) return prior;
  }

  const readOnly = method.startsWith("get");
  const form = new FormData();
  const attachments = input.files ?? {};

  for (const [name, file] of Object.entries(attachments)) {
    if (Object.hasOwn(params, name))
      throw new Error("Attachment alias collides with a parameter; choose a unique name");

    if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("Invalid attachment name");

    const bytes = await (await ctx.getSandbox()).readBinaryFile({ path: file.path });

    if (!bytes || bytes.length > 50 * 1024 * 1024) throw new Error("File missing or exceeds 50 MB");

    form.set(
      name,
      new Blob([Buffer.from(bytes)], { type: file.contentType ?? "application/octet-stream" }),
      file.filename ?? file.path.split("/").pop() ?? name,
    );
  }

  function attachmentsValid(value: any) {
    if (
      typeof value === "string" &&
      value.startsWith("attach://") &&
      !Object.hasOwn(attachments, value.slice(9))
    )
      throw new Error("Attachment reference has no sandbox file");

    if (value && typeof value === "object") Object.values(value).forEach(attachmentsValid);
  }

  attachmentsValid(params);

  for (const [key, value] of Object.entries(params))
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));

  const claimed =
    !readOnly &&
    s.transaction(() => {
      const current = s.get<any>(operation, null);

      if (current && ["sending", "sent", "uncertain"].includes(current.status)) return current;

      s.set(operation, { status: "sending", fingerprint });

      return null;
    });

  if (claimed) return claimed;

  let telegramFailure: Record<string, unknown> = {};

  try {
    let response: Response;

    try {
      response = await transport(`https://api.telegram.org/bot${config().botToken}/${method}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        ...(Object.keys(attachments).length
          ? { body: form }
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) }),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;

      telegramFailure.transportError = activityText(
        cause instanceof Error
          ? { name: cause.name, message: cause.message, code: (cause as any).code }
          : error instanceof Error
            ? error.message
            : String(error),
      );
      throw new TelegramError("Telegram response lost", true);
    }

    let payload: any;

    try {
      payload = await response.json();
    } catch {
      throw new TelegramError("Unreadable Telegram response", true);
    }

    if (!payload.ok) {
      telegramFailure = JSON.parse(
        activityText({
          errorCode: payload.error_code ?? response.status,
          parameters: payload.parameters ?? {},
        }),
      );

      throw new TelegramError(
        activityText(payload.description ?? "Telegram rejected request"),
        response.status >= 500,
        payload.parameters?.retry_after ?? 0,
      );
    }

    let result = JSON.parse(activityText(payload.result));

    if (input.downloadTo) {
      if (
        !result.file_path ||
        !/^[\w./-]+$/.test(result.file_path) ||
        result.file_path.split("/").includes("..")
      )
        throw new Error("Invalid Telegram file path");

      const downloaded = await transport(
        `https://api.telegram.org/file/bot${config().botToken}/${result.file_path}`,
        { redirect: "error", signal: AbortSignal.timeout(30000) },
      );

      if (!downloaded.ok) throw new Error("Telegram file download failed");

      if (Number(downloaded.headers.get("content-length")) > 50 * 1024 * 1024)
        throw new Error("Download exceeds 50 MB");

      const bytes = new Uint8Array(await downloaded.arrayBuffer());

      if (bytes.length > 50 * 1024 * 1024) throw new Error("Download exceeds 50 MB");

      await (await ctx.getSandbox()).writeBinaryFile({ path: input.downloadTo, content: bytes });
      result = { ...result, sandboxPath: input.downloadTo };
    }

    const saved = { status: "sent", result, fingerprint };

    if (!readOnly) s.set(operation, saved);

    return saved;
  } catch (error) {
    const uncertain = !readOnly && (!(error instanceof TelegramError) || error.ambiguous);
    const saved = {
      status: uncertain ? "uncertain" : "failed",
      ...telegramFailure,
      error: activityText(
        error instanceof TelegramError ? error.message : "Telegram operation failed",
      ),
      retryAfter: error instanceof TelegramError ? error.retryAfter : 0,
      fingerprint,
      autoRetry: false,
      ...(uncertain
        ? {
            recovery:
              "Check delivery before attempting another send. No automatic retry is scheduled.",
          }
        : { retryAt: Date.now() + (error instanceof TelegramError ? error.retryAfter : 0) * 1000 }),
    };

    if (!readOnly) s.set(operation, saved);

    return saved;
  }
}
