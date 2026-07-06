// Минимальный бэкенд для Vibe IDE mini-app.
// Что делает: принимает { initData, filename, code } от мини-аппа,
// проверяет подпись Telegram (initData), достаёт chat_id пользователя
// и отправляет ему файл .plugin через Bot API (sendDocument).
//
// Установка:
//   npm init -y
//   npm install express node-telegram-bot-api body-parser cors
//   BOT_TOKEN=твой_токен_от_BotFather node server.js
//
// Задеплоить можно на Render / Railway / Fly.io / любой VPS — нужен только Node.js
// и переменная окружения BOT_TOKEN. После деплоя укажи публичный URL сервера
// (например https://your-app.onrender.com/api/send-plugin) в константе BACKEND_URL
// в vibe-ide.html.

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN env var is required. Get it from @BotFather.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN); // polling выключен — этот сервер только шлёт сообщения
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --- Проверка подлинности initData по алгоритму Telegram ---
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > 3600) return null; // старше часа — считаем протухшим

  const userJson = params.get("user");
  return userJson ? JSON.parse(userJson) : null;
}

app.post("/api/send-plugin", async (req, res) => {
  try {
    const { initData, filename, code } = req.body || {};
    if (!initData || !filename || !code) {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }
    if (!/^[\w.-]+\.plugin$/.test(filename)) {
      return res.status(400).json({ ok: false, error: "bad filename" });
    }

    const user = verifyInitData(initData, BOT_TOKEN);
    if (!user) {
      return res.status(401).json({ ok: false, error: "invalid initData" });
    }

    const buffer = Buffer.from(code, "utf-8");
    await bot.sendDocument(
      user.id,
      buffer,
      { caption: `Плагин ${filename} готов ✨` },
      { filename, contentType: "application/octet-stream" }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vibe IDE backend listening on :${PORT}`));
