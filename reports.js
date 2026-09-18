/**
 * Аналитика: готовые отчёты + конструктор сводной таблицы (метрика × разрез × период) + CSV.
 * Всё считается запросами по живой базе — данных мало, кэш не нужен.
 */
import { db, LEAD_STAGES, DEAL_STAGES } from "./db.js";

/* период: from/to в формате YYYY-MM-DD, по умолчанию последние 90 дней */
function period(q) {
  const to = q.to || new Date().toISOString().slice(0, 10);
  const from = q.from || new Date(Date.parse(to) - 90 * 86400000).toISOString().slice(0, 10);
  return { from, to: to + " 23:59:59" };
}

/* ——— разрезы (dimensions) для сводной ——— */
const BUCKET = { day: "date(@d)", week: "strftime('%Y-W%W', @d)", month: "strftime('%Y-%m', @d)", quarter: "strftime('%Y', @d) || '-Q' || ((CAST(strftime('%m', @d) AS INTEGER) + 2) / 3)" };
const DIMS = {
  deals: { month: (d) => BUCKET.month.replace(/@d/g, d), week: (d) => BUCKET.week.replace(/@d/g, d), day: (d) => BUCKET.day.replace(/@d/g, d), quarter: (d) => BUCKET.quarter.replace(/@d/g, d),
    city: () => "COALESCE(d.city, '—')", region: () => "COALESCE((SELECT region FROM leads WHERE id = d.lead_id), '—')", stage: () => "d.stage", outcome: () => "COALESCE(d.outcome, 'в работе')",
    company: () => "COALESCE(d.company, '—')", segment: () => "COALESCE((SELECT segment FROM companies WHERE id = d.company_id), (SELECT segment FROM leads WHERE id = d.lead_id), '—')",
    vat: () => "d.vat", manager: () => "COALESCE((SELECT author FROM activities a WHERE a.entity_type='deal' AND a.entity_id = d.id AND a.kind='system' ORDER BY a.id LIMIT 1), '—')",
    repeat: () => "CASE WHEN (SELECT COUNT(*) FROM deals x WHERE x.company_id = d.company_id AND x.outcome='won' AND x.closed_at < COALESCE(d.closed_at, d.created_at)) > 0 THEN 'повторный' ELSE 'новый клиент' END" },
  leads: { month: (d) => BUCKET.month.replace(/@d/g, d), week: (d) => BUCKET.week.replace(/@d/g, d), day: (d) => BUCKET.day.replace(/@d/g, d),
    city: () => "COALESCE(l.city, '—')", region: () => "COALESCE(l.region, '—')", segment: () => "COALESCE(l.segment, '—')", source: () => "COALESCE(l.source, '—')",
    stage: () => "l.stage", outcome: () => "COALESCE(l.outcome, 'в работе')", competitor: () => "COALESCE(l.competitor, 'нет')", priority: () => "l.priority" },
  items: { month: (d) => BUCKET.month.replace(/@d/g, d), product: () => "i.name", group: () => "COALESCE((SELECT group_name FROM products WHERE id = i.product_id), '—')",
    city: () => "COALESCE(d.city, '—')", company: () => "COALESCE(d.company, '—')" },
  activities: { day: (d) => BUCKET.day.replace(/@d/g, d), week: (d) => BUCKET.week.replace(/@d/g, d), month: (d) => BUCKET.month.replace(/@d/g, d), kind: () => "a.kind", author: () => "a.author", entity: () => "a.entity_type" },
};
/* ——— метрики ——— */
const METRICS = {
  deals: { count: "COUNT(*)", amount: "COALESCE(SUM(d.amount),0)", avg: "COALESCE(AVG(d.amount),0)", won: "SUM(CASE WHEN d.outcome='won' THEN 1 ELSE 0 END)", won_amount: "COALESCE(SUM(CASE WHEN d.outcome='won' THEN d.amount END),0)", conv: "ROUND(100.0*SUM(CASE WHEN d.outcome='won' THEN 1 ELSE 0 END)/MAX(COUNT(*),1),1)" },
  leads: { count: "COUNT(*)", converted: "SUM(CASE WHEN l.outcome='won' THEN 1 ELSE 0 END)", conv: "ROUND(100.0*SUM(CASE WHEN l.outcome='won' THEN 1 ELSE 0 END)/MAX(COUNT(*),1),1)", with_email: "SUM(CASE WHEN l.email IS NOT NULL THEN 1 ELSE 0 END)", lost: "SUM(CASE WHEN l.outcome IN ('lost','unqualified') THEN 1 ELSE 0 END)" },
  items: { qty: "COALESCE(SUM(i.qty),0)", amount: "COALESCE(SUM(i.qty*i.price),0)", deals: "COUNT(DISTINCT d.id)" },
  activities: { count: "COUNT(*)" },
};
const DATE_COL = { deals: (metric) => /won/.test(metric) ? "COALESCE(d.closed_at, d.updated_at)" : "d.created_at", leads: () => "l.created_at", items: () => "COALESCE(d.closed_at, d.created_at)", activities: () => "a.created_at" };
const FROM = { deals: "deals d", leads: "leads l", items: "deal_items i JOIN deals d ON d.id = i.deal_id", activities: "activities a" };
export const PIVOT_META = {
  entities: { deals: "Сделки", leads: "Лиды", items: "Позиции сделок", activities: "Активность" },
  metrics: { deals: { count: "сделок", amount: "сумма", avg: "средний чек", won: "выиграно", won_amount: "выручка (выигр.)", conv: "конверсия в выигрыш, %" }, leads: { count: "лидов", converted: "в сделку", conv: "конверсия, %", with_email: "с e-mail", lost: "отказ / не квал" }, items: { qty: "штук", amount: "сумма", deals: "сделок" }, activities: { count: "событий" } },
  dims: { deals: { month: "месяц", week: "неделя", day: "день", quarter: "квартал", city: "город", region: "регион", segment: "сегмент", stage: "этап", outcome: "исход", company: "компания", vat: "НДС", manager: "менеджер", repeat: "новый / повторный" },
    leads: { month: "месяц", week: "неделя", day: "день", city: "город", region: "регион", segment: "сегмент", source: "источник", stage: "этап", outcome: "исход", competitor: "конкурент", priority: "приоритет" },
    items: { month: "месяц", product: "товар", group: "группа", city: "город", company: "компания" }, activities: { day: "день", week: "неделя", month: "месяц", kind: "тип", author: "кто", entity: "объект" } },
};

