import { test } from "node:test";
import assert from "node:assert/strict";

import { incomingAttachments } from "../agent/lib/incoming-attachments";
import sourceMedia from "../agent/tools/source_media";

test("incoming attachment metadata provides Bot API file IDs without Telegram URLs or credentials", () => {
  const files = incomingAttachments({
    messageId: "1244",
    attachments: [
      { kind: "photo", fileId: "owner-photo-file", size: 3000 },
      {
        kind: "document",
        fileId: "owner-pdf-file",
        fileName: "report.pdf",
        mediaType: "application/pdf",
      },
    ],
  });

  assert.deepEqual(files, [
    {
      messageId: "1244",
      file_id: "owner-photo-file",
      filename: "photo.jpg",
      mediaType: "image/jpeg",
      bytes: 3000,
    },
    {
      messageId: "1244",
      file_id: "owner-pdf-file",
      filename: "report.pdf",
      mediaType: "application/pdf",
    },
  ]);
  assert.equal(JSON.stringify(files).includes("https://"), false);
  assert.deepEqual(incomingAttachments({ messageId: "1245", attachments: [] }), []);
});

test("attachment metadata respects the configured media types and 10 MB limit", () => {
  assert.deepEqual(
    incomingAttachments({
      messageId: "1",
      attachments: [
        { kind: "photo", fileId: "big", size: 10 * 1024 * 1024 + 1 },
        { kind: "document", fileId: "audio", mediaType: "audio/ogg" },
        { kind: "document", fileId: "unknown" },
      ],
    }),
    [],
  );
});

test("source media rejects private-chat routing with actionable guidance before accessing the worker", async () => {
  const previous = process.env.TELEGRAM_OWNER_ID;

  process.env.TELEGRAM_OWNER_ID = "123";

  try {
    for (const channel of ["123", "telegram", "private"]) {
      await assert.rejects(
        async () =>
          sourceMedia.execute!(
            { channel, messageId: 1244, path: "/workspace/photo.jpg" },
            {} as any,
          ),
        /telegram_api getFile/,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = previous;
  }
});
