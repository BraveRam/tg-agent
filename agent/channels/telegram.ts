import { telegramChannel } from "eve/channels/telegram";

import { incomingAttachments } from "../lib/incoming-attachments";
import { config } from "../lib/config";
import { ownerCallbackResponse } from "../lib/callback-auth";

export default telegramChannel({
  credentials: {
    botToken: () => config().botToken,
    webhookSecretToken: () => config().webhookSecret,
  },
  uploadPolicy: { allowedMediaTypes: ["image/*", "application/pdf"], maxBytes: 10 * 1024 * 1024 },
  events: {
    // The activity hook sends both intermediate assistant text and final replies.
    "message.completed": () => {},
  },

  onInputResponse(_ctx, query) {
    return ownerCallbackResponse(query);
  },

  onMessage(_ctx, message) {
    if (
      message.chat.type !== "private" ||
      String(message.from?.id) !== config().ownerId ||
      String(message.chat.id) !== config().ownerId
    )
      return null;

    const attachments = incomingAttachments(message);

    return {
      auth: {
        authenticator: "telegram",
        principalId: config().ownerId,
        principalType: "user" as const,
        attributes: {
          privateChat: "true",
        },
      },
      context: attachments.length
        ? [
            `Incoming attachment download metadata (incomingAttachments): ${JSON.stringify(attachments)}. To save bytes into your sandbox, use telegram_api getFile with file_id and downloadTo, not source_media.`,
          ]
        : [],
      title: "Owner conversation",
    };
  },
});
