/**
 * «Сегодня» — очередь дел менеджера сверху вниз по важности:
 * неразобранные письма → ответы контактов → касания на сегодня → пора заказывать → зависшие сделки.
 * Плюс счётчик сделанного за день.
 */
import { db, rowToLead, rowToCompany } from "./db.js";

const STALE_DAYS = 7;

/* Сборка очереди: userId — для «моих» и счётчика; mine — только мои */
export function buildToday(user, mine) {
  { const req = { user, query: { scope: mine ? "mine" : "" } }; const res = { json: (v) => v }; return handler(req, res); }
}
function handler(req, res) {
  {
    const mine = req.query.scope === "mine"; const uid = req.user?.id;
    const own = (alias) => mine ? ` AND ${alias}owner_id = ${Number(uid)}` : "";
    const unassigned = db.prepare(`SELECT id, account, from_addr, from_name, subject, snippet, date FROM mail_messages WHERE entity_type IS NULL AND direction = 'in' ORDER BY date DESC LIMIT 20`).all();

    /* ответили: входящие за 7 дней по лидам/компаниям/сделкам, на которые мы ещё не ответили (нет нашего письма позже) */
    const replied = db.prepare(`
      SELECT m.id AS mail_id, m.entity_type, m.entity_id, m.from_addr, m.from_name, m.subject, m.snippet, m.date, m.seen,
        CASE m.entity_type WHEN 'lead' THEN (SELECT company FROM leads WHERE id = m.entity_id) WHEN 'company' THEN (SELECT name FROM companies WHERE id = m.entity_id) ELSE (SELECT title FROM deals WHERE id = m.entity_id) END AS title
      FROM mail_messages m
      WHERE m.direction = 'in' AND m.entity_type IN ('lead','company','deal') AND m.date >= datetime('now', '-7 days')
        AND m.subject NOT LIKE 'Заявка на дилерство СВП%'
        AND NOT EXISTS (SELECT 1 FROM mail_messages o WHERE o.direction = 'out' AND o.entity_type = m.entity_type AND o.entity_id = m.entity_id AND o.date > m.date)
        ${mine ? `AND COALESCE(CASE m.entity_type WHEN 'lead' THEN (SELECT owner_id FROM leads WHERE id = m.entity_id) WHEN 'company' THEN (SELECT owner_id FROM companies WHERE id = m.entity_id) ELSE (SELECT owner_id FROM deals WHERE id = m.entity_id) END, ${Number(uid)}) = ${Number(uid)}` : ""}
      ORDER BY m.date DESC LIMIT 30`).all();

    /* касания: лиды, сделки, компании с датой следующего действия <= сегодня */
    const touches = [
      ...db.prepare(`SELECT id, company AS title, city, next_action, next_at, 'lead' AS type, stage, phones FROM leads WHERE outcome IS NULL AND next_at IS NOT NULL AND date(next_at) <= date('now')${own("")}`).all().map((x) => ({ ...x, phone: JSON.parse(x.phones || "[]")[0] })),
      ...db.prepare(`SELECT id, title, city, next_action, next_at, 'deal' AS type, stage, phone FROM deals WHERE outcome IS NULL AND next_at IS NOT NULL AND date(next_at) <= date('now')${own("")}`).all(),
    ].sort((a, b) => a.next_at.localeCompare(b.next_at));

    const reorder = db.prepare(`SELECT id, name, city, next_order_at, last_order_at, orders_count, total_amount, phones, email, contact_name, order_habit FROM companies
      WHERE status = 'active' AND next_order_at IS NOT NULL AND date(next_order_at) <= date('now', '+7 days')${own("")}
        AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.company_id = companies.id AND d.outcome IS NULL) ORDER BY next_order_at`).all().map(rowToCompany);

    const stale = db.prepare(`SELECT d.id, d.title, d.city, d.stage, d.amount, d.updated_at, d.company_id,
        CAST(julianday('now') - julianday(d.updated_at) AS INTEGER) AS days
      FROM deals d WHERE d.outcome IS NULL AND d.updated_at < datetime('now', '-${STALE_DAYS} days')${own("d.")} ORDER BY d.updated_at LIMIT 20`).all();

    /* заявки с сайта, к которым ещё никто не прикасался: ни звонка, ни комментария, ни нашего письма */
    const fresh = db.prepare(`SELECT id, company, city, contact_name, phones, email, created_at, source FROM leads WHERE outcome IS NULL AND source = 'site'
        AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.entity_type = 'lead' AND a.entity_id = leads.id AND (a.kind IN ('call','comment') OR (a.kind = 'email' AND a.text LIKE 'Отправлено%')))${mine ? ` AND (owner_id = ${Number(uid)} OR owner_id IS NULL)` : ""} ORDER BY created_at DESC LIMIT 20`).all().map(rowToLead);

    const me = req.user?.name;
    const done = db.prepare(`SELECT kind, COUNT(*) n FROM activities WHERE date(created_at) = date('now') ${me ? "AND author = ?" : ""} GROUP BY kind`).all(...(me ? [me] : []));
    const doneMap = Object.fromEntries(done.map((d) => [d.kind, d.n]));
    const won_today = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount FROM deals WHERE outcome = 'won' AND date(closed_at) = date('now')`).get();
    const seq = db.prepare(`SELECT COUNT(*) n FROM activities WHERE kind = 'email' AND author = 'цепочка' AND date(created_at) = date('now')`).get().n;

    return res.json({ unassigned, replied, touches, reorder, stale, fresh, done: { comments: doneMap.comment || 0, emails: doneMap.email || 0, calls: doneMap.call || 0, stages: doneMap.stage || 0, won: won_today, sequence_sent: seq } });
  }
}
export function todayRoutes(app) { app.get("/api/today", handler); }
