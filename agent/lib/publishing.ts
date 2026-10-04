import { createHash } from "node:crypto";

import { Store, store } from "./store";
import { bot, userbot, checkDestination, notify, TelegramError } from "./telegram";
import type { Post, Publication } from "./types";

export function canonicalUrl(value: string) {
  const u = new URL(value);

  if (!["http:", "https:"].includes(u.protocol))
    throw new Error("Evidence requires public HTTP(S) source links");

  u.hash = "";

  for (const key of [...u.searchParams.keys()])
    if (key.startsWith("utm_") || ["fbclid", "gclid"].includes(key)) u.searchParams.delete(key);

  u.searchParams.sort();

  return u.toString();
}

export function storyKey(post: Post) {
  return createHash("sha256")
    .update(
      post.evidence
        .map((e) => canonicalUrl(e.url))
        .sort()
        .join("|"),
    )
    .digest("hex");
}

export function validatePost(post: Post) {
  if (!post.evidence.length) throw new Error("At least one source is required");

  if (!post.text.trim() || post.text.length > 4096)
    throw new Error("Text must be 1–4096 characters");

  if (post.media.length > 10) throw new Error("At most 10 photos per post");

  for (const media of post.media) {
    if (!media.credit || !media.reuseAllowed)
      throw new Error("Media must include credit and explicit reuse permission");

    if (!media.url && !(media.sourceChatId && media.sourceMessageId))
      throw new Error("Media source is missing");
  }

  for (const e of post.evidence) canonicalUrl(e.url);
}

export function enqueuePost(post: Post, runId: string | null, s = store()) {
  validatePost(post);
  s.channel(post.channelId);

  if (runId) {
    const active = s.activeRun(runId);

    if (active.channel.id !== post.channelId)
      throw new Error("Job cannot publish to a different destination");
  }

  const key = storyKey(post);
  const normalized = post.headline
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const duplicate = s.publications(post.channelId).find(
    (p) =>
      p.storyKey === key ||
      p.headline
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim() === normalized,
  );

  if (duplicate) return duplicate;

  return s.enqueue(post, key, runId);
}

export interface PublisherIO {
  send: (method: string, body: unknown) => Promise<any>;
  read: (chatId: string, ids?: number[]) => Promise<any[]>;
  check: (chatId: string) => Promise<unknown>;
  media: (item: Post["media"][number]) => Promise<string>;
  notice: (text: string, key?: string) => Promise<void>;
}

const defaultIO: PublisherIO = {
  send: bot,
  read: async (chatId, ids) =>
    (
      await userbot<{ messages: any[] }>("/messages", {
        channel: chatId,
        ...(ids ? { ids } : { limit: 30 }),
      })
    ).messages,
  check: checkDestination,
  media: async (m) =>
    m.url ??
    "tg-media:" +
      (await userbot("/media", { channel: m.sourceChatId, messageId: m.sourceMessageId })).fileId,
  notice: notify,
};

function expectedText(p: Publication) {
  let text = p.text;
  const links = [...new Set(p.evidence.map((e) => e.url))];
  const missing = links.filter((link) => !text.includes(link));

  if (missing.length) text += "\n\nSources: " + missing.join("\n");

  if (p.media.length)
    text += "\n\nPhotos: " + [...new Set(p.media.map((m) => m.credit))].join("; ");

  if (text.length > 4096) throw new Error("Post with attribution exceeds Telegram text limit");

  return text;
}

function normalText(t: string) {
  return t.replace(/\r\n/g, "\n").trim();
}

function matches(p: Publication, messages: any[]): boolean {
  if (p.operation === "delete")
    return p.messageIds.every((id) => !messages.some((m) => m.id === id));

  const expected = expectedText(p);
  const ordered = messages
    .filter((m) => !p.messageIds.length || p.messageIds.includes(m.id))
    .sort((a, b) => a.id - b.id);
  const text = ordered
    .map((m) => m.text ?? "")
    .filter(Boolean)
    .join("\n");

  if (normalText(text) !== normalText(expected)) return false;

  if (p.media.length) {
    const photos = ordered.filter((m) => m.hasMedia);

    if (photos.length !== p.media.length) return false;

    if (
      p.media.length > 1 &&
      (!photos[0].groupedId || new Set(photos.map((m) => m.groupedId)).size !== 1)
    )
      return false;
  }

  return true;
}

