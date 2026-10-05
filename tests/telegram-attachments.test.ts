import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTelegramFetchFile,
  createTelegramFileUrl,
} from "../node_modules/eve/dist/src/public/channels/telegram/attachments.js";

const policy = { allowedMediaTypes: ["image/*", "application/pdf"], maxBytes: 10 * 1024 * 1024 };

function resolver(contentType?: string, bytes = new Uint8Array([0xff, 0xd8, 0xff])) {
  return createTelegramFetchFile({
    credentials: { botToken: "test-token" },
    policy,
    api: {
      fetch: (async (url) =>
        String(url).includes("getFile")
          ? Response.json({ ok: true, result: { file_path: "photos/file.jpg" } })
          : new Response(bytes, {
              headers: contentType ? { "content-type": contentType } : {},
            })) as typeof fetch,
    },
  });
}

test("native Telegram photos retain their image MIME when Telegram serves generic binary bytes", async () => {
  for (const type of [
    "application/octet-stream",
    "application/octet-stream; charset=binary",
    "binary/octet-stream",
    undefined,
  ]) {
    const fetchFile = resolver(type);
    const file = await fetchFile(
      createTelegramFileUrl({ fileId: "photo-id", filename: "photo.jpg", mediaType: "image/jpeg" })
        .href,
    );

    assert.ok(file && !Buffer.isBuffer(file));
    assert.equal(file.mediaType, "image/jpeg");
    assert.deepEqual([...file.bytes], [0xff, 0xd8, 0xff]);
  }
});

test("native Telegram PDFs retain metadata for generic binary downloads", async () => {
  const file = await resolver("application/octet-stream")(
    createTelegramFileUrl({
      fileId: "pdf-id",
      filename: "report.pdf",
      mediaType: "application/pdf",
    }).href,
  );

  assert.ok(file && !Buffer.isBuffer(file));
  assert.equal(file.mediaType, "application/pdf");
});

test("specific response MIME types still enforce upload policy and oversized photos remain rejected", async () => {
  const url = createTelegramFileUrl({ fileId: "photo-id", mediaType: "image/jpeg" }).href;

  await assert.rejects(() => resolver("text/html")(url), /rejected/);
  await assert.rejects(
    () => resolver("application/octet-stream", new Uint8Array(10 * 1024 * 1024 + 1))(url),
    /rejected/,
  );
  await assert.rejects(
    () => resolver("application/octet-stream")(createTelegramFileUrl({ fileId: "unknown" }).href),
    /rejected/,
  );

  const png = await resolver("image/png; charset=binary")(url);

  assert.ok(png && !Buffer.isBuffer(png));
  assert.equal(png.mediaType, "image/png");
});
