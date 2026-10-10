import { config } from "./config";
import { modelChoices, modelSelectionKey } from "./main-model";
import { selectedModelConfig } from "./selected-model";
import { ownerUpdate } from "./security";
import { store, type Store } from "./store";
import { bot } from "./telegram";

export async function handleModelCommand(
  update: any,
  s: Store = store(),
  send: (method: string, body: unknown) => Promise<any> = bot,
) {
  if (!ownerUpdate(update)) return false;

  if (/^\/model(?:@\w+)?\s*$/i.test(update.message?.text ?? "")) {
    await send("sendMessage", {
      chat_id: config().ownerId,
      text: `Current model: ${selectedModelConfig(s).model.modelId}\nChoose a model:`,
      reply_markup: {
        inline_keyboard: modelChoices.map((choice) => [
          { text: choice.label, callback_data: `model:${choice.id}` },
        ]),
      },
    });
    return true;
  }

  const query = update.callback_query;
  if (!query?.data?.startsWith("model:")) return false;
  const choice = modelChoices.find((item) => `model:${item.id}` === query.data);
  if (!choice) {
    await send("answerCallbackQuery", { callback_query_id: query.id, text: "Unknown model." });
    return true;
  }
  const missing =
    choice.provider === "nvidia" && !process.env.NVIDIA_API_KEY
      ? "NVIDIA_API_KEY is missing."
      : choice.provider === "vercel" && !process.env.AI_GATEWAY_API_KEY
        ? "AI_GATEWAY_API_KEY is missing."
        : null;
  if (missing) {
    await send("answerCallbackQuery", {
      callback_query_id: query.id,
      text: missing,
      show_alert: true,
    });
    return true;
  }
  s.transaction(() => {
    const marker = `telegram.modelSelection:${update.update_id}`;
    if (s.get(marker, false)) return;
    s.set(modelSelectionKey, choice.id);
    s.set(marker, true);
  });
  const active = modelChoices.find(
    (item) => item.id === s.get<string | null>(modelSelectionKey, null),
  )!;
  await send("answerCallbackQuery", { callback_query_id: query.id, text: "Model selected" });
  await send("editMessageText", {
    chat_id: config().ownerId,
    message_id: query.message.message_id,
    text: `Selected: ${active.label}\nApplies to subsequent model calls.`,
    reply_markup: { inline_keyboard: [] },
  });
  return true;
}
