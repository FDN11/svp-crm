/**
 * СВП CRM — сервер.
 *
 * REST API + раздача интерфейса из public/. Все действия из интерфейса идут
 * через API, поэтому интеграции (телефония, почта, мессенджеры) подключаются
 * теми же вызовами: /api/leads/:id/activities для событий, /api/leads для
 * входящих лидов, /api/webhooks/* — точка для входящих событий извне.
 */

import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  db, rowToLead, touch, log, recalcDeal,
  LEAD_STAGES, LEAD_OUTCOMES, DEAL_STAGES, DEAL_OUTCOMES,
} from "./db.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(join(ROOT, "public")));

const leadStageKeys = new Set(LEAD_STAGES.map((s) => s.key));
const leadOutcomeKeys = new Set(LEAD_OUTCOMES.map((s) => s.key));
const dealStageKeys = new Set(DEAL_STAGES.map((s) => s.key));
const dealOutcomeKeys = new Set(DEAL_OUTCOMES.map((s) => s.key));

/* ——— справочники ——— */
app.get("/api/meta", (_req, res) => {
  res.json({ LEAD_STAGES, LEAD_OUTCOMES, DEAL_STAGES, DEAL_OUTCOMES });
});

/* ——— лиды ——— */
app.get("/api/leads", (req, res) => {
  const { q, city, segment, outcome } = req.query;
  const where = []; const params = [];
  if (outcome === "active") where.push("outcome IS NULL");
  else if (outcome) { where.push("outcome = ?"); params.push(outcome); }
  if (city) { where.push("city = ?"); params.push(city); }
  if (segment) { where.push("segment = ?"); params.push(segment); }
  if (q) { where.push("(company LIKE ? OR city LIKE ? OR phones LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `SELECT * FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY
    CASE priority WHEN 'высокий' THEN 0 WHEN 'средний' THEN 1 ELSE 2 END, updated_at DESC`;
  res.json(db.prepare(sql).all(...params).map(rowToLead));
});

app.get("/api/leads/:id", (req, res) => {
  const lead = rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id));
  if (!lead) return res.status(404).json({ error: "lead not found" });
  lead.activities = db.prepare(`SELECT * FROM activities WHERE entity_type='lead' AND entity_id=? ORDER BY created_at DESC, id DESC`).all(lead.id);
  res.json(lead);
});

/* создание — руками из интерфейса или из парсера/сайта/интеграции */
app.post("/api/leads", (req, res) => {
  const b = req.body || {};
  if (!b.company) return res.status(400).json({ error: "company is required" });
  const info = db.prepare(`
    INSERT INTO leads (ext_id, company, city, region, segment, is_chain, priority, phones, site, email, contact_name, points, source, source_note, competitor)
    VALUES (@ext_id, @company, @city, @region, @segment, @is_chain, @priority, @phones, @site, @email, @contact_name, @points, @source, @source_note, @competitor)
    ON CONFLICT(ext_id) DO NOTHING
  `).run({
    ext_id: b.ext_id ?? null, company: b.company, city: b.city ?? null, region: b.region ?? null,
    segment: b.segment ?? null, is_chain: b.is_chain ? 1 : 0, priority: b.priority ?? "средний",
    phones: JSON.stringify(b.phones ?? []), site: b.site ?? null, email: b.email ?? null,
    contact_name: b.contact_name ?? null, points: JSON.stringify(b.points ?? []),
    source: b.source ?? "manual", source_note: b.source_note ?? null, competitor: b.competitor ?? null,
  });
  if (!info.changes) return res.status(200).json({ skipped: true, reason: "duplicate ext_id" });
  log("lead", info.lastInsertRowid, "system", `Лид создан · источник: ${b.source ?? "вручную"}`);
  res.status(201).json(rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(info.lastInsertRowid)));
});

/* пакетный импорт из парсинга */
app.post("/api/leads/import", (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "expected array" });
  let added = 0, skipped = 0;
  const tx = db.prepare(`
    INSERT INTO leads (ext_id, company, city, region, segment, is_chain, priority, phones, site, points, source, source_note, competitor)
    VALUES (@ext_id, @company, @city, @region, @segment, @is_chain, @priority, @phones, @site, @points, @source, @source_note, @competitor)
    ON CONFLICT(ext_id) DO NOTHING`);
  for (const b of items) {
    const info = tx.run({
      ext_id: b.ext_id ?? b.id ?? null, company: b.company, city: b.city ?? null, region: b.region ?? null,
      segment: b.segment ?? null, is_chain: b.is_chain ? 1 : 0, priority: b.priority ?? "средний",
      phones: JSON.stringify(b.phones ?? []), site: b.site ?? null, points: JSON.stringify(b.points ?? []),
      source: b.source ?? "import", source_note: b.source_note ?? null, competitor: b.sells_competitor_svp ?? b.competitor ?? null,
    });
    if (info.changes) { added++; log("lead", info.lastInsertRowid, "system", `Импорт · ${b.source ?? "import"}`); } else skipped++;
  }
  res.json({ added, skipped });
});

app.patch("/api/leads/:id", (req, res) => {
  const id = Number(req.params.id);
  const lead = rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id));
  if (!lead) return res.status(404).json({ error: "lead not found" });
  const b = req.body || {};
  const allowed = ["company", "city", "region", "segment", "priority", "site", "email", "contact_name", "competitor", "next_action", "next_at", "source_note"];
  const sets = []; const params = [];
  for (const k of allowed) if (k in b) { sets.push(`${k} = ?`); params.push(b[k]); }
  if ("phones" in b) { sets.push(`phones = ?`); params.push(JSON.stringify(b.phones)); }
  if ("points" in b) { sets.push(`points = ?`); params.push(JSON.stringify(b.points)); }
  if ("stage" in b) {
    if (!leadStageKeys.has(b.stage)) return res.status(400).json({ error: "bad stage" });
    sets.push(`stage = ?`); params.push(b.stage);
    if (b.stage !== lead.stage) log("lead", id, "stage", `Этап: ${LEAD_STAGES.find(s => s.key === lead.stage)?.title} → ${LEAD_STAGES.find(s => s.key === b.stage)?.title}`);
  }
  if ("outcome" in b) {
    if (b.outcome !== null && !leadOutcomeKeys.has(b.outcome)) return res.status(400).json({ error: "bad outcome" });
    sets.push(`outcome = ?`); params.push(b.outcome);
    log("lead", id, "stage", b.outcome ? `Исход: ${LEAD_OUTCOMES.find(s => s.key === b.outcome)?.title}` : "Возвращён в работу");
  }
  if (!sets.length) return res.json(lead);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  res.json(rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id)));
});

/* лид → сделка */
app.post("/api/leads/:id/convert", (req, res) => {
  const id = Number(req.params.id);
  const lead = rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id));
  if (!lead) return res.status(404).json({ error: "lead not found" });
  if (lead.deal_id) return res.json(db.prepare(`SELECT * FROM deals WHERE id = ?`).get(lead.deal_id));
  const b = req.body || {};
  const info = db.prepare(`
    INSERT INTO deals (lead_id, title, company, city, vat, inn, contact_name, phone, email)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, b.title || `${lead.company} — первая партия`, lead.company, lead.city,
    b.vat ?? "без НДС", b.inn ?? null, lead.contact_name, lead.phones[0] ?? null, lead.email);
  const dealId = info.lastInsertRowid;
  db.prepare(`UPDATE leads SET outcome = 'won', deal_id = ?, updated_at = datetime('now') WHERE id = ?`).run(dealId, id);
  log("lead", id, "stage", `Переведён в сделку #${dealId}`);
  log("deal", dealId, "system", `Сделка создана из лида #${id} (${lead.company})`);
  res.status(201).json(db.prepare(`SELECT * FROM deals WHERE id = ?`).get(dealId));
});

/* ——— сделки ——— */
app.get("/api/deals", (req, res) => {
  const { outcome } = req.query;
  const where = outcome === "active" ? "WHERE outcome IS NULL" : outcome ? "WHERE outcome = ?" : "";
  const params = outcome && outcome !== "active" ? [outcome] : [];
  res.json(db.prepare(`SELECT * FROM deals ${where} ORDER BY updated_at DESC`).all(...params));
});

app.get("/api/deals/:id", (req, res) => {
  const deal = db.prepare(`SELECT * FROM deals WHERE id = ?`).get(req.params.id);
  if (!deal) return res.status(404).json({ error: "deal not found" });
  deal.items = db.prepare(`SELECT * FROM deal_items WHERE deal_id = ? ORDER BY id`).all(deal.id);
  deal.activities = db.prepare(`SELECT * FROM activities WHERE entity_type='deal' AND entity_id=? ORDER BY created_at DESC, id DESC`).all(deal.id);
  deal.lead = deal.lead_id ? rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(deal.lead_id)) : null;
  res.json(deal);
});

