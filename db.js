/**
 * База CRM на встроенном node:sqlite — без нативных зависимостей.
 * Файл data/crm.db создаётся при первом запуске.
 */

import { DatabaseSync } from "node:sqlite";
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

CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage, outcome);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage, outcome);
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id, created_at);
`);

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

export function log(entity_type, entity_id, kind, text, meta = null, author = "менеджер") {
  db.prepare(
    `INSERT INTO activities (entity_type, entity_id, kind, text, meta, author) VALUES (?,?,?,?,?,?)`
  ).run(entity_type, entity_id, kind, text, meta ? JSON.stringify(meta) : null, author);
}

export function recalcDeal(dealId) {
  const { total } = db.prepare(`SELECT COALESCE(SUM(qty * price), 0) AS total FROM deal_items WHERE deal_id = ?`).get(dealId);
  db.prepare(`UPDATE deals SET amount = ?, updated_at = datetime('now') WHERE id = ?`).run(total, dealId);
  return total;
}
