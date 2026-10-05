// Metadata comes from an authenticated owner message, not from model-generated references.
export function incomingAttachments(message: {
  messageId: string;
  attachments: readonly {
    fileId: string;
    fileName?: string;
    mediaType?: string;
    kind: "photo" | "document";
    size?: number;
  }[];
}) {
  return message.attachments
    .filter((file) => {
      const type =
        file.mediaType ?? (file.kind === "photo" ? "image/jpeg" : "application/octet-stream");

      return (
        (type.startsWith("image/") || type === "application/pdf") &&
        (file.size === undefined || file.size <= 10 * 1024 * 1024)
      );
    })
    .map((file) => ({
      messageId: message.messageId,
      file_id: file.fileId,
      filename: file.fileName ?? (file.kind === "photo" ? "photo.jpg" : "document.pdf"),
      mediaType: file.mediaType ?? (file.kind === "photo" ? "image/jpeg" : "application/pdf"),
      ...(file.size === undefined ? {} : { bytes: file.size }),
    }));
}
