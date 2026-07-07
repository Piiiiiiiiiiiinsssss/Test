// db.js
// Подключение к MongoDB Atlas (бесплатный тариф) и работа с коллекцией лицензионных ключей.
//
// Настройка (5 минут):
// 1. Зарегистрируйся на cloud.mongodb.com (можно через Google, без карты)
// 2. Create a deployment -> M0 Free
// 3. Database Access -> Add New Database User -> задай логин/пароль
// 4. Network Access -> Add IP Address -> Allow Access from Anywhere (0.0.0.0/0)
//    (для прод-версии со временем лучше сузить, но для старта ок)
// 5. Connect -> Drivers -> скопируй connection string вида:
//    mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
// 6. В Render -> Environment -> добавь переменную MONGODB_URI с этой строкой
//    (подставь туда реальный пароль вместо <password>)

const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const uri = process.env.MONGODB_URI;
let client;
let keysCollection;

async function initDb() {
  if (!uri) {
    console.error("MONGODB_URI env var is required. Get it from cloud.mongodb.com");
    process.exit(1);
  }
  client = new MongoClient(uri);
  await client.connect();
  const db = client.db("vibe_ide");
  keysCollection = db.collection("keys");
  await keysCollection.createIndex({ key: 1 }, { unique: true });
  await keysCollection.createIndex({ telegramUserId: 1 });
  await db.collection("user_plugins").createIndex({ telegramUserId: 1 }, { unique: true });
  console.log("MongoDB connected");
}

function generateKey() {
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `VIBE-${part()}-${part()}-${part()}`;
}

// --- CRUD для админки ---

async function createKey({ note = "", expiresInDays = null } = {}) {
  const key = generateKey();
  const doc = {
    key,
    status: "active", // active | revoked
    telegramUserId: null, // привязывается при первой активации
    note,
    createdAt: new Date(),
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null,
  };
  await keysCollection.insertOne(doc);
  return doc;
}

async function listKeys() {
  return keysCollection.find({}).sort({ createdAt: -1 }).toArray();
}

async function deleteKey(key) {
  const res = await keysCollection.deleteOne({ key });
  return res.deletedCount > 0;
}

async function updateKey(key, updates) {
  // updates может включать: status ('active'|'revoked'), note, expiresAt (ISO string или null),
  // resetBinding (true -> обнулить telegramUserId, чтобы ключ можно было привязать к другому аккаунту)
  const set = {};
  if (updates.status) set.status = updates.status;
  if (typeof updates.note === "string") set.note = updates.note;
  if (updates.expiresAt !== undefined) {
    set.expiresAt = updates.expiresAt ? new Date(updates.expiresAt) : null;
  }
  if (updates.resetBinding) set.telegramUserId = null;

  const res = await keysCollection.findOneAndUpdate(
    { key },
    { $set: set },
    { returnDocument: "after" }
  );
  return res;
}

// --- Активация и проверка доступа (используется клиентом) ---

async function activateKey(key, telegramUserId) {
  const doc = await keysCollection.findOne({ key });
  if (!doc) return { ok: false, error: "key not found" };
  if (doc.status !== "active") return { ok: false, error: "key revoked" };
  if (doc.expiresAt && new Date(doc.expiresAt) < new Date()) return { ok: false, error: "key expired" };

  if (doc.telegramUserId === null) {
    await keysCollection.updateOne({ key }, { $set: { telegramUserId, activatedAt: new Date() } });
    return { ok: true };
  }
  if (doc.telegramUserId !== telegramUserId) {
    return { ok: false, error: "key already bound to another account" };
  }
  return { ok: true }; // тот же юзер повторно активирует - ок
}

async function hasActiveLicense(telegramUserId) {
  const doc = await keysCollection.findOne({ telegramUserId, status: "active" });
  if (!doc) return false;
  if (doc.expiresAt && new Date(doc.expiresAt) < new Date()) return false;
  return true;
}

// --- Хранение плагинов пользователя (замена window.storage на постоянное хранилище) ---

async function getUserPlugins(telegramUserId) {
  const doc = await client.db("vibe_ide").collection("user_plugins").findOne({ telegramUserId });
  return doc ? doc.plugins : null; // null = ничего не сохранено, фронт покажет дефолтный плагин
}

async function saveUserPlugins(telegramUserId, plugins) {
  await client
    .db("vibe_ide")
    .collection("user_plugins")
    .updateOne(
      { telegramUserId },
      { $set: { plugins, updatedAt: new Date() } },
      { upsert: true }
    );
}

module.exports = {
  initDb,
  createKey,
  listKeys,
  deleteKey,
  updateKey,
  activateKey,
  hasActiveLicense,
  getUserPlugins,
  saveUserPlugins,
};