export function pivot({ entity = "deals", metric = "count", rows = "month", cols = null, from, to, only_won }) {
  if (!FROM[entity] || !METRICS[entity][metric] || !DIMS[entity][rows] || (cols && !DIMS[entity][cols])) throw new Error("bad pivot params");
  const dateCol = DATE_COL[entity](metric);
  const r = DIMS[entity][rows](dateCol), c = cols ? DIMS[entity][cols](dateCol) : "'всего'";
  const where = [`${dateCol} BETWEEN ? AND ?`]; const params = [from, to];
  if (entity === "deals" && only_won) where.push("d.outcome = 'won'");
  if (entity === "items") where.push("d.outcome = 'won'");
  const sql = `SELECT ${r} AS r, ${c} AS c, ${METRICS[entity][metric]} AS v FROM ${FROM[entity]} WHERE ${where.join(" AND ")} GROUP BY r, c ORDER BY r, c`;
  const cells = db.prepare(sql).all(...params);
  const rowKeys = [...new Set(cells.map((x) => String(x.r)))], colKeys = [...new Set(cells.map((x) => String(x.c)))];
  const table = rowKeys.map((rk) => ({ key: rk, cells: colKeys.map((ck) => cells.find((x) => String(x.r) === rk && String(x.c) === ck)?.v ?? 0) }));
  const isAvg = /avg|conv/.test(metric);
  const totals = colKeys.map((_, i) => isAvg ? null : table.reduce((a, row) => a + (row.cells[i] || 0), 0));
  return { rows: rowKeys, cols: colKeys, table, totals, metric, entity };
}

