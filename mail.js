/**
 * Почта: IMAP-синхронизация ящиков Beget, привязка писем к лиду / компании / сделке,
 * отправка через SMTP с сохранением цепочки и копией в «Отправленные».
 *
 * Настройки в окружении:
 *   MAIL_HOST=imap.beget.com  SMTP_HOST=smtp.beget.com
 *   MAIL_ACCOUNTS=dealers@svpbrand.com,sales@svpbrand.com
 *   MAIL_PASS_dealers=…  MAIL_PASS_sales=…   (ключ — часть адреса до @)
 *   CRM_FILES=/var/lib/svp-crm/files              (вложения)
 * Без MAIL_ACCOUNTS модуль молчит — локальная разработка без почты.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, log, touch, currentUser } from "./db.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
export const FILES_DIR = process.env.CRM_FILES || join(ROOT, "data", "files");
mkdirSync(FILES_DIR, { recursive: true });

const IMAP_HOST = process.env.MAIL_HOST || "imap.beget.com";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.beget.com";
const FOLDERS = { inbox: "INBOX", sent: "INBOX.Sent" };
const SYNC_EVERY = Number(process.env.MAIL_SYNC_SECONDS || 60) * 1000;
const OWN_DOMAIN = "svpbrand.com";

export const accounts = (process.env.MAIL_ACCOUNTS || "").split(",").map((s) => s.trim()).filter(Boolean).map((address) => {
  const key = address.split("@")[0];
  return { key, address, password: process.env[`MAIL_PASS_${key}`] || "" };
}).filter((a) => a.password);
const accountByKey = (k) => accounts.find((a) => a.key === k);

const parseJson = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const norm = (a) => String(a || "").trim().toLowerCase();
export function rowToMessage(r) {
  if (!r) return null;
  return { ...r, to_addrs: parseJson(r.to_addrs, []), cc_addrs: parseJson(r.cc_addrs, []), refs: parseJson(r.refs, []), has_attachments: !!r.has_attachments, seen: !!r.seen };
}

/* ——— к кому относится письмо ———
   1) по Message-ID цепочки (ответ на наше письмо), 2) по адресу контакта в компании / лиде / сделке. */
export function matchEntity({ addresses, inReplyTo, refs }) {
  const ids = [inReplyTo, ...(refs || [])].filter(Boolean);
  if (ids.length) {
    const q = db.prepare(`SELECT entity_type, entity_id FROM mail_messages WHERE message_id IN (${ids.map(() => "?").join(",")}) AND entity_type IS NOT NULL AND entity_id IS NOT NULL ORDER BY date DESC LIMIT 1`).get(...ids);
    if (q) return { entity_type: q.entity_type, entity_id: q.entity_id, by: "thread" };
  }
  const addrs = [...new Set(addresses.map(norm).filter((a) => a && !a.endsWith("@" + OWN_DOMAIN)))];
  for (const a of addrs) {
    const c = db.prepare(`SELECT id FROM companies WHERE lower(email) = ? ORDER BY updated_at DESC LIMIT 1`).get(a);
    if (c) return { entity_type: "company", entity_id: c.id, by: "email" };
    const d = db.prepare(`SELECT id FROM deals WHERE lower(email) = ? AND outcome IS NULL ORDER BY updated_at DESC LIMIT 1`).get(a);
    if (d) return { entity_type: "deal", entity_id: d.id, by: "email" };
    const l = db.prepare(`SELECT id FROM leads WHERE lower(email) = ? ORDER BY updated_at DESC LIMIT 1`).get(a);
    if (l) return { entity_type: "lead", entity_id: l.id, by: "email" };
  }
  return null;
}

const TABLE = { lead: "leads", company: "companies", deal: "deals" };
/* Подписчики на входящие письма: (msg, entity) => void. Регистрирует sequences.js. */
export const inboundHooks = [];
function noteInFeed(msg, entity) {
  const who = msg.direction === "in" ? `от ${msg.from_name || msg.from_addr}` : `→ ${(msg.to_addrs[0]?.address) || ""}`;
  log(entity.entity_type, entity.entity_id, "email", `${msg.direction === "in" ? "Письмо" : "Отправлено"} ${who}: ${msg.subject || "(без темы)"}`, { mail_id: msg.id, direction: msg.direction }, msg.direction === "in" ? msg.account + "@" : undefined);
  touch(TABLE[entity.entity_type], entity.entity_id);
}

/* ——— заявка с сайта svpbrand.com: письмо формы → лид со всеми полями ———
   Формат тела задаёт api/dealer.php: «Номер: …», «Имя: …», «Телефон: …» и т.д. */
