import { telegramChannel } from "eve/channels/telegram";

import { ownerJoinReferences } from "../lib/source-authorization";
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

    return {
      auth: {
        authenticator: "telegram",
        principalId: config().ownerId,
        principalType: "user" as const,
        attributes: {
          privateChat: "true",
          joinReferences: ownerJoinReferences(
            message.text || message.caption,
            !!message.raw.forward_origin,
          ),
        },
      },
      title: "Owner conversation",
    };
  },
});
