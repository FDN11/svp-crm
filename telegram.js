/**
 * Telegram-бот: утренняя сводка «Сегодня» каждому менеджеру и команда /today по запросу.
 * Нужен TELEGRAM_BOT_TOKEN в окружении (бот создаётся у @BotFather). Без токена модуль молчит.
 * Привязка: менеджер в «Настройках» получает код, пишет его боту — chat_id сохраняется в users.
 */
import { db } from "./db.js";
import { buildToday } from "./today.js";
import { getSetting, setSetting } from "./sequences.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const BASE_URL = process.env.CRM_URL || "https://crm.svpbrand.com";
const MSK = 3 * 3600000;

db.exec(`CREATE TABLE IF NOT EXISTS tg_links (code TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
{ const has = db.prepare(`PRAGMA table_info(users)`).all().some((c) => c.name === "telegram_chat_id"); if (!has) db.exec(`ALTER TABLE users ADD COLUMN telegram_chat_id TEXT`); }

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!j.ok) throw new Error(j.description || method); return j.result;
}
const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const rub = (n) => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " ₽";

export function digestText(user) {
  const t = buildToday(user, true);
  const L = [];
  const sec = (title, items, fmt) => { if (!items.length) return; L.push(`\n<b>${title} · ${items.length}</b>`); for (const x of items.slice(0, 6)) L.push("• " + fmt(x)); if (items.length > 6) L.push(`  … ещё ${items.length - 6}`); };
  L.push(`<b>Сегодня, ${esc(user.name.split(" ")[0])}</b>`);
  sec("Заявки с сайта", t.fresh, (l) => `<a href="${BASE_URL}/#leads/${l.id}">${esc(l.company)}</a>${l.city ? " · " + esc(l.city) : ""}${l.phones[0] ? " · " + esc(l.phones[0]) : ""}`);
  sec("Ответили", t.replied, (m) => `<a href="${BASE_URL}/#${m.entity_type === "company" ? "companies" : m.entity_type + "s"}/${m.entity_id}">${esc(m.title || m.from_addr)}</a>: ${esc((m.subject || "").slice(0, 50))}`);
  sec("Касания", t.touches, (x) => `<a href="${BASE_URL}/#${x.type}s/${x.id}">${esc(x.title)}</a> — ${esc(x.next_action || "касание")}${x.phone ? " · " + esc(x.phone) : ""}`);
  sec("Пора заказывать", t.reorder, (c) => `<a href="${BASE_URL}/#companies/${c.id}">${esc(c.name)}</a> · ${c.orders_count} зак. · ${rub(c.total_amount)}${c.phones[0] ? " · " + esc(c.phones[0]) : ""}`);
  sec("Зависшие сделки", t.stale, (d) => `<a href="${BASE_URL}/#deals/${d.id}">${esc(d.title)}</a> · ${d.days} дн. · ${rub(d.amount)}`);
  if (t.unassigned.length) L.push(`\n✉ Неразобранных писем: <a href="${BASE_URL}/#mail">${t.unassigned.length}</a>`);
  if (L.length === 1) L.push("\nОчередь пуста — хорошего дня.");
  return L.join("\n");
}

async function sendDigest(user) {
  if (!user.telegram_chat_id) return false;
  await tg("sendMessage", { chat_id: user.telegram_chat_id, text: digestText(user), parse_mode: "HTML", disable_web_page_preview: true });
  return true;
}

/* привязка: код из настроек → сообщение боту */
export function makeLinkCode(userId) {
  db.prepare(`DELETE FROM tg_links WHERE user_id = ? OR created_at < datetime('now', '-1 day')`).run(userId);
  const code = String(100000 + Math.floor(Math.random() * 900000));
  db.prepare(`INSERT INTO tg_links (code, user_id) VALUES (?, ?)`).run(code, userId);
  return code;
}

let offset = 0;
async function poll() {
  const updates = await tg("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] });
  for (const u of updates) {
    offset = u.update_id + 1;
    const msg = u.message; if (!msg?.text) continue;
    const chat = String(msg.chat.id); const text = msg.text.trim();
    const linked = db.prepare(`SELECT * FROM users WHERE telegram_chat_id = ?`).get(chat);
    if (/^\d{6}$/.test(text)) {
      const link = db.prepare(`SELECT * FROM tg_links WHERE code = ? AND created_at > datetime('now', '-1 day')`).get(text);
      if (link) { db.prepare(`UPDATE users SET telegram_chat_id = ? WHERE id = ?`).run(chat, link.user_id); db.prepare(`DELETE FROM tg_links WHERE code = ?`).run(text); const u2 = db.prepare(`SELECT * FROM users WHERE id = ?`).get(link.user_id); await tg("sendMessage", { chat_id: chat, text: `Готово, ${u2.name}. Сводка будет приходить каждое утро в ${getSetting("tg_digest_time") || "9:00"} МСК. Команда /today — сводка сейчас.` }); }
      else await tg("sendMessage", { chat_id: chat, text: "Код не найден или устарел. Получите новый в CRM → Настройки → Telegram." });
    } else if (/^\/today/.test(text) && linked) await sendDigest(linked);
    else if (/^\/start/.test(text)) await tg("sendMessage", { chat_id: chat, text: linked ? `Вы уже привязаны как ${linked.name}. /today — сводка.` : "Это бот СВП CRM. Откройте CRM → Настройки → Telegram, получите код и отправьте его сюда." });
    else if (linked) await tg("sendMessage", { chat_id: chat, text: "Команды: /today — сводка дел на сегодня." });
  }
}

let lastDigestDay = null;
async function digestTick() {
  const now = new Date(Date.now() + MSK); const day = now.toISOString().slice(0, 10);
  const [h, m = 0] = (getSetting("tg_digest_time") || "9:00").split(":").map(Number);
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return;
  if (now.getUTCHours() * 60 + now.getUTCMinutes() < h * 60 + m) return;
  if (lastDigestDay === day || getSetting("tg_last_digest") === day) return;
  lastDigestDay = day; setSetting("tg_last_digest", day);
  for (const u of db.prepare(`SELECT * FROM users WHERE active = 1 AND telegram_chat_id IS NOT NULL`).all()) { try { await sendDigest(u); } catch (e) { console.error("tg digest", u.login, e.message); } }
}

export function startTelegram() {
  if (!TOKEN) { console.log("telegram: TELEGRAM_BOT_TOKEN не задан — бот выключен"); return; }
  console.log("telegram: бот включён, сводка в", getSetting("tg_digest_time") || "9:00", "МСК");
  const loop = async () => { try { await poll(); await digestTick(); } catch (e) { console.error("telegram:", e.message); } setTimeout(loop, 20000); };
  setTimeout(loop, 5000);
}

export function telegramRoutes(app) {
  app.get("/api/telegram/status", (req, res) => {
    const u = db.prepare(`SELECT telegram_chat_id FROM users WHERE id = ?`).get(req.user.id);
    res.json({ enabled: !!TOKEN, linked: !!u?.telegram_chat_id, digest_time: getSetting("tg_digest_time") || "9:00", bot: process.env.TELEGRAM_BOT_NAME || null });
  });
  app.post("/api/telegram/link", (req, res) => res.json({ code: makeLinkCode(req.user.id) }));
  app.post("/api/telegram/unlink", (req, res) => { db.prepare(`UPDATE users SET telegram_chat_id = NULL WHERE id = ?`).run(req.user.id); res.json({ ok: true }); });
  app.post("/api/telegram/test", async (req, res) => { try { const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id); res.json({ sent: await sendDigest(u) }); } catch (e) { res.status(502).json({ error: e.message }); } });
  app.get("/api/telegram/preview", (req, res) => res.json({ text: digestText(db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id)) }));
}