export async function verifyPublication(id: string, s = store(), io = defaultIO) {
  const p = s.publication(id),
    channel = s.channel(p.channelId);

  try {
    const messages = await io.read(channel.chatId, p.messageIds);

    if (matches(p, messages)) {
      s.updatePublication(id, {
        status: p.operation === "delete" ? "deleted" : "verified",
        error: null,
      });

      return true;
    }

    s.updatePublication(id, {
      status: "unverified",
      retryAt: Date.now() + 30000,
      error: "Readback does not match expected text/media",
    });

    return false;
  } catch {
    s.updatePublication(id, {
      status: "unverified",
      retryAt: Date.now() + 30000,
      error: "Readback unavailable",
    });

    return false;
  }
}

export async function reconcilePublication(id: string, s = store(), io = defaultIO) {
  const p = s.publication(id);

  if (p.operation !== "send") return verifyPublication(id, s, io);

  try {
    const recent = await io.read(s.channel(p.channelId).chatId);
    const expected = normalText(expectedText(p));
    const candidates = recent.filter(
      (m) =>
        normalText(m.text ?? "") === expected && m.date * 1000 >= (p.sentAt ?? Date.now()) - 60000,
    );

    if (candidates.length === 1) {
      const seed = candidates[0];
      let found = seed.groupedId ? recent.filter((m) => m.groupedId === seed.groupedId) : [seed];

      if (p.media.length && expected.length > 1024) {
        const known = recent.filter((m) => p.messageIds.includes(m.id) && m.hasMedia);

        if (known.length === p.media.length) found = [...known, seed];
        else if (!p.messageIds.length) {
          const preceding = recent
            .filter(
              (m) =>
                m.hasMedia && m.id < seed.id && m.date * 1000 >= (p.sentAt ?? Date.now()) - 60000,
            )
            .sort((a, b) => b.id - a.id);
          const photo = preceding[0];

          if (photo)
            found = [
              ...(photo.groupedId
                ? preceding.filter((m) => m.groupedId === photo.groupedId)
                : [photo]),
              seed,
            ];
        }
      }

      const ids = found.map((m) => m.id);

      if (matches({ ...p, messageIds: ids }, found)) {
        s.updatePublication(id, { messageIds: ids, status: "verified", error: null });

        return true;
      }
    }
  } catch {
    /* Keep delivery uncertain; never repeat a send. */
  }

  s.updatePublication(id, { status: "uncertain", error: "Delivery could not be reconciled" });
  await io.notice(
    `Publication ${id} has uncertain delivery; it will not be resent automatically.`,
    `uncertain:${id}`,
  );

  return false;
}

