/**
 * Компании — постоянные клиенты. Повторные заказы, ритм, напоминания.
 */
import { db, rowToCompany, rowToLead, log, touch, recalcDeal, recalcCompany } from "./db.js";

const FIELDS = ["name", "legal_name", "inn", "vat", "city", "region", "segment", "address", "email", "site",
  "contact_name", "contact_role", "note", "status", "order_interval_days", "next_order_at"];

export function companiesRoutes(app) {
  /* список: q, city, status, due=1 — только те, кому пора заказывать */
  app.get("/api/companies", (req, res) => {
    const { q, city, status, due } = req.query;
    const where = []; const params = [];
    if (status) { where.push("c.status = ?"); params.push(status); }
    if (city) { where.push("c.city = ?"); params.push(city); }
    if (q) { where.push("(c.name LIKE ? OR c.legal_name LIKE ? OR c.inn LIKE ? OR c.city LIKE ? OR c.phones LIKE ? OR c.email LIKE ?)"); params.push(...Array(6).fill(`%${q}%`)); }
    if (due) where.push("c.next_order_at IS NOT NULL AND date(c.next_order_at) <= date('now', '+7 days')");
    const rows = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM deals d WHERE d.company_id = c.id AND d.outcome IS NULL) AS open_deals,
                  (SELECT COALESCE(SUM(amount),0) FROM deals d WHERE d.company_id = c.id AND d.outcome IS NULL) AS open_amount
      FROM companies c ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY CASE WHEN c.next_order_at IS NOT NULL AND date(c.next_order_at) <= date('now') THEN 0 ELSE 1 END, c.updated_at DESC`).all(...params);
    res.json(rows.map(rowToCompany));
  });

  app.get("/api/companies/:id", (req, res) => {
    const c = rowToCompany(db.prepare(`SELECT * FROM companies WHERE id = ?`).get(req.params.id));
    if (!c) return res.status(404).json({ error: "company not found" });
    c.deals = db.prepare(`SELECT * FROM deals WHERE company_id = ? ORDER BY created_at DESC`).all(c.id);
    c.activities = db.prepare(`SELECT * FROM activities WHERE entity_type='company' AND entity_id=? ORDER BY created_at DESC, id DESC`).all(c.id);
    c.lead = c.lead_id ? rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(c.lead_id)) : null;
    res.json(c);
  });

  app.post("/api/companies", (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: "name is required" });
    const info = db.prepare(`INSERT INTO companies (name, legal_name, inn, vat, city, region, segment, address, phones, email, site, contact_name, contact_role, note, order_interval_days)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.name, b.legal_name ?? null, b.inn ?? null, b.vat ?? "без НДС", b.city ?? null, b.region ?? null, b.segment ?? null,
      b.address ?? null, JSON.stringify(b.phones ?? []), b.email ?? null, b.site ?? null, b.contact_name ?? null, b.contact_role ?? null, b.note ?? null, b.order_interval_days ?? null);
    log("company", info.lastInsertRowid, "system", "Компания создана вручную");
    res.status(201).json(rowToCompany(db.prepare(`SELECT * FROM companies WHERE id = ?`).get(info.lastInsertRowid)));
  });

  app.patch("/api/companies/:id", (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id);
    if (!c) return res.status(404).json({ error: "company not found" });
    const b = req.body || {};
    const sets = []; const params = [];
    for (const k of FIELDS) if (k in b) { sets.push(`${k} = ?`); params.push(b[k] === "" ? null : b[k]); }
    if ("phones" in b) { sets.push(`phones = ?`); params.push(JSON.stringify(b.phones)); }
    if ("status" in b && b.status !== c.status) log("company", id, "stage", `Статус: ${c.status} → ${b.status}`);
    if (!sets.length) return res.json(rowToCompany(c));
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    if ("order_interval_days" in b) recalcCompany(id);
    res.json(rowToCompany(db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id)));
  });

  /* Новая сделка для компании. copy_from = id прошлой сделки → копируем позиции по текущему прайсу. */
  app.post("/api/companies/:id/deals", (req, res) => {
    const id = Number(req.params.id);
    const c = rowToCompany(db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id));
    if (!c) return res.status(404).json({ error: "company not found" });
    const b = req.body || {};
    const n = db.prepare(`SELECT COUNT(*) n FROM deals WHERE company_id = ?`).get(id).n + 1;
    const info = db.prepare(`INSERT INTO deals (company_id, lead_id, title, company, city, vat, inn, contact_name, phone, email)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, c.lead_id, b.title || `${c.name} — заказ №${n}`, c.name, c.city, c.vat, c.inn, c.contact_name, c.phones[0] ?? null, c.email);
    const dealId = info.lastInsertRowid;
    let copied = 0;
    if (b.copy_from) {
      const items = db.prepare(`SELECT di.*, p.price AS current_price, p.active FROM deal_items di LEFT JOIN products p ON p.id = di.product_id WHERE di.deal_id = ?`).all(b.copy_from);
      const ins = db.prepare(`INSERT INTO deal_items (deal_id, product_id, name, qty, price) VALUES (?,?,?,?,?)`);
      for (const it of items) { ins.run(dealId, it.product_id, it.name, it.qty, it.current_price ?? it.price); copied++; }
      recalcDeal(dealId);
    }
    log("deal", dealId, "system", copied ? `Повтор заказа #${b.copy_from}: ${copied} позиций по текущему прайсу` : `Сделка создана для компании ${c.name}`);
    log("company", id, "system", `Новая сделка #${dealId}${copied ? " (повтор заказа)" : ""}`);
    touch("companies", id);
    res.status(201).json(db.prepare(`SELECT * FROM deals WHERE id = ?`).get(dealId));
  });

  /* Привязать лид к существующей компании (без новой сделки) */
  app.post("/api/companies/:id/attach-lead", (req, res) => {
    const id = Number(req.params.id); const leadId = Number(req.body?.lead_id);
    if (!db.prepare(`SELECT 1 FROM companies WHERE id = ?`).get(id) || !db.prepare(`SELECT 1 FROM leads WHERE id = ?`).get(leadId)) return res.status(404).json({ error: "not found" });
    db.prepare(`UPDATE leads SET company_id = ?, outcome = 'won', updated_at = datetime('now') WHERE id = ?`).run(id, leadId);
    log("lead", leadId, "stage", `Привязан к компании #${id}`);
    res.json({ ok: true });
  });

  /* Разовая миграция: сделки без компании → компании по названию+городу */
  app.post("/api/companies/migrate", (_req, res) => {
    const deals = db.prepare(`SELECT * FROM deals WHERE company_id IS NULL AND company IS NOT NULL`).all();
    let created = 0, linked = 0;
    for (const d of deals) {
      let c = db.prepare(`SELECT id FROM companies WHERE lower(name) = lower(?) AND COALESCE(city,'') = COALESCE(?, '')`).get(d.company, d.city);
      if (!c) {
        const lead = d.lead_id ? rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(d.lead_id)) : null;
        const info = db.prepare(`INSERT INTO companies (name, inn, vat, city, region, segment, phones, email, site, contact_name, lead_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(d.company, d.inn ?? null, d.vat ?? "без НДС", d.city ?? null, lead?.region ?? null, lead?.segment ?? null, JSON.stringify(lead?.phones ?? (d.phone ? [d.phone] : [])), d.email ?? lead?.email ?? null, lead?.site ?? null, d.contact_name ?? null, d.lead_id ?? null);
        c = { id: info.lastInsertRowid }; created++;
        if (d.lead_id) db.prepare(`UPDATE leads SET company_id = ? WHERE id = ?`).run(c.id, d.lead_id);
      }
      db.prepare(`UPDATE deals SET company_id = ? WHERE id = ?`).run(c.id, d.id); linked++;
      recalcCompany(c.id);
    }
    res.json({ created, linked });
  });
}
