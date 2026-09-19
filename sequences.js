/**
 * Цепочки писем: холодный заход по лидам небольшими порциями, чтобы ящик не попал под блокировку.
 *
 * Настройки хранятся в таблице settings (правятся из интерфейса):
 *   seq_daily_limit  — писем в день (старт 10, разгон до 30)
 *   seq_hours        — рабочие часы «9:30-17:30» по Москве, пн–пт
 *   seq_account      — ящик отправки (dealers)
 * Шаблоны и заходы берутся из public/scripts-data.js — тот же источник, что и в карточке лида.
 * Автостоп: ответ контакта (любое входящее письмо по лиду), смена этапа/исхода, отлуп (bounce),
 * ответ «нет / не актуально / отпишите» → исход «Отказ».
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { db, log, rowToLead, requestContext } from "./db.js";
import { sendMail, accounts, inboundHooks } from "./mail.js";

const ROOT = dirname(fileURLToPath(import.meta.url));

/* ——— настройки ——— */
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sequence_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence    TEXT NOT NULL DEFAULT 'cold',
  step        INTEGER DEFAULT 0,             -- сколько писем уже ушло
  status      TEXT DEFAULT 'active',         -- active | done | stopped
  next_at     TEXT,                          -- когда слать следующее
  started_at  TEXT DEFAULT (datetime('now')),
  stopped_at  TEXT, stop_reason TEXT,
  started_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_seq_due ON sequence_runs(status, next_at);`);
const DEFAULTS = { seq_daily_limit: "10", seq_hours: "9:30-17:30", seq_account: "dealers", seq_enabled: "0" };
export const getSetting = (k) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k)?.value ?? DEFAULTS[k];
export const setSetting = (k, v) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, String(v));

/* ——— цепочки: шаги = шаблоны из scripts-data.js с задержкой в днях ——— */
export const SEQUENCES = {
  cold: { title: "Холодный заход", steps: [{ template: "first", delay: 0 }, { template: "follow", delay: 4 }, { template: "samples", delay: 7 }] },
};
function loadScripts() {
  const src = readFileSync(join(ROOT, "public", "scripts-data.js"), "utf8");
  const ctx = { window: {} }; vm.runInNewContext(src, ctx); return ctx.window.SCRIPTS;
}
const cityLoc = (c) => !c ? "вашем городе" : c === "Ростов-на-Дону" ? "Ростове-на-Дону" : /ь$/.test(c) ? c.replace(/ь$/, "и") : /а$/.test(c) ? c.replace(/а$/, "е") : /[ыи]$/.test(c) ? c : c + "е";
export function renderTemplate(templateKey, lead) {
  const S = loadScripts();
  const t = S.emails.find((e) => e.key === templateKey); if (!t) throw new Error("template " + templateKey);
  const pitch = lead.competitor ? S.pitches.find((p) => p.competitor) : (S.pitches.find((p) => p.match && new RegExp(p.match.source, "i").test(lead.segment || "")) || S.pitches.find((p) => p.key === "store"));
  const sig = { ...S.signature, manager: getSetting("seq_signature_name") || S.signature.manager, phone: getSetting("seq_signature_phone") || S.signature.phone, email: getSetting("seq_account") + "@svpbrand.com" };
  const name = (lead.contact_name || "").trim();
  const map = { company: lead.company, city: lead.city || "", cityLoc: cityLoc(lead.city), name, nameComma: name ? ", " + name : "", nameOrHello: name || "Здравствуйте",
    competitor: lead.competitor || "текущим поставщиком", segmentParagraph: pitch?.email || "", manager: sig.manager, phone: sig.phone, email: sig.email };
  const fill = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] ?? "");
  const footer = "\n\nЕсли предложение неактуально — просто ответьте «нет», больше не побеспокоим.";
  let body = fill(t.body);
  if (templateKey === "first") body = body.replace(/Во вложении дилерский прайс и презентация\./, "Дилерский прайс и презентацию пришлю следующим письмом — или сразу отвечу на вопросы по телефону.");
  return { subject: fill(t.subject), text: body + (templateKey === "first" ? footer : "") };
}

/* ——— запуск / остановка ——— */
export function startRuns(leadIds, sequence = "cold", by = "менеджер") {
  const seq = SEQUENCES[sequence]; if (!seq) throw new Error("bad sequence");
  let started = 0, skipped = [];
  const ins = db.prepare(`INSERT INTO sequence_runs (lead_id, sequence, next_at, started_by) VALUES (?, ?, datetime('now'), ?)`);
  for (const id of leadIds) {
    const l = rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id));
    if (!l) continue;
    if (!l.email) { skipped.push({ id, reason: "нет e-mail" }); continue; }
    if (l.outcome) { skipped.push({ id, reason: "лид закрыт" }); continue; }
    if (db.prepare(`SELECT 1 FROM sequence_runs WHERE lead_id = ? AND status = 'active'`).get(id)) { skipped.push({ id, reason: "уже в цепочке" }); continue; }
    ins.run(id, sequence, by); started++;
    log("lead", id, "system", `Запущена цепочка «${seq.title}»`);
  }
  return { started, skipped };
}
export function stopRun(leadId, reason) {
  const r = db.prepare(`UPDATE sequence_runs SET status = 'stopped', stopped_at = datetime('now'), stop_reason = ? WHERE lead_id = ? AND status = 'active'`).run(reason, leadId);
  if (r.changes) log("lead", leadId, "system", `Цепочка остановлена: ${reason}`, null, "система");
  return r.changes;
}

/* ——— реакция на входящее письмо (вызывается из mail.js) ——— */
export function onInboundMail(msg, entity) {
  if (!entity || entity.entity_type !== "lead") return;
  const text = (msg.text || "").trim().slice(0, 300).toLowerCase();
  if (/^(нет|не актуально|неактуально|отпишите|не интересует|не нужно|unsubscribe)(?=[\s,.!;:)]|$)/.test(text)) {
    db.prepare(`UPDATE leads SET outcome = 'lost', updated_at = datetime('now') WHERE id = ? AND outcome IS NULL`).run(entity.entity_id);
    log("lead", entity.entity_id, "stage", "Исход: Отказ — контакт ответил «нет»", null, "система");
    stopRun(entity.entity_id, "ответ «нет»");
  } else stopRun(entity.entity_id, "контакт ответил");
}
/* отлуп: письмо от mailer-daemon с нашим адресатом в теле → e-mail лида невалиден */
export function onBounce(msg) {
  if (!/mailer-daemon|postmaster|mail delivery|undeliver|не доставлено/i.test((msg.from_addr || "") + " " + (msg.subject || ""))) return false;
  const emails = [...new Set((msg.text || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])].map((e) => e.toLowerCase()).filter((e) => !e.endsWith("@svpbrand.com"));
  for (const e of emails) {
    const l = db.prepare(`SELECT id FROM leads WHERE lower(email) = ?`).get(e);
    if (l) { db.prepare(`UPDATE leads SET source_note = COALESCE(source_note,'') || ' · e-mail не доставляется', updated_at = datetime('now') WHERE id = ?`).run(l.id); log("lead", l.id, "system", `Письмо не доставлено (${e}) — адрес невалиден`, null, "система"); stopRun(l.id, "отлуп"); return true; }
  }
  return false;
}

inboundHooks.push((msg, entity) => { if (!onBounce(msg)) onInboundMail(msg, entity); });

/* ——— планировщик ——— */
const MSK = 3 * 3600000;
function inWorkHours(now = new Date()) {
  const msk = new Date(now.getTime() + MSK);
  const day = msk.getUTCDay(); if (day === 0 || day === 6) return false;
  const [from, to] = getSetting("seq_hours").split("-").map((s) => { const [h, m = 0] = s.trim().split(":").map(Number); return h * 60 + m; });
  const cur = msk.getUTCHours() * 60 + msk.getUTCMinutes();
  return cur >= from && cur < to;
}
export function sentToday() {
  return db.prepare(`SELECT COUNT(*) n FROM activities WHERE kind = 'email' AND author = 'цепочка' AND date(created_at) = date('now')`).get().n;
}
let ticking = false;
export async function tick() {
  if (ticking || getSetting("seq_enabled") !== "1" || !accounts.length || !inWorkHours()) return;
  ticking = true;
  try {
    const limit = Number(getSetting("seq_daily_limit")); if (sentToday() >= limit) return;
    const run = db.prepare(`SELECT r.*, l.outcome FROM sequence_runs r JOIN leads l ON l.id = r.lead_id WHERE r.status = 'active' AND r.next_at <= datetime('now') ORDER BY r.next_at LIMIT 1`).get();
    if (!run) return;
    if (run.outcome) { stopRun(run.lead_id, "лид закрыт"); return; }
    const seq = SEQUENCES[run.sequence]; const step = seq.steps[run.step];
    if (!step) { db.prepare(`UPDATE sequence_runs SET status = 'done', stopped_at = datetime('now') WHERE id = ?`).run(run.id); return; }
    const lead = rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(run.lead_id));
    const { subject, text } = renderTemplate(step.template, lead);
    const files = step.template === "first" ? [] : ["svp-dealer-price.pdf"];  // в первом письме без вложений — меньше шансов на спам
    await requestContext.run({ user: { name: "цепочка" } }, () => sendMail({ accountKey: getSetting("seq_account"), to: lead.email, subject, text, entity: { entity_type: "lead", entity_id: lead.id }, attachments: files.map((f) => ({ filename: f, path: join(ROOT, "public", "files", f) })) }));
    const next = seq.steps[run.step + 1];
    if (next) {
      // следующий шаг через delay дней, +случайный сдвиг 0–90 минут внутри дня
      db.prepare(`UPDATE sequence_runs SET step = step + 1, next_at = datetime('now', '+${next.delay} days', '+${Math.floor(Math.random() * 90)} minutes') WHERE id = ?`).run(run.id);
    } else db.prepare(`UPDATE sequence_runs SET step = step + 1, status = 'done', stopped_at = datetime('now') WHERE id = ?`).run(run.id);
    if (lead.stage === "new") db.prepare(`UPDATE leads SET stage = 'contacting', updated_at = datetime('now') WHERE id = ?`).run(lead.id);
  } catch (e) { console.error("sequence tick:", e.message); }
  finally { ticking = false; }
}
export function startSequences() {
  // тик каждые 10–25 минут случайно — письма уходят не залпом
  const loop = () => { tick().finally(() => setTimeout(loop, (10 + Math.random() * 15) * 60000)); };
  setTimeout(loop, 20000);
}

/* ——— API ——— */
export function sequencesRoutes(app) {
  app.get("/api/sequences", (_req, res) => {
    const stats = db.prepare(`SELECT status, COUNT(*) n FROM sequence_runs GROUP BY status`).all();
    res.json({ sequences: Object.entries(SEQUENCES).map(([key, s]) => ({ key, ...s })), settings: Object.fromEntries(Object.keys(DEFAULTS).concat(["seq_signature_name", "seq_signature_phone"]).map((k) => [k, getSetting(k) ?? ""])), stats, sent_today: sentToday(), in_work_hours: inWorkHours(),
      queue: db.prepare(`SELECT r.id, r.lead_id, r.step, r.next_at, l.company, l.city, l.email FROM sequence_runs r JOIN leads l ON l.id = r.lead_id WHERE r.status = 'active' ORDER BY r.next_at LIMIT 50`).all() });
  });
  app.post("/api/sequences/settings", (req, res) => { for (const [k, v] of Object.entries(req.body || {})) if (k.startsWith("seq_")) setSetting(k, v); res.json({ ok: true }); });
  app.post("/api/sequences/start", (req, res) => {
    const { lead_ids, sequence } = req.body || {};
    if (!Array.isArray(lead_ids) || !lead_ids.length) return res.status(400).json({ error: "lead_ids required" });
    res.json(startRuns(lead_ids.map(Number), sequence || "cold", req.user?.name));
  });
  app.post("/api/sequences/stop", (req, res) => res.json({ stopped: stopRun(Number(req.body?.lead_id), "остановлена менеджером") }));
  app.get("/api/sequences/preview/:leadId/:template", (req, res) => {
    const lead = rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.leadId));
    if (!lead) return res.status(404).json({ error: "lead not found" });
    res.json(renderTemplate(req.params.template, lead));
  });
  app.post("/api/sequences/tick", async (_req, res) => { await tick(); res.json({ sent_today: sentToday() }); });
}
