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
const { EXAMPLES } = require("./examples.js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ALLOW_ANON_AI = process.env.ALLOW_ANON_AI === "true"; // set true only for local testing outside Telegram

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

// --- Простой подбор релевантных few-shot примеров под конкретный запрос ---
// Считает пересечение слов между (сообщением пользователя + текущим кодом)
// и описанием каждого примера. Без эмбеддингов и внешних API — быстро и бесплатно.
function pickRelevantExamples(message, pluginCode, maxExamples = 2, maxChars = 6000) {
  const haystack = (message + " " + pluginCode).toLowerCase();
  const words = new Set(haystack.match(/[a-zа-я0-9_]+/g) || []);

  const scored = EXAMPLES.map((ex) => {
    const exWords = (ex.description + " " + ex.name).toLowerCase().match(/[a-zа-я0-9_]+/g) || [];
    const score = exWords.reduce((acc, w) => acc + (words.has(w) ? 1 : 0), 0);
    return { ex, score };
  }).sort((a, b) => b.score - a.score);

  const picked = [];
  let chars = 0;
  for (const { ex, score } of scored) {
    if (picked.length >= maxExamples) break;
    if (score === 0 && picked.length > 0) break; // не берём совсем нерелевантные, если уже есть хоть один
    if (chars + ex.code.length > maxChars) continue;
    picked.push(ex);
    chars += ex.code.length;
  }
  // если вообще ничего не совпало — всё равно даём первый пример как общий образец структуры
  if (picked.length === 0 && EXAMPLES.length > 0) picked.push(EXAMPLES[0]);
  return picked;
}

const SYSTEM_PROMPT = `Ты — ассистент внутри "Vibe IDE", редактора плагинов для Telegram-клиента exteraGram (Python plugin API).
Формат плагина: файл с мета-полями __id__, __name__, __description__, __author__, __version__, __min_version__,
классом Plugin(BasePlugin) с методами on_plugin_load/on_plugin_unload, хуками вида add_on_send_message_hook,
on_send_message_hook(self, account, params) -> HookResult, использованием run_on_queue, run_on_ui_thread,
log из android_utils, send_photo/send_message из client_utils.
Тебе дают текущий код плагина и просьбу пользователя. Дай короткий ответ (1-3 предложения) на русском о том, что ты изменил,
а затем ОБЯЗАТЕЛЬНО приведи ПОЛНЫЙ обновлённый файл плагина целиком в блоке \`\`\`python ... \`\`\`.
Не сокращай код, не используй "...". Код должен быть рабочим и самодостаточным.`;

app.post("/api/ai-chat", async (req, res) => {
  try {
    const { initData, pluginCode, message } = req.body || {};
    if (!message || typeof pluginCode !== "string") {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    // Same Telegram signature check as /api/send-plugin — stops strangers from
    // burning your Groq quota by hitting this endpoint directly.
    if (!ALLOW_ANON_AI) {
      const user = verifyInitData(initData, BOT_TOKEN);
      if (!user) return res.status(401).json({ ok: false, error: "invalid initData" });
    }

    if (!GROQ_API_KEY) {
      return res.status(500).json({ ok: false, error: "GROQ_API_KEY not configured on server" });
    }

    const examples = pickRelevantExamples(message, pluginCode);
    const examplesBlock = examples
      .map((ex, i) => `Пример рабочего плагина #${i + 1} (${ex.description}):\n\`\`\`python\n${ex.code}\n\`\`\``)
      .join("\n\n");

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Вот примеры реальных рабочих плагинов, ориентируйся на их структуру и точные названия методов/классов API:\n\n${examplesBlock}` },
          {
            role: "user",
            content: `Текущий код плагина:\n\`\`\`python\n${pluginCode}\n\`\`\`\n\nЗапрос пользователя: ${message}`,
          },
        ],
        max_tokens: 2000,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq error:", errText);
      return res.status(502).json({ ok: false, error: "AI provider error" });
    }

    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content || "";
    res.json({ ok: true, reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vibe IDE backend listening on :${PORT}`));