export async function deliverPublication(id: string, s = store(), io = defaultIO) {
  let p = s.publication(id);

  if (["verified", "deleted", "failed", "cancelled", "uncertain"].includes(p.status)) return p;

  if (p.status === "sending") return reconcilePublication(id, s, io);

  if (p.status === "unverified" || p.status === "sent") return verifyPublication(id, s, io);

  if (p.runId && p.operation === "send") {
    const r = s.run(p.runId),
      j = s.job(r.jobId);

    if (!j.enabled || j.version !== r.version || r.status === "cancelled") {
      return s.updatePublication(id, { status: "cancelled", error: "Job paused or changed" });
    }

    if (!s.budgetAvailable()) return p;
  }

  if (p.retryAt > Date.now() || !s.claimPublication(id)) return p;

  p = s.publication(id);

  let touched = false;
  const send = async (method: string, body: unknown) => {
    if (p.runId && p.operation === "send") {
      const r = s.run(p.runId),
        j = s.job(r.jobId);

      if (!j.enabled || j.version !== r.version || r.status === "cancelled" || !s.budgetAvailable())
        throw new Error("Job no longer eligible to send");
    }

    const result = await io.send(method, body);

    touched = true;

    return result;
  };

  try {
    const channel = s.channel(p.channelId);

    await io.check(channel.chatId);

    const text = expectedText(p);
    let results: any[] = [];

    if (p.operation === "delete") {
      for (const message_id of p.messageIds)
        await send("deleteMessage", { chat_id: channel.chatId, message_id });
    } else if (p.operation === "edit") {
      const mediaCaption = p.media.length > 0 && text.length <= 1024;
      const target = p.messageIds[p.messageIds.length - 1];

      await send(mediaCaption ? "editMessageCaption" : "editMessageText", {
        chat_id: channel.chatId,
        message_id: mediaCaption ? p.messageIds[0] : target,
        [mediaCaption ? "caption" : "text"]: text,
      });
    } else if (!p.media.length)
      results = [
        await send("sendMessage", {
          chat_id: channel.chatId,
          text,
          disable_web_page_preview: true,
        }),
      ];
    else {
      const photos = await Promise.all(p.media.map((m) => io.media(m)));

      if (photos.length === 1)
        results = [
          await send("sendPhoto", {
            chat_id: channel.chatId,
            photo: photos[0],
            caption: text.length <= 1024 ? text : undefined,
          }),
        ];
      else
        results = await send("sendMediaGroup", {
          chat_id: channel.chatId,
          media: photos.map((media, i) => ({
            type: "photo",
            media,
            caption: i === 0 && text.length <= 1024 ? text : undefined,
          })),
        });

      s.updatePublication(id, { messageIds: results.map((m) => m.message_id), sentAt: Date.now() });

      if (text.length > 1024)
        results.push(
          await send("sendMessage", {
            chat_id: channel.chatId,
            text,
            disable_web_page_preview: true,
          }),
        );
    }

    s.updatePublication(id, {
      status: "sent",
      sentAt: p.sentAt ?? Date.now(),
      messageIds: results.length ? results.map((m) => m.message_id) : p.messageIds,
      error: null,
    });
    await verifyPublication(id, s, io);
  } catch (e) {
    if (touched || (e instanceof TelegramError && e.ambiguous)) {
      s.updatePublication(id, {
        status: "sending",
        sentAt: p.sentAt ?? Date.now(),
        error: "Ambiguous delivery",
      });
      await reconcilePublication(id, s, io);
    } else {
      const attempts = s.publication(id).attempts;
      const retry = e instanceof TelegramError && e.retryAfter > 0;

      if (retry && attempts < 5 && !s.publication(id).messageIds.length)
        s.updatePublication(id, {
          status: "queued",
          retryAt: Date.now() + e.retryAfter * 1000,
          error: "Rate limited",
        });
      else {
        s.updatePublication(id, {
          status: "failed",
          error: "Publishing action failed; inspect destination permissions and media",
        });
        await io.notice(
          `Publication ${id} failed. Check channel permissions and media sources.`,
          `failed:${id}`,
        );
      }
    }
  }

  return s.publication(id);
}

export async function revisePublication(
  id: string,
  operation: "edit" | "delete",
  reason: string,
  text?: string,
  s = store(),
  io = defaultIO,
) {
  const old = s.publication(id);

  if (!["verified", "unverified", "sent"].includes(old.status))
    throw new Error("Publication must have known delivered message IDs before correction");

  if (operation === "edit" && !text?.trim()) throw new Error("Correction text required");

  if (
    operation === "edit" &&
    old.media.length &&
    old.messageIds.length === old.media.length &&
    (text?.length ?? 0) + old.evidence.map((e) => e.url.length).reduce((a, b) => a + b, 0) + 100 >
      1024
  )
    throw new Error(
      "Correction would exceed caption limit; publish a separate attributed correction instead",
    );

  if (operation === "delete" && old.sentAt && Date.now() - old.sentAt >= 48 * 3600000)
    throw new Error("Bot API deletion window expired; publish a correction instead");

  s.revise(id, {
    operation,
    status: "queued",
    attempts: 0,
    retryAt: 0,
    text: text ?? old.text,
    error: null,
  });
  s.event("publication.correction", { id, operation, reason });

  const result = await deliverPublication(id, s, io);

  await io.notice(
    `Publication ${id}: ${operation} (${reason}). Status: ${s.publication(id).status}`,
  );

  return result;
}