const SITE_SUBJECT = /^Заявка на дилерство СВП/i;
function parseSiteApplication(text) {
  const get = (label) => (text.match(new RegExp(`^${label}:\\s*(.*)$`, "mi")) || [])[1]?.trim() || "";
  const f = { number: get("Номер"), name: get("Имя"), phone: get("Телефон"), email: norm(get("Email")), region: get("Регион"), company: get("Компания"), inn: get("ИНН"), vat: get("Вариант") };
  const msg = text.split(/^Сообщение:\s*/m)[1]?.split(/^Вариант:/m)[0]?.trim() || "";
  return f.number && (f.company || f.name) ? { ...f, message: msg } : null;
}
function leadFromSiteApplication(f, subject) {
  const ext = `site-${f.number}`;
  const existing = db.prepare(`SELECT id FROM leads WHERE ext_id = ?`).get(ext);
  if (existing) return existing.id;
  const note = [`Заявка с сайта № ${f.number}`, f.message ? `Сообщение: ${f.message}` : null].filter(Boolean).join(" · ");
  const info = db.prepare(`INSERT INTO leads (ext_id, company, city, phones, email, contact_name, source, source_note, priority, stage, inn, vat) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ext, f.company || f.name, f.region || null, JSON.stringify(f.phone ? [f.phone] : []), f.email || null, f.name || null, "site", note, "высокий", "new", f.inn || null, f.vat ? (/^с/i.test(f.vat) ? "с НДС" : "без НДС") : null);
  log("lead", info.lastInsertRowid, "system", `Заявка с сайта svpbrand.com № ${f.number}${f.vat ? " · " + f.vat : ""}`, { inn: f.inn, vat: f.vat }, "сайт");
  return info.lastInsertRowid;
}

/* ——— сохранить разобранное письмо ——— */
function saveParsed(acc, folder, uid, parsed, { direction, entity } = {}) {
  const messageId = parsed.messageId || `<gen-${createHash("sha1").update(acc.key + folder + uid + (parsed.date || "")).digest("hex")}@crm.local>`;
  if (db.prepare(`SELECT 1 FROM mail_messages WHERE message_id = ?`).get(messageId)) return null;
  const from = parsed.from?.value?.[0] || {};
  const to = (parsed.to?.value || []).map((v) => ({ address: norm(v.address), name: v.name || "" }));
  const cc = (parsed.cc?.value || []).map((v) => ({ address: norm(v.address), name: v.name || "" }));
  const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const text = parsed.text || (parsed.html ? String(parsed.html).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
  // заявка с сайта: From = наш ящик, но по смыслу это входящее от заявителя (адрес — в Reply-To)
  let siteApp = null;
  if (SITE_SUBJECT.test(parsed.subject || "") && folder !== "sent") {
    siteApp = parseSiteApplication(text);
    if (siteApp) {
      direction = "in";
      const reply = parsed.replyTo?.value?.[0];
      if (reply?.address) { from.address = reply.address; from.name = siteApp.name || reply.name || ""; }
      else if (siteApp.email) { from.address = siteApp.email; from.name = siteApp.name; }
      entity = { entity_type: "lead", entity_id: leadFromSiteApplication(siteApp, parsed.subject) };
    }
  }
  direction = direction || (norm(from.address).endsWith("@" + OWN_DOMAIN) ? "out" : "in");
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 200);
  const counterpart = direction === "in" ? [from.address, ...to.map((t) => t.address)] : [...to.map((t) => t.address), ...cc.map((t) => t.address)];
  entity = entity || matchEntity({ addresses: counterpart, inReplyTo: parsed.inReplyTo, refs });
  const info = db.prepare(`INSERT INTO mail_messages (account, folder, uid, message_id, in_reply_to, refs, direction, from_addr, from_name, to_addrs, cc_addrs, subject, text, html, snippet, date, has_attachments, entity_type, entity_id, seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    acc.key, folder, uid ?? null, messageId, parsed.inReplyTo ?? null, JSON.stringify(refs), direction, norm(from.address), from.name || "", JSON.stringify(to), JSON.stringify(cc),
    parsed.subject || "", text, parsed.html ? String(parsed.html).slice(0, 500000) : null, snippet, (parsed.date || new Date()).toISOString().slice(0, 19).replace("T", " "),
    parsed.attachments?.length ? 1 : 0, entity?.entity_type ?? null, entity?.entity_id ?? null, direction === "out" ? 1 : 0);
  const id = info.lastInsertRowid;
  for (const a of parsed.attachments || []) {
    if (a.contentDisposition === "inline" && !a.filename) continue;
    const sub = join(String(new Date().getFullYear()), String(id));
    mkdirSync(join(FILES_DIR, sub), { recursive: true });
    const safe = (a.filename || "file").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);
    const rel = join(sub, `${randomBytes(4).toString("hex")}-${safe}`);
    writeFileSync(join(FILES_DIR, rel), a.content);
    db.prepare(`INSERT INTO mail_attachments (message_id, filename, content_type, size, path) VALUES (?,?,?,?,?)`).run(id, a.filename || safe, a.contentType || "application/octet-stream", a.size || a.content.length, rel);
  }
  const msg = rowToMessage(db.prepare(`SELECT * FROM mail_messages WHERE id = ?`).get(id));
  if (entity) noteInFeed(msg, entity);
  if (direction === "in" && !siteApp) for (const h of inboundHooks) { try { h(msg, entity); } catch (e) { console.error("inbound hook:", e.message); } }
  return msg;
}

