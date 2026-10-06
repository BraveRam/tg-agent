import { config } from "./config";
import { ownerUpdate } from "./security";
import { bot, notify } from "./telegram";

const commands = [
  { command: "start", description: "Show commands and enable the menu" },
  { command: "cancel", description: "Cancel the current chat task" },
  { command: "reset", description: "Start a fresh conversation" },
  { command: "context", description: "Show context usage, skills and tools" },
];

export async function handleStartCommand(update: any) {
  if (!ownerUpdate(update) || !/^\/start(?:@\w+)?(?:\s+\S+)?\s*$/i.test(update.message?.text ?? ""))
    return false;

  const chatId = config().ownerId;

  await bot("setMyCommands", {
    commands,
    scope: { type: "chat", chat_id: chatId },
  });
  await bot("setChatMenuButton", {
    chat_id: chatId,
    menu_button: { type: "commands" },
  });
  await notify(
    "Ready. Use the Menu button or send a message.\n\n" +
      commands.map(({ command, description }) => `/${command} — ${description}`).join("\n"),
    `telegram.start:${update.update_id}`,
  );

  return true;
}
