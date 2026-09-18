/**
 * База CRM на встроенном node:sqlite — без нативных зависимостей.
 * Файл data/crm.db создаётся при первом запуске.
 */

import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CRM_DB || join(ROOT, "data", "crm.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

/* Этапы воронок. Порядок = порядок колонок на канбане.
   Терминальные этапы (won/lost/nurture/unqualified) — это исход лида,
   а не колонка: лид уходит либо в сделку, либо в один из «хвостов». */
export const LEAD_STAGES = [
  { key: "new", title: "Новый" },
  { key: "contacting", title: "В работе" },
  { key: "contacted", title: "Контакт установлен" },
  { key: "qualified", title: "Квалифицирован" },
];
export const LEAD_OUTCOMES = [
  { key: "won", title: "Сделка" },
  { key: "nurture", title: "Догрев" },
  { key: "unqualified", title: "Не квал" },
  { key: "lost", title: "Отказ" },
];
export const DEAL_STAGES = [
  { key: "new", title: "Новая" },
  { key: "proposal", title: "КП отправлено" },
  { key: "negotiation", title: "Согласование" },
  { key: "invoice", title: "Счёт выставлен" },
  { key: "paid", title: "Оплачена" },
  { key: "shipped", title: "Отгружена" },
];
export const DEAL_OUTCOMES = [
  { key: "won", title: "Выиграна" },
  { key: "lost", title: "Проиграна" },
];

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id        TEXT UNIQUE,                 -- id из парсинга, защита от дублей
  company       TEXT NOT NULL,
  city          TEXT,
  region        TEXT,
  segment       TEXT,
  is_chain      INTEGER DEFAULT 0,
  priority      TEXT DEFAULT 'средний',      -- высокий | средний | низкий
  stage         TEXT DEFAULT 'new',          -- см. LEAD_STAGES
  outcome       TEXT,                        -- см. LEAD_OUTCOMES, NULL пока в работе
  phones        TEXT DEFAULT '[]',           -- JSON
  site          TEXT,
  email         TEXT,
  contact_name  TEXT,
  points        TEXT DEFAULT '[]',           -- JSON: [{name,address,city}]
  source        TEXT,
  source_note   TEXT,
  competitor    TEXT,                        -- чью СВП уже продаёт
  next_action   TEXT,
  next_at       TEXT,                        -- ISO-дата следующего касания
  deal_id       INTEGER,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER REFERENCES leads(id),
  title         TEXT NOT NULL,
  company       TEXT,
  city          TEXT,
  stage         TEXT DEFAULT 'new',          -- см. DEAL_STAGES
  outcome       TEXT,                        -- won | lost
  amount        REAL DEFAULT 0,              -- считается из позиций
  vat           TEXT DEFAULT 'без НДС',      -- с НДС | без НДС
  inn           TEXT,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  next_action   TEXT,
  next_at       TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sku       TEXT UNIQUE,                     -- EAN из прайса
  name      TEXT NOT NULL,
  group_name TEXT,
  pack_type TEXT,
  price     REAL NOT NULL,                   -- дилерская цена
  rrc       REAL,                            -- РРЦ для справки
  weight_kg REAL,
  active    INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS deal_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id    INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  name       TEXT NOT NULL,                  -- снимок названия на момент добавления
  qty        REAL NOT NULL DEFAULT 1,
  price      REAL NOT NULL                   -- снимок цены
);

/* Единая лента по лиду и сделке: комментарии, смены этапов, звонки, письма.
   Интеграции (телефония, почта, мессенджеры) будут писать сюда же. */
CREATE TABLE IF NOT EXISTS activities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,                 -- lead | deal
  entity_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'comment', -- comment | stage | call | email | message | system
  text        TEXT,
  meta        TEXT,                          -- JSON: длительность звонка, тема письма и т.п.
  author      TEXT DEFAULT 'менеджер',
  created_at  TEXT DEFAULT (datetime('now'))
);

/* Компания — постоянный клиент (дилер). Появляется при конвертации лида или вручную.
   Сделки привязаны к компании; ритм заказов даёт напоминание «пора заказывать». */
CREATE TABLE IF NOT EXISTS companies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  legal_name    TEXT,                        -- ООО «…» / ИП …
  inn           TEXT,
  vat           TEXT DEFAULT 'без НДС',
  city          TEXT,
  region        TEXT,
  segment       TEXT,
  address       TEXT,                        -- адрес доставки
  phones        TEXT DEFAULT '[]',
  email         TEXT,
  site          TEXT,
  contact_name  TEXT,
  contact_role  TEXT,
  note          TEXT,
  lead_id       INTEGER,                     -- из какого лида
  status        TEXT DEFAULT 'active',       -- active | paused | lost
  order_interval_days INTEGER,               -- ритм заказов; NULL = считаем по истории
  last_order_at TEXT,
  next_order_at TEXT,                        -- когда ждём следующий заказ
  orders_count  INTEGER DEFAULT 0,
  total_amount  REAL DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