/* ——— готовые отчёты ——— */
export function funnel({ from, to }) {
  const bySource = db.prepare(`SELECT COALESCE(source,'—') source, COUNT(*) total,
      SUM(CASE WHEN stage <> 'new' OR outcome IS NOT NULL THEN 1 ELSE 0 END) touched,
      SUM(CASE WHEN stage IN ('contacted','qualified') OR outcome='won' THEN 1 ELSE 0 END) contacted,
      SUM(CASE WHEN stage='qualified' OR outcome='won' THEN 1 ELSE 0 END) qualified,
      SUM(CASE WHEN outcome='won' THEN 1 ELSE 0 END) won,
      SUM(CASE WHEN outcome='nurture' THEN 1 ELSE 0 END) nurture, SUM(CASE WHEN outcome IN ('lost','unqualified') THEN 1 ELSE 0 END) lost
    FROM leads WHERE created_at BETWEEN ? AND ? GROUP BY source ORDER BY total DESC`).all(from, to);
  const stageNow = LEAD_STAGES.map((s) => ({ ...s, n: db.prepare(`SELECT COUNT(*) n FROM leads WHERE stage = ? AND outcome IS NULL`).get(s.key).n }));
  const dealStages = DEAL_STAGES.map((s) => ({ ...s, ...db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount FROM deals WHERE stage = ? AND outcome IS NULL`).get(s.key) }));
  /* среднее время на этапе лида — по переходам в ленте */
  const timeToDeal = db.prepare(`SELECT ROUND(AVG(julianday(d.created_at) - julianday(l.created_at)),1) days FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.created_at BETWEEN ? AND ?`).get(from, to).days;
  return { bySource, stageNow, dealStages, avg_days_lead_to_deal: timeToDeal };
}
export function sales({ from, to }) {
  const byMonth = db.prepare(`SELECT strftime('%Y-%m', closed_at) m, COUNT(*) n, COALESCE(SUM(amount),0) amount,
      SUM(CASE WHEN (SELECT COUNT(*) FROM deals x WHERE x.company_id = deals.company_id AND x.outcome='won' AND x.closed_at < deals.closed_at) = 0 THEN amount ELSE 0 END) new_amount
    FROM deals WHERE outcome='won' AND closed_at BETWEEN ? AND ? GROUP BY m ORDER BY m`).all(from, to);
  const byCity = db.prepare(`SELECT COALESCE(city,'—') k, COUNT(*) n, COALESCE(SUM(amount),0) amount FROM deals WHERE outcome='won' AND closed_at BETWEEN ? AND ? GROUP BY k ORDER BY amount DESC LIMIT 15`).all(from, to);
  const byGroup = db.prepare(`SELECT COALESCE(p.group_name, '—') k, SUM(i.qty) qty, COALESCE(SUM(i.qty*i.price),0) amount FROM deal_items i JOIN deals d ON d.id = i.deal_id LEFT JOIN products p ON p.id = i.product_id WHERE d.outcome='won' AND d.closed_at BETWEEN ? AND ? GROUP BY k ORDER BY amount DESC`).all(from, to);
  const topProducts = db.prepare(`SELECT i.name k, SUM(i.qty) qty, COALESCE(SUM(i.qty*i.price),0) amount FROM deal_items i JOIN deals d ON d.id = i.deal_id WHERE d.outcome='won' AND d.closed_at BETWEEN ? AND ? GROUP BY k ORDER BY amount DESC LIMIT 10`).all(from, to);
  const totals = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount, COALESCE(AVG(amount),0) avg FROM deals WHERE outcome='won' AND closed_at BETWEEN ? AND ?`).get(from, to);
  return { byMonth, byCity, byGroup, topProducts, totals };
}
export function clients() {
  const top = db.prepare(`SELECT id, name, city, orders_count, total_amount, last_order_at, next_order_at, status FROM companies ORDER BY total_amount DESC LIMIT 20`).all();
  const risk = db.prepare(`SELECT id, name, city, orders_count, total_amount, last_order_at, next_order_at, CAST(julianday('now') - julianday(next_order_at) AS INTEGER) overdue FROM companies WHERE status='active' AND next_order_at IS NOT NULL AND date(next_order_at) < date('now', '-7 days') ORDER BY overdue DESC`).all();
  const summary = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN orders_count > 1 THEN 1 ELSE 0 END) repeat, COALESCE(AVG(CASE WHEN orders_count > 0 THEN total_amount/orders_count END),0) avg_check FROM companies WHERE status='active'`).get();
  return { top, risk, summary };
}
export function activity({ from, to }) {
  const byDay = db.prepare(`SELECT date(created_at) d, SUM(kind='comment') comments, SUM(kind='email') emails, SUM(kind='call') calls, SUM(kind='stage') stages FROM activities WHERE created_at BETWEEN ? AND ? GROUP BY d ORDER BY d`).all(from, to);
  const byAuthor = db.prepare(`SELECT author, COUNT(*) n, SUM(kind='email') emails, SUM(kind='comment') comments, SUM(kind='stage') stages FROM activities WHERE created_at BETWEEN ? AND ? GROUP BY author ORDER BY n DESC`).all(from, to);
  const mail = db.prepare(`SELECT SUM(direction='out') sent, SUM(direction='in') received, SUM(direction='in' AND entity_type IS NULL) unassigned FROM mail_messages WHERE date BETWEEN ? AND ?`).get(from, to);
  const seq = db.prepare(`SELECT COUNT(*) total, SUM(status='active') active, SUM(status='done') done, SUM(status='stopped') stopped, COALESCE(SUM(stop_reason='контакт ответил'),0) replied, COALESCE(SUM(stop_reason='ответ «нет»'),0) said_no, COALESCE(SUM(stop_reason='отлуп'),0) bounced FROM sequence_runs`).get();
  return { byDay, byAuthor, mail, sequences: seq };
}

export function reportsRoutes(app) {
  app.get("/api/reports/meta", (_req, res) => res.json(PIVOT_META));
  app.get("/api/reports/funnel", (req, res) => res.json(funnel(period(req.query))));
  app.get("/api/reports/sales", (req, res) => res.json(sales(period(req.query))));
  app.get("/api/reports/clients", (_req, res) => res.json(clients()));
  app.get("/api/reports/activity", (req, res) => res.json(activity(period(req.query))));
  app.get("/api/reports/pivot", (req, res) => {
    try {
      const p = period(req.query);
      const data = pivot({ entity: req.query.entity, metric: req.query.metric, rows: req.query.rows, cols: req.query.cols || null, from: p.from, to: p.to, only_won: req.query.only_won === "1" });
      if (req.query.format === "csv") {
        const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const lines = [[PIVOT_META.dims[data.entity][req.query.rows], ...data.cols, ...(data.cols.length > 1 ? ["итого"] : [])].map(esc).join(";")];
        for (const r of data.table) lines.push([r.key, ...r.cells, ...(data.cols.length > 1 ? [r.cells.reduce((a, b) => a + b, 0)] : [])].map(esc).join(";"));
        res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="svp-${data.entity}-${req.query.metric}-${req.query.rows}.csv"`);
        return res.send("﻿" + lines.join("\r\n"));
      }
      res.json(data);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}
