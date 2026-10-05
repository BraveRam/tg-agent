import type { TelegramCallbackQuery } from "eve/channels/telegram";

import { config } from "./config";

export function ownerCallbackResponse(query: TelegramCallbackQuery) {
  const owner = config().ownerId;

  if (
    !owner ||
    query.from.isBot ||
    query.message?.chat.type !== "private" ||
    query.from.id !== owner ||
    query.message.chat.id !== owner
  )
    return null;

  return {
    auth: {
      authenticator: "telegram",
      principalId: owner,
      principalType: "user" as const,
      attributes: { privateChat: "true" },
    },
  };
}