/* ——— IMAP-синхронизация одного ящика ——— */
let syncing = false;
export async function syncAccount(acc) {
  const client = new ImapFlow({ host: IMAP_HOST, port: 993, secure: true, auth: { user: acc.address, pass: acc.password }, logger: false });
  const result = { account: acc.key, added: 0 };
  await client.connect();
  try {
    for (const [folder, path] of Object.entries(FOLDERS)) {
      const lock = await client.getMailboxLock(path);
      try {
        const state = db.prepare(`SELECT * FROM mail_state WHERE account = ? AND folder = ?`).get(acc.key, folder) || { last_uid: 0, uidvalidity: null };
        const uidvalidity = Number(client.mailbox.uidValidity);
        let lastUid = state.uidvalidity === uidvalidity ? state.last_uid : 0;  // сменился uidvalidity — перечитываем всё (дубли отсекутся по Message-ID)
        const range = `${lastUid + 1}:*`;
        for await (const m of client.fetch(range, { uid: true, source: true, flags: true }, { uid: true })) {
          if (m.uid <= lastUid) continue;
          try {
            const parsed = await simpleParser(m.source);
            const saved = saveParsed(acc, folder, m.uid, parsed, { direction: folder === "sent" ? "out" : undefined });
            if (saved) { result.added++; if (folder === "inbox" && m.flags?.has("\\Seen")) db.prepare(`UPDATE mail_messages SET seen = 1 WHERE id = ?`).run(saved.id); }
          } catch (e) { console.error(`mail parse ${acc.key}/${folder}#${m.uid}:`, e.message); }
          lastUid = Math.max(lastUid, m.uid);
        }
        db.prepare(`INSERT INTO mail_state (account, folder, uidvalidity, last_uid, synced_at) VALUES (?,?,?,?,datetime('now'))
          ON CONFLICT(account, folder) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid, synced_at = excluded.synced_at`).run(acc.key, folder, uidvalidity, lastUid);
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }
  return result;
}

export async function syncAll() {
  if (syncing || !accounts.length) return [];
  syncing = true;
  const out = [];
  try { for (const acc of accounts) { try { out.push(await syncAccount(acc)); } catch (e) { console.error(`mail sync ${acc.key}:`, e.message); out.push({ account: acc.key, error: e.message }); } } }
  finally { syncing = false; }
  return out;
}
export function startMailSync() {
  if (!accounts.length) { console.log("почта: MAIL_ACCOUNTS не задан — синхронизация выключена"); return; }
  console.log(`почта: ${accounts.map((a) => a.address).join(", ")} · синхронизация каждые ${SYNC_EVERY / 1000}с`);
  setTimeout(() => syncAll().then((r) => console.log("почта: первичная синхронизация", JSON.stringify(r))), 3000);
  setInterval(syncAll, SYNC_EVERY);
}

/* ——— отправка ——— */
export async function sendMail({ accountKey, to, cc, subject, text, inReplyTo, entity, attachments = [] }) {
  const acc = accountByKey(accountKey) || accounts[0];
  if (!acc) throw new Error("почтовые ящики не настроены");
  const user = currentUser();
  const fromName = user?.name ? `${user.name} · СВП` : "СВП";
  const headers = {};
  let refs = [];
  if (inReplyTo) {
    const parent = rowToMessage(db.prepare(`SELECT * FROM mail_messages WHERE message_id = ? OR id = ?`).get(inReplyTo, Number(inReplyTo) || 0));
    if (parent) { headers["In-Reply-To"] = parent.message_id; refs = [...parent.refs, parent.message_id].slice(-20); headers["References"] = refs.join(" "); if (!subject) subject = /^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`; }
  }
  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: 465, secure: true, auth: { user: acc.address, pass: acc.password } });
  const mail = { from: { name: fromName, address: acc.address }, to, cc: cc || undefined, subject, text, headers, attachments: attachments.map((a) => ({ filename: a.filename, path: a.path, contentType: a.contentType })) };
  const info = await transporter.sendMail(mail);
  // копия в «Отправленные» — Beget SMTP сам её не кладёт
  const raw = await new Promise((res, rej) => nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({ ...mail, messageId: info.messageId }, (e, i) => e ? rej(e) : res(i.message)));
  try {
    const client = new ImapFlow({ host: IMAP_HOST, port: 993, secure: true, auth: { user: acc.address, pass: acc.password }, logger: false });
    await client.connect(); await client.append(FOLDERS.sent, raw, ["\\Seen"]); await client.logout();
  } catch (e) { console.error("mail append Sent:", e.message); }
  const parsed = await simpleParser(raw);
  const saved = saveParsed(acc, "sent", null, parsed, { direction: "out", entity }) || rowToMessage(db.prepare(`SELECT * FROM mail_messages WHERE message_id = ?`).get(info.messageId));
  return saved;
}

/* ——— API ——— */
export function mailRoutes(app) {
  app.get("/api/mail/accounts", (_req, res) => res.json(accounts.map((a) => ({ key: a.key, address: a.address }))));

  /* письма сущности */
  app.get("/api/mail/for/:type/:id", (req, res) => {
    const { type, id } = req.params;
    if (!TABLE[type]) return res.status(400).json({ error: "bad type" });
    // для компании — плюс письма её сделок и исходного лида, чтобы вся переписка была в одном месте
    let rows;
    if (type === "company") {
      const c = db.prepare(`SELECT lead_id FROM companies WHERE id = ?`).get(id);
      rows = db.prepare(`SELECT * FROM mail_messages WHERE (entity_type='company' AND entity_id=?) OR (entity_type='deal' AND entity_id IN (SELECT id FROM deals WHERE company_id=?)) OR (entity_type='lead' AND entity_id=?) ORDER BY date DESC LIMIT 200`).all(id, id, c?.lead_id ?? -1);
    } else rows = db.prepare(`SELECT * FROM mail_messages WHERE entity_type = ? AND entity_id = ? ORDER BY date DESC LIMIT 200`).all(type, id);
    res.json(rows.map((r) => { const m = rowToMessage(r); delete m.html; return m; }));
  });

  app.get("/api/mail/messages/:id", (req, res) => {
    const m = rowToMessage(db.prepare(`SELECT * FROM mail_messages WHERE id = ?`).get(req.params.id));
    if (!m) return res.status(404).json({ error: "not found" });
    m.attachments = db.prepare(`SELECT id, filename, content_type, size FROM mail_attachments WHERE message_id = ?`).all(m.id);
    if (!m.seen) db.prepare(`UPDATE mail_messages SET seen = 1 WHERE id = ?`).run(m.id);
    res.json(m);
  });

  app.get("/api/mail/attachments/:id", (req, res) => {
    const a = db.prepare(`SELECT * FROM mail_attachments WHERE id = ?`).get(req.params.id);
    if (!a) return res.status(404).end();
    res.setHeader("Content-Type", a.content_type);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    res.sendFile(join(FILES_DIR, a.path));
  });

  /* неразобранное: входящие без привязки */
  app.get("/api/mail/unassigned", (_req, res) => {
    res.json(db.prepare(`SELECT id, account, from_addr, from_name, subject, snippet, date, has_attachments, seen FROM mail_messages WHERE entity_type IS NULL AND direction = 'in' ORDER BY date DESC LIMIT 200`).all());
  });
  app.get("/api/mail/recent", (_req, res) => {
    res.json(db.prepare(`SELECT id, account, direction, from_addr, from_name, to_addrs, subject, snippet, date, entity_type, entity_id, has_attachments, seen FROM mail_messages ORDER BY date DESC LIMIT 100`).all().map((r) => ({ ...r, to_addrs: parseJson(r.to_addrs, []) })));
  });

  /* привязать письмо (и всю его цепочку с тем же адресом) к сущности */
  app.post("/api/mail/messages/:id/assign", (req, res) => {
    const m = rowToMessage(db.prepare(`SELECT * FROM mail_messages WHERE id = ?`).get(req.params.id));
    if (!m) return res.status(404).json({ error: "not found" });
    const { entity_type, entity_id, remember } = req.body || {};
    if (!TABLE[entity_type] || !entity_id) return res.status(400).json({ error: "entity_type/entity_id required" });
    const ids = db.prepare(`SELECT id FROM mail_messages WHERE entity_type IS NULL AND (id = ? OR lower(from_addr) = ? OR in_reply_to = ? OR message_id = ?)`).all(m.id, m.from_addr, m.message_id, m.in_reply_to || "").map((r) => r.id);
    db.prepare(`UPDATE mail_messages SET entity_type = ?, entity_id = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(entity_type, entity_id, ...ids);
    for (const id of ids) noteInFeed(rowToMessage(db.prepare(`SELECT * FROM mail_messages WHERE id = ?`).get(id)), { entity_type, entity_id });
    // запомнить адрес в карточке, чтобы следующие письма привязывались сами
    if (remember !== false && m.direction === "in") {
      const t = TABLE[entity_type];
      const cur = db.prepare(`SELECT email FROM ${t} WHERE id = ?`).get(entity_id);
      if (cur && !cur.email) db.prepare(`UPDATE ${t} SET email = ? WHERE id = ?`).run(m.from_addr, entity_id);
    }
    res.json({ assigned: ids.length });
  });

  /* скрыть служебное письмо из неразобранного (рассылки, уведомления) */
  app.post("/api/mail/messages/:id/dismiss", (req, res) => {
    const m = db.prepare(`SELECT id, from_addr FROM mail_messages WHERE id = ?`).get(req.params.id);
    if (!m) return res.status(404).json({ error: "not found" });
    const all = req.body?.all_from_sender;
    const r = all ? db.prepare(`UPDATE mail_messages SET entity_type = 'ignored' WHERE entity_type IS NULL AND lower(from_addr) = ?`).run(m.from_addr)
                  : db.prepare(`UPDATE mail_messages SET entity_type = 'ignored' WHERE id = ?`).run(m.id);
    res.json({ dismissed: r.changes });
  });

  /* из письма — новый лид */
  app.post("/api/mail/messages/:id/to-lead", (req, res) => {
    const m = rowToMessage(db.prepare(`SELECT * FROM mail_messages WHERE id = ?`).get(req.params.id));
    if (!m) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    const company = b.company || m.from_name || m.from_addr.split("@")[1];
    const info = db.prepare(`INSERT INTO leads (company, city, email, contact_name, source, source_note, priority) VALUES (?,?,?,?,?,?,?)`)
      .run(company, b.city ?? null, m.from_addr, m.from_name || null, "email", `Входящее письмо «${m.subject}» на ${m.account}@`, "высокий");
    const leadId = info.lastInsertRowid;
    log("lead", leadId, "system", `Лид создан из письма`);
    db.prepare(`UPDATE mail_messages SET entity_type = 'lead', entity_id = ? WHERE id = ? OR (entity_type IS NULL AND lower(from_addr) = ?)`).run(leadId, m.id, m.from_addr);
    noteInFeed(m, { entity_type: "lead", entity_id: leadId });
    res.status(201).json({ id: leadId });
  });

  /* отправить / ответить */
  app.post("/api/mail/send", async (req, res) => {
    const b = req.body || {};
    if (!b.to || !b.text) return res.status(400).json({ error: "to и text обязательны" });
    try {
      const entity = b.entity_type && b.entity_id ? { entity_type: b.entity_type, entity_id: Number(b.entity_id) } : null;
      const atts = (b.attachment_ids || []).map((id) => db.prepare(`SELECT * FROM mail_attachments WHERE id = ?`).get(id)).filter(Boolean).map((a) => ({ filename: a.filename, path: join(FILES_DIR, a.path), contentType: a.content_type }));
      for (const f of b.files || []) { if (existsSync(join(ROOT, "public", "files", f))) atts.push({ filename: f, path: join(ROOT, "public", "files", f) }); }
      const saved = await sendMail({ accountKey: b.account, to: b.to, cc: b.cc, subject: b.subject, text: b.text, inReplyTo: b.in_reply_to, entity, attachments: atts });
      res.status(201).json(saved);
    } catch (e) { res.status(502).json({ error: "не удалось отправить: " + e.message }); }
  });

  app.post("/api/mail/sync", async (_req, res) => res.json(await syncAll()));
  app.get("/api/mail/state", (_req, res) => res.json(db.prepare(`SELECT * FROM mail_state`).all()));
}
