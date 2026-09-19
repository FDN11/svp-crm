/**
 * Коммерческое предложение из сделки: печатная HTML-страница на бланке СВП (Ctrl+P → PDF)
 * и отправка клиенту письмом (текст + КП в виде HTML-вложения + прайс и презентация PDF).
 * Реквизиты продавца — из настроек (settings: kp_*), пока не заведены — пусто.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, log, currentUser } from "./db.js";
import { getSetting } from "./sequences.js";
import { sendMail } from "./mail.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const rub = (n) => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " ₽";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function kpNumber(deal) { return `КП-${String(deal.id).padStart(4, "0")}`; }

export function renderKP(dealId) {
  const d = db.prepare(`SELECT * FROM deals WHERE id = ?`).get(dealId);
  if (!d) return null;
  const items = db.prepare(`SELECT di.*, p.pack_type, p.rrc FROM deal_items di LEFT JOIN products p ON p.id = di.product_id WHERE di.deal_id = ? ORDER BY di.id`).all(dealId);
  const company = d.company_id ? db.prepare(`SELECT * FROM companies WHERE id = ?`).get(d.company_id) : null;
  const total = items.reduce((a, i) => a + i.qty * i.price, 0);
  const vat = d.vat === "с НДС";
  const vatAmount = vat ? total - total / 1.2 : 0;  // цена уже включает НДС 20 %
  const rrcTotal = items.reduce((a, i) => a + i.qty * (i.rrc || 0), 0);
  const user = currentUser();
  const seller = { name: getSetting("kp_seller_name") || "ИП Мальцев Данил Геннадьевич", inn: getSetting("kp_seller_inn") || "780252294800", ogrn: getSetting("kp_seller_ogrn") || "314784721800261",
    address: getSetting("kp_seller_address") || "Санкт-Петербург, 8-й Верхний переулок, 4, завод «Парнас М»", phone: getSetting("kp_seller_phone") || "8 800 100-47-54", email: getSetting("kp_seller_email") || "sales@svpbrand.com",
    terms: getSetting("kp_terms") || "Цены действительны 14 дней. Отгрузка со склада в Санкт-Петербурге в день оплаты, доставка транспортной компанией по России за счёт покупателя или бесплатно от суммы, согласованной в договоре. Рекомендованная розничная цена (РРЦ) едина по стране и поддерживается производителем на svp.one и Ozon." };
  const today = new Date().toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
  const rows = items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.name)}</td><td class="m">${esc(i.pack_type || "")}</td><td class="n">${i.qty}</td><td class="n">${rub(i.price)}</td><td class="n">${i.rrc ? rub(i.rrc) : "—"}</td><td class="n b">${rub(i.qty * i.price)}</td></tr>`).join("");
  return { deal: d, company, items, total, html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${kpNumber(d)} — ${esc(d.company || d.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap" rel="stylesheet">
<style>
@page { size: A4; margin: 14mm 14mm 16mm; }
* { box-sizing: border-box; } body { font: 400 11px/1.4 "Jost", system-ui, sans-serif; color: #1c1b19; margin: 0; padding: 24px; max-width: 800px; margin: 0 auto; }
.bar { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #f15e1b; padding-bottom: 10px; margin-bottom: 16px; }
.mark { font-size: 30px; font-weight: 600; letter-spacing: -.02em; color: #f15e1b; line-height: 1; } .mark small { display: block; font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: #6b6963; font-weight: 500; margin-top: 6px; }
h1 { font-size: 20px; font-weight: 500; margin: 0; text-align: right; } h1 small { display: block; font-size: 10px; color: #6b6963; font-weight: 400; margin-top: 4px; }
.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; font-size: 10.5px; }
.parties div { background: #f3f2ef; padding: 10px 12px; border-left: 3px solid #f15e1b; } .parties h3 { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: #6b6963; margin: 0 0 4px; font-weight: 500; } .parties p { margin: 0 0 2px; }
table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: #6b6963; font-weight: 500; padding: 6px 7px; border-bottom: 1.5px solid #1c1b19; }
td { padding: 6px 7px; border-bottom: 1px solid #dbdbdb; vertical-align: top; } td.n, th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } td.m { color: #6b6963; } td.b { font-weight: 600; }
.totals { margin: 10px 0 0 auto; width: 320px; font-size: 11px; } .totals div { display: flex; justify-content: space-between; padding: 4px 7px; } .totals .grand { border-top: 1.5px solid #1c1b19; font-size: 14px; font-weight: 600; margin-top: 4px; padding-top: 8px; } .totals .grand span:last-child { color: #f15e1b; }
.terms { margin-top: 18px; font-size: 9.5px; color: #3d3b37; } .terms h3 { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: #6b6963; margin: 0 0 4px; font-weight: 500; }
.sign { margin-top: 22px; display: flex; justify-content: space-between; font-size: 10px; color: #3d3b37; }
.print { position: fixed; top: 12px; right: 12px; padding: 8px 14px; background: #1c1b19; color: #fff; border: 0; font: inherit; cursor: pointer; } @media print { .print { display: none; } body { padding: 0; } }
</style></head><body>
<button class="print" onclick="print()">Печать / сохранить PDF</button>
<div class="bar"><div class="mark">СВП<small>Система выравнивания плитки · производитель · Санкт-Петербург</small></div><h1>Коммерческое предложение ${kpNumber(d)}<small>от ${today} · сделка «${esc(d.title)}»</small></h1></div>
<div class="parties">
  <div><h3>Поставщик</h3><p><b>${esc(seller.name)}</b></p><p>ИНН ${esc(seller.inn)} · ОГРНИП ${esc(seller.ogrn)}</p><p>${esc(seller.address)}</p><p>${esc(seller.phone)} · ${esc(seller.email)}</p></div>
  <div><h3>Покупатель</h3><p><b>${esc(company?.legal_name || company?.name || d.company || "")}</b></p>${d.inn || company?.inn ? `<p>ИНН ${esc(d.inn || company?.inn)}</p>` : ""}${company?.address || d.city ? `<p>${esc(company?.address || d.city)}</p>` : ""}${d.contact_name || d.phone || d.email ? `<p>${[d.contact_name, d.phone, d.email].filter(Boolean).map(esc).join(" · ")}</p>` : ""}</div>
</div>
<table><thead><tr><th>№</th><th>Позиция</th><th>Упаковка</th><th class="n">Кол-во</th><th class="n">Цена</th><th class="n">РРЦ</th><th class="n">Сумма</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="m">Позиции не добавлены</td></tr>'}</tbody></table>
<div class="totals">${vat ? `<div><span>В том числе НДС 20 %</span><span>${rub(vatAmount)}</span></div>` : `<div><span>НДС</span><span>не облагается (УСН)</span></div>`}${rrcTotal ? `<div><span>Итого по РРЦ (для справки)</span><span>${rub(rrcTotal)}</span></div>` : ""}<div class="grand"><span>Итого к оплате</span><span>${rub(total)}</span></div></div>
<div class="terms"><h3>Условия</h3><p>${esc(seller.terms)}</p></div>
<div class="sign"><div>${esc(user?.name || "Отдел продаж")}, СВП</div><div>${esc(seller.phone)} · ${esc(seller.email)} · svpbrand.com</div></div>
</body></html>` };
}

export function kpRoutes(app) {
  app.get("/api/deals/:id/kp", (req, res) => {
    const kp = renderKP(Number(req.params.id));
    if (!kp) return res.status(404).send("сделка не найдена");
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.send(kp.html);
  });
  /* письмо клиенту: текст + КП (HTML-вложение) + прайс/презентация по желанию */
  app.post("/api/deals/:id/kp/send", async (req, res) => {
    const id = Number(req.params.id); const kp = renderKP(id);
    if (!kp) return res.status(404).json({ error: "deal not found" });
    const b = req.body || {}; const to = b.to || kp.deal.email || kp.company?.email;
    if (!to) return res.status(400).json({ error: "у клиента нет e-mail" });
    const num = kpNumber(kp.deal);
    const lines = kp.items.map((i) => `— ${i.name} × ${i.qty} = ${rub(i.qty * i.price)}`).join("\n");
    const text = b.text || `${kp.deal.contact_name ? "Здравствуйте, " + kp.deal.contact_name + "!" : "Здравствуйте!"}\n\nНаправляю коммерческое предложение ${num} по нашему разговору:\n\n${lines}\n\nИтого: ${rub(kp.total)} ${kp.deal.vat}.\n\nКП в приложении, там же дилерский прайс и презентация. Цены действительны 14 дней, отгрузка день в день. Если нужно скорректировать состав или фасовки — просто ответьте на это письмо.\n\n${currentUser()?.name || ""}, СВП\n${getSetting("kp_seller_phone") || "8 800 100-47-54"}`;
    const attachments = [{ filename: `${num}.html`, content: kp.html, contentType: "text/html" }];
    if (b.with_price !== false) attachments.push({ filename: "СВП_дилерский_прайс.pdf", path: join(ROOT, "public", "files", "svp-dealer-price.pdf") });
    if (b.with_deck) attachments.push({ filename: "СВП_партнёрская_программа.pdf", path: join(ROOT, "public", "files", "svp-partner-deck.pdf") });
    try {
      const saved = await sendMail({ accountKey: b.account || "sales", to, subject: b.subject || `${num} — СВП для ${kp.company?.name || kp.deal.company || ""}`, text, entity: { entity_type: "deal", entity_id: id }, attachments });
      if (kp.deal.stage === "new") db.prepare(`UPDATE deals SET stage = 'proposal', updated_at = datetime('now') WHERE id = ?`).run(id);
      log("deal", id, "system", `КП ${num} отправлено на ${to}`);
      res.json(saved);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
}