/* Пользователи и сессии. Ролей пока нет — только «кто что сделал». */
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  login      TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  is_admin   INTEGER DEFAULT 0,
  active     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen  TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

/* Почта: письма обоих ящиков, входящие и исходящие. Привязка к лиду / компании / сделке.
   entity_type NULL = «неразобранное». */
CREATE TABLE IF NOT EXISTS mail_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account      TEXT NOT NULL,                 -- dealers | sales
  folder       TEXT NOT NULL,                 -- inbox | sent
  uid          INTEGER,
  message_id   TEXT UNIQUE,
  in_reply_to  TEXT,
  refs         TEXT DEFAULT '[]',             -- JSON: References
  direction    TEXT NOT NULL,                 -- in | out
  from_addr    TEXT, from_name TEXT,
  to_addrs     TEXT DEFAULT '[]',             -- JSON [{address,name}]
  cc_addrs     TEXT DEFAULT '[]',
  subject      TEXT,
  text         TEXT,
  html         TEXT,
  snippet      TEXT,
  date         TEXT,
  has_attachments INTEGER DEFAULT 0,
  entity_type  TEXT,                          -- lead | company | deal | NULL
  entity_id    INTEGER,
  seen         INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_entity ON mail_messages(entity_type, entity_id, date);
CREATE INDEX IF NOT EXISTS idx_mail_from ON mail_messages(from_addr);
CREATE INDEX IF NOT EXISTS idx_mail_unassigned ON mail_messages(entity_type, direction, date);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  path         TEXT NOT NULL                  -- относительно каталога файлов
);

/* Состояние синхронизации по ящику и папке */
CREATE TABLE IF NOT EXISTS mail_state (
  account TEXT NOT NULL, folder TEXT NOT NULL,
  uidvalidity INTEGER, last_uid INTEGER DEFAULT 0, synced_at TEXT,
  PRIMARY KEY (account, folder)
);

CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage, outcome);
CREATE INDEX IF NOT EXISTS idx_companies_next ON companies(status, next_order_at);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage, outcome);
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id, created_at);
`);

/* Миграции колонок для баз, созданных до этой версии */
function addColumn(table, col, def) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn("deals", "company_id", "INTEGER REFERENCES companies(id)");
addColumn("leads", "company_id", "INTEGER");
addColumn("deals", "closed_at", "TEXT");
db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id)`);

/* ——— утилиты ——— */

const parseJson = (v, fallback) => {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};

export function rowToLead(r) {
  if (!r) return null;
  return { ...r, phones: parseJson(r.phones, []), points: parseJson(r.points, []), is_chain: !!r.is_chain };
}

export function touch(table, id) {
  db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

/* Текущий пользователь запроса — чтобы log() знал автора без передачи через все вызовы */
export const requestContext = new AsyncLocalStorage();
export const currentUser = () => requestContext.getStore()?.user ?? null;

export function rowToCompany(r) {
  if (!r) return null;
  return { ...r, phones: parseJson(r.phones, []) };
}

export function log(entity_type, entity_id, kind, text, meta = null, author = null) {
  author = author ?? currentUser()?.name ?? "система";
  db.prepare(
    `INSERT INTO activities (entity_type, entity_id, kind, text, meta, author) VALUES (?,?,?,?,?,?)`
  ).run(entity_type, entity_id, kind, text, meta ? JSON.stringify(meta) : null, author);
}

export function recalcDeal(dealId) {
  const { total } = db.prepare(`SELECT COALESCE(SUM(qty * price), 0) AS total FROM deal_items WHERE deal_id = ?`).get(dealId);
  db.prepare(`UPDATE deals SET amount = ?, updated_at = datetime('now') WHERE id = ?`).run(total, dealId);
  return total;
}

/* Итоги компании по выигранным сделкам + прогноз следующего заказа.
   Интервал: заданный руками, иначе средний между последними заказами. */
export function recalcCompany(companyId) {
  const won = db.prepare(`SELECT id, amount, COALESCE(closed_at, updated_at) AS at FROM deals
    WHERE company_id = ? AND outcome = 'won' ORDER BY at`).all(companyId);
  const c = db.prepare(`SELECT order_interval_days FROM companies WHERE id = ?`).get(companyId);
  if (!c) return null;
  const last = won.at(-1)?.at ?? null;
  let interval = c.order_interval_days;
  if (!interval && won.length >= 2) {
    const gaps = [];
    for (let i = 1; i < won.length; i++) gaps.push((Date.parse(won[i].at) - Date.parse(won[i - 1].at)) / 86400000);
    const recent = gaps.slice(-3);
    interval = Math.max(7, Math.round(recent.reduce((a, b) => a + b, 0) / recent.length));
  }
  const next = last && interval ? new Date(Date.parse(last) + interval * 86400000).toISOString().slice(0, 10) : null;
  db.prepare(`UPDATE companies SET orders_count = ?, total_amount = ?, last_order_at = ?, next_order_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(won.length, won.reduce((a, d) => a + (d.amount || 0), 0), last, next, companyId);
  return { orders: won.length, last, next, interval };
}