app.post("/api/deals", (req, res) => {
  const b = req.body || {};
  if (!b.title && !b.company) return res.status(400).json({ error: "title or company required" });
  const info = db.prepare(`INSERT INTO deals (title, company, city, vat, inn, contact_name, phone, email) VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.title || b.company, b.company ?? null, b.city ?? null, b.vat ?? "без НДС", b.inn ?? null, b.contact_name ?? null, b.phone ?? null, b.email ?? null);
  log("deal", info.lastInsertRowid, "system", "Сделка создана вручную");
  res.status(201).json(db.prepare(`SELECT * FROM deals WHERE id = ?`).get(info.lastInsertRowid));
});

app.patch("/api/deals/:id", (req, res) => {
  const id = Number(req.params.id);
  const deal = db.prepare(`SELECT * FROM deals WHERE id = ?`).get(id);
  if (!deal) return res.status(404).json({ error: "deal not found" });
  const b = req.body || {};
  const allowed = ["title", "company", "city", "vat", "inn", "contact_name", "phone", "email", "next_action", "next_at"];
  const sets = []; const params = [];
  for (const k of allowed) if (k in b) { sets.push(`${k} = ?`); params.push(b[k]); }
  if ("stage" in b) {
    if (!dealStageKeys.has(b.stage)) return res.status(400).json({ error: "bad stage" });
    sets.push(`stage = ?`); params.push(b.stage);
    if (b.stage !== deal.stage) log("deal", id, "stage", `Этап: ${DEAL_STAGES.find(s => s.key === deal.stage)?.title} → ${DEAL_STAGES.find(s => s.key === b.stage)?.title}`);
  }
  if ("outcome" in b) {
    if (b.outcome !== null && !dealOutcomeKeys.has(b.outcome)) return res.status(400).json({ error: "bad outcome" });
    sets.push(`outcome = ?`); params.push(b.outcome);
    log("deal", id, "stage", b.outcome ? `Исход: ${DEAL_OUTCOMES.find(s => s.key === b.outcome)?.title}` : "Возвращена в работу");
  }
  if (!sets.length) return res.json(deal);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE deals SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  res.json(db.prepare(`SELECT * FROM deals WHERE id = ?`).get(id));
});

/* позиции сделки */
app.post("/api/deals/:id/items", (req, res) => {
  const dealId = Number(req.params.id);
  if (!db.prepare(`SELECT 1 FROM deals WHERE id = ?`).get(dealId)) return res.status(404).json({ error: "deal not found" });
  const b = req.body || {};
  let name = b.name, price = b.price, productId = b.product_id ?? null;
  if (productId) {
    const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId);
    if (!p) return res.status(404).json({ error: "product not found" });
    name = name ?? p.name; price = price ?? p.price;
  }
  if (!name || price == null) return res.status(400).json({ error: "name and price required" });
  const info = db.prepare(`INSERT INTO deal_items (deal_id, product_id, name, qty, price) VALUES (?,?,?,?,?)`)
    .run(dealId, productId, name, Number(b.qty) || 1, Number(price));
  const total = recalcDeal(dealId);
  log("deal", dealId, "system", `Добавлена позиция: ${name} × ${Number(b.qty) || 1}`);
  res.status(201).json({ id: info.lastInsertRowid, total });
});

app.patch("/api/deals/:id/items/:itemId", (req, res) => {
  const { id, itemId } = req.params;
  const b = req.body || {};
  const sets = []; const params = [];
  if ("qty" in b) { sets.push("qty = ?"); params.push(Number(b.qty)); }
  if ("price" in b) { sets.push("price = ?"); params.push(Number(b.price)); }
  if (!sets.length) return res.status(400).json({ error: "nothing to update" });
  db.prepare(`UPDATE deal_items SET ${sets.join(", ")} WHERE id = ? AND deal_id = ?`).run(...params, itemId, id);
  res.json({ total: recalcDeal(Number(id)) });
});

app.delete("/api/deals/:id/items/:itemId", (req, res) => {
  const { id, itemId } = req.params;
  db.prepare(`DELETE FROM deal_items WHERE id = ? AND deal_id = ?`).run(itemId, id);
  res.json({ total: recalcDeal(Number(id)) });
});

/* ——— активности: комментарии и события ——— */
function addActivity(table, entity) {
  return (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  if (!b.text) return res.status(400).json({ error: "text required" });
  log(entity, id, b.kind || "comment", b.text, b.meta ?? null, b.author ?? "менеджер");
  touch(table, id);
  res.status(201).json(db.prepare(`SELECT * FROM activities WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 1`).get(entity, id));
  };
}
app.post("/api/leads/:id/activities", addActivity("leads", "lead"));
app.post("/api/deals/:id/activities", addActivity("deals", "deal"));

/* ——— товары ——— */
app.get("/api/products", (_req, res) => {
  res.json(db.prepare(`SELECT * FROM products WHERE active = 1 ORDER BY group_name, name`).all());
});

/* ——— сводка для шапки ——— */
app.get("/api/stats", (_req, res) => {
  const leads = db.prepare(`SELECT stage, outcome, COUNT(*) n FROM leads GROUP BY stage, outcome`).all();
  const deals = db.prepare(`SELECT stage, outcome, COUNT(*) n, COALESCE(SUM(amount),0) amount FROM deals GROUP BY stage, outcome`).all();
  const today = db.prepare(`SELECT COUNT(*) n FROM leads WHERE outcome IS NULL AND next_at IS NOT NULL AND date(next_at) <= date('now')`).get().n;
  res.json({ leads, deals, due_today: today });
});

/* ——— точка входа для интеграций ———
   Телефония / почта / мессенджеры шлют сюда события. Пока — приём и запись
   в ленту по номеру телефона; конкретные провайдеры добавляются как адаптеры. */
app.post("/api/webhooks/:source", (req, res) => {
  const { source } = req.params;
  const b = req.body || {};
  const phone = (b.phone || b.from || "").replace(/\D/g, "").replace(/^8/, "7");
  let lead = null;
  if (phone) lead = db.prepare(`SELECT * FROM leads WHERE phones LIKE ? ORDER BY updated_at DESC LIMIT 1`).get(`%${phone}%`);
  if (lead) {
    log("lead", lead.id, b.kind || (source === "telephony" ? "call" : source === "mail" ? "email" : "message"),
        b.text || `Событие от ${source}`, b, source);
    touch("leads", lead.id);
    return res.json({ matched: "lead", id: lead.id });
  }
  res.json({ matched: null, note: "телефон не найден среди лидов — событие не привязано" });
});

app.listen(PORT, () => {
  console.log(`СВП CRM → http://localhost:${PORT}`);
});
