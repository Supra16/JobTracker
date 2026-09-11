import { loadConfig } from "./config.js";
import { sendTelegramMessage } from "./telegram.js";

const config = await loadConfig();
if (!config.telegramBotToken || !config.telegramChatId) {
  throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required for this test");
}
await sendTelegramMessage(
  config.telegramBotToken,
  config.telegramChatId,
  `Job monitor connected successfully for @${config.creatorUsername}.`
);
console.log("Telegram test message sent successfully.");
