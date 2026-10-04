import { resolve } from "node:path";

export const config = () => ({
  dataDir: resolve(process.env.TG_DATA_DIR ?? ".data"),
  ownerId: process.env.TELEGRAM_OWNER_ID ?? "",
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  internalToken: process.env.TG_INTERNAL_TOKEN ?? "",
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN ?? "",
  port: Number(process.env.TG_PORT ?? 2000),
  userbotPort: Number(process.env.TG_USERBOT_PORT ?? 2001),
  timezone: process.env.TG_TIMEZONE ?? "Africa/Nairobi",
  dailyBudget: Number(process.env.TG_DAILY_MODEL_BUDGET ?? 2),
});
