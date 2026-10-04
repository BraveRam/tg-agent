import { telegramChannel } from "eve/channels/telegram";

import { config } from "../lib/config";

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
        attributes: {},
      },
      title: "Owner conversation",
    };
  },
});
