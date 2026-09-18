/* СВП CRM — интерфейс. Ванильный JS, без сборки. Всё через /api. */

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rub = (n) => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " ₽";
const fmtDate = (iso) => iso ? new Date(iso.replace(" ", "T") + (iso.length <= 10 ? "" : "Z")).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }) : "";
const isDue = (iso) => iso && new Date(iso) <= new Date(new Date().toDateString());

const api = async (path, opts = {}) => {
  const r = await fetch("/api" + path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401 && !path.startsWith("/auth/")) { showLogin(); throw new Error("auth"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};

const state = { meta: null, view: "leads", q: "", city: "", segment: "", products: [] };

/* ——— маршрутизация ——— */
window.addEventListener("hashchange", route);
async function route() {
  const hash = location.hash.slice(1) || "leads";
  const [view, id] = hash.split("/");
  state.view = view;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  if (view === "leads") await renderLeads();
  else if (view === "deals") await renderDeals();
  else if (view === "products") await renderProducts();
  else if (view === "scripts") renderScripts();
  else if (view === "companies") await renderCompanies();
  else if (view === "settings") await renderSettings();
  if (id) view === "leads" ? openLead(Number(id)) : view === "deals" ? openDeal(Number(id)) : view === "companies" ? openCompany(Number(id)) : null;
  refreshStats();
}

async function refreshStats() {
  const s = await api("/stats");
  const active = s.leads.filter((r) => !r.outcome).reduce((a, r) => a + r.n, 0);
  const deals = s.deals.filter((r) => !r.outcome);
  const amount = deals.reduce((a, r) => a + r.amount, 0);
  $("#top-stats").innerHTML = `
    <span>Лидов в работе <b>${active}</b></span>
    <span>Сделок <b>${deals.reduce((a, r) => a + r.n, 0)}</b> на <b>${rub(amount)}</b></span>
    <span>Клиентов <b>${s.companies?.n ?? 0}</b></span>
    ${s.reorder_due ? `<a class="due" href="#companies">Пора заказывать <b>${s.reorder_due}</b></a>` : ""}
    ${s.due_today ? `<span class="due">Касаний сегодня <b>${s.due_today}</b></span>` : ""}`;
}

/* ——— ЛИДЫ ——— */
async function renderLeads() {
  const params = new URLSearchParams({ outcome: "active" });
  if (state.q) params.set("q", state.q);
  if (state.city) params.set("city", state.city);
  if (state.segment) params.set("segment", state.segment);
  const [leads, tails] = await Promise.all([api("/leads?" + params), api("/leads?" + new URLSearchParams(state.q ? { q: state.q } : {}))]);
  const cities = [...new Set(tails.map((l) => l.city).filter(Boolean))].sort();
  const segments = [...new Set(tails.map((l) => l.segment).filter(Boolean))].sort();

  const head = el("div", { class: "view-head" },
    el("h1", {}, "Лиды"),
    el("span", { class: "d-sub" }, `${leads.length} в работе`),
    el("div", { class: "filters" },
      select(["Все города", ...cities], state.city, (v) => { state.city = v; renderLeads(); }),
      select(["Все сегменты", ...segments], state.segment, (v) => { state.segment = v; renderLeads(); }),
    ));

  const board = el("div", { class: "board" });
  for (const st of state.meta.LEAD_STAGES) {
    const items = leads.filter((l) => l.stage === st.key);
    const col = el("div", { class: "col", "data-stage": st.key },
      el("div", { class: "col-head" }, el("b", {}, st.title), el("span", {}, String(items.length))),
      el("div", { class: "col-body" }, items.map(leadCard)));
    dropzone(col, async (id) => { await api(`/leads/${id}`, { method: "PATCH", body: { stage: st.key } }); renderLeads(); refreshStats(); });
    board.append(col);
  }

  // хвосты: догрев / неквал / отказ
  const rail = el("div", { class: "rail" });
  for (const o of state.meta.LEAD_OUTCOMES.filter((o) => o.key !== "won")) {
    const items = tails.filter((l) => l.outcome === o.key);
    rail.append(el("div", { class: "col" },
      el("div", { class: "col-head" }, el("b", {}, o.title), el("span", {}, String(items.length))),
      el("div", { class: "col-body" }, items.length ? items.map(leadCard) : el("div", { class: "empty" }, "—"))));
  }

  $("#view").replaceChildren(head, board, rail);
}

function leadCard(l) {
  const c = el("div", { class: `card p-${l.priority === "высокий" ? "high" : l.priority === "низкий" ? "low" : "mid"}`, draggable: !l.outcome, "data-id": l.id, onclick: () => openLead(l.id) },
    el("div", { class: "card-title" }, el("span", {}, l.company), l.is_chain ? el("span", { class: "chain" }, l.points.length > 1 ? `сеть · ${l.points.length}` : "сеть") : null),
    el("div", { class: "card-meta" }, [l.city, l.segment].filter(Boolean).join(" · ")),
    el("div", { class: "card-foot" },
      el("span", {}, l.competitor ? `продаёт ${l.competitor}` : (l.source || "")),
      l.next_at ? el("span", { class: isDue(l.next_at) ? "due" : "" }, `${l.next_action || "касание"} · ${fmtDay(l.next_at)}`) : null));
  draggable(c, l.id);
  return c;
}

async function openLead(id) {
  const l = await api(`/leads/${id}`);
  const S = state.meta;
  const inner = $("#drawer-inner");
  const field = (label, key, type = "text", extra = {}) =>
    el("label", { class: "field" + (extra.wide ? " wide" : "") }, label,
      el("input", { type, value: l[key] ?? "", onchange: (e) => patchLead(id, { [key]: e.target.value || null }) }));

  inner.replaceChildren(
    el("div", { class: "d-head" },
      el("div", {}, el("h2", {}, l.company), el("div", { class: "d-sub" }, [l.city, l.segment, l.is_chain ? `сеть, ${l.points.length} точек` : null].filter(Boolean).join(" · "))),
      l.outcome ? el("span", { class: `outcome-badge ${l.outcome}` }, S.LEAD_OUTCOMES.find((o) => o.key === l.outcome)?.title) : null,
      el("button", { class: "btn btn-ghost d-close", onclick: closeDrawer }, "✕")),

    el("div", { class: "d-section" }, el("h3", {}, "Этап"),
      el("div", { class: "stage-pills" }, S.LEAD_STAGES.map((s) =>
        el("button", { class: "pill" + (l.stage === s.key ? " on" : ""), onclick: async () => { await patchLead(id, { stage: s.key }); openLead(id); } }, s.title)))),

    el("div", { class: "d-actions" },
      !l.deal_id
        ? el("button", { class: "btn btn-accent", title: "Создаст карточку клиента и первую сделку", onclick: async () => { const d = await api(`/leads/${id}/convert`, { method: "POST", body: {} }); location.hash = `deals/${d.id}`; } }, "В клиенты и сделку →")
        : el("a", { class: "btn btn-accent", href: `#deals/${l.deal_id}` }, `Сделка #${l.deal_id} →`),
      l.company_id ? el("a", { class: "btn btn-sm btn-ghost", href: `#companies/${l.company_id}` }, "Карточка клиента") : null,
      ...S.LEAD_OUTCOMES.filter((o) => o.key !== "won").map((o) =>
        el("button", { class: "btn btn-sm" + (l.outcome === o.key ? " btn-ok" : ""), onclick: async () => { await patchLead(id, { outcome: l.outcome === o.key ? null : o.key }); openLead(id); } }, o.title))),

    el("div", { class: "d-section" }, el("h3", {}, "Контакты"),
      el("div", { class: "phones" }, l.phones.map((p) => el("a", { href: "tel:" + p.replace(/\D/g, "") }, p)), l.site ? el("a", { href: l.site, target: "_blank", rel: "noopener" }, l.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")) : null),
      el("div", { class: "fields", style: "margin-top:10px" },
        field("Контактное лицо", "contact_name"), field("Почта", "email", "email"),
        el("label", { class: "field" }, "Приоритет", select(["высокий", "средний", "низкий"], l.priority, (v) => patchLead(id, { priority: v }))),
        field("Конкурент на полке", "competitor"),
        field("Следующее действие", "next_action"), field("Когда", "next_at", "date"))),

    l.points.length ? el("div", { class: "d-section" }, el("h3", {}, `Точки · ${l.points.length}`),
      el("div", { class: "points" }, l.points.map((p) => el("div", {}, p.name !== l.company ? el("b", {}, p.name + " — ") : null, p.address, p.city && p.city !== l.city ? el("span", { class: "pt-city" }, ` · ${p.city}`) : null)))) : null,

    scriptSection(l),
    feedSection("leads", id, l.activities, () => openLead(id)),
  );
  showDrawer();
}

const patchLead = (id, body) => api(`/leads/${id}`, { method: "PATCH", body }).then(() => { if (state.view === "leads") renderLeads(); refreshStats(); });

/* ——— СДЕЛКИ ——— */
async function renderDeals() {
  const deals = await api("/deals");
  const active = deals.filter((d) => !d.outcome);
  const head = el("div", { class: "view-head" }, el("h1", {}, "Сделки"),
    el("span", { class: "d-sub" }, `${active.length} активных · ${rub(active.reduce((a, d) => a + d.amount, 0))}`),
    el("div", { class: "filters" }, el("button", { class: "btn btn-sm", onclick: newDeal }, "+ Сделка")));

  const board = el("div", { class: "board" });
  for (const st of state.meta.DEAL_STAGES) {
    const items = active.filter((d) => d.stage === st.key);
    const col = el("div", { class: "col", "data-stage": st.key },
      el("div", { class: "col-head" }, el("b", {}, st.title), el("span", {}, String(items.length), items.length ? el("b", { class: "sum" }, " · " + rub(items.reduce((a, d) => a + d.amount, 0))) : null)),
      el("div", { class: "col-body" }, items.map(dealCard)));
    dropzone(col, async (id) => { await api(`/deals/${id}`, { method: "PATCH", body: { stage: st.key } }); renderDeals(); refreshStats(); });
    board.append(col);
  }
  const rail = el("div", { class: "rail" });
  for (const o of state.meta.DEAL_OUTCOMES) {
    const items = deals.filter((d) => d.outcome === o.key);
    rail.append(el("div", { class: "col" },
      el("div", { class: "col-head" }, el("b", {}, o.title), el("span", {}, String(items.length), items.length ? el("b", { class: "sum" }, " · " + rub(items.reduce((a, d) => a + d.amount, 0))) : null)),
      el("div", { class: "col-body" }, items.length ? items.map(dealCard) : el("div", { class: "empty" }, "—"))));
  }
  $("#view").replaceChildren(head, board, rail);
}

function dealCard(d) {
  const c = el("div", { class: "card", draggable: !d.outcome, "data-id": d.id, onclick: () => openDeal(d.id) },
    el("div", { class: "card-title" }, el("span", {}, d.title)),
    el("div", { class: "card-meta" }, [d.city, d.vat].filter(Boolean).join(" · ")),
    el("div", { class: "card-foot" }, el("span", { class: "amount" }, rub(d.amount)),
      d.next_at ? el("span", { class: isDue(d.next_at) ? "due" : "" }, `${d.next_action || "касание"} · ${fmtDay(d.next_at)}`) : null));
  draggable(c, d.id);
  return c;
}

async function newDeal() {
  const title = prompt("Название сделки (компания)");
  if (!title) return;
  const d = await api("/deals", { method: "POST", body: { title, company: title } });
  location.hash = `deals/${d.id}`;
  renderDeals();
}

async function openDeal(id) {
  const d = await api(`/deals/${id}`);
  const S = state.meta;
  const inner = $("#drawer-inner");
  const refresh = () => { if (state.view === "deals") renderDeals(); refreshStats(); };
  const patch = (body) => api(`/deals/${id}`, { method: "PATCH", body }).then(refresh);
  const field = (label, key, type = "text") =>
    el("label", { class: "field" }, label, el("input", { type, value: d[key] ?? "", onchange: (e) => patch({ [key]: e.target.value || null }) }));

  const itemsTable = el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Позиция"), el("th", { class: "num" }, "Кол-во"), el("th", { class: "num" }, "Цена"), el("th", { class: "num" }, "Сумма"), el("th", {}))),
    el("tbody", {}, d.items.map((it) => el("tr", {},
      el("td", {}, it.name),
      el("td", { class: "num" }, el("input", { type: "number", min: 1, value: it.qty, onchange: async (e) => { await api(`/deals/${id}/items/${it.id}`, { method: "PATCH", body: { qty: e.target.value } }); openDeal(id); refresh(); } })),
      el("td", { class: "num" }, rub(it.price)),
      el("td", { class: "num price" }, rub(it.qty * it.price)),
      el("td", {}, el("button", { class: "del", title: "Удалить", onclick: async () => { await api(`/deals/${id}/items/${it.id}`, { method: "DELETE" }); openDeal(id); refresh(); } }, "✕"))))));

  const prodSel = el("select", {}, el("option", { value: "" }, "Добавить товар…"), groupedProducts());
  const qtyIn = el("input", { type: "number", min: 1, value: 1 });
  const addRow = el("div", { class: "add-item" }, prodSel, qtyIn,
    el("button", { class: "btn btn-sm", onclick: async () => { if (!prodSel.value) return; await api(`/deals/${id}/items`, { method: "POST", body: { product_id: Number(prodSel.value), qty: Number(qtyIn.value) || 1 } }); openDeal(id); refresh(); } }, "Добавить"));

  inner.replaceChildren(
    el("div", { class: "d-head" },
      el("div", {}, el("h2", {}, d.title), el("div", { class: "d-sub" }, [d.company, d.city, d.lead ? `из лида #${d.lead.id}` : null].filter(Boolean).join(" · "))),
      d.outcome ? el("span", { class: `outcome-badge ${d.outcome}` }, S.DEAL_OUTCOMES.find((o) => o.key === d.outcome)?.title) : null,
      el("button", { class: "btn btn-ghost d-close", onclick: closeDrawer }, "✕")),

    el("div", { class: "d-section" }, el("h3", {}, "Этап"),
      el("div", { class: "stage-pills" }, S.DEAL_STAGES.map((s) =>
        el("button", { class: "pill" + (d.stage === s.key ? " on" : ""), onclick: async () => { await patch({ stage: s.key }); openDeal(id); } }, s.title)))),

    el("div", { class: "d-actions" },
      el("button", { class: "btn btn-sm" + (d.outcome === "won" ? " btn-ok" : ""), onclick: async () => { await patch({ outcome: d.outcome === "won" ? null : "won" }); openDeal(id); } }, "Выиграна"),
      el("button", { class: "btn btn-sm" + (d.outcome === "lost" ? " btn-bad" : ""), onclick: async () => { await patch({ outcome: d.outcome === "lost" ? null : "lost" }); openDeal(id); } }, "Проиграна"),
      d.company_ref ? el("a", { class: "btn btn-sm btn-ghost", href: `#companies/${d.company_ref.id}` }, `Клиент: ${d.company_ref.name}`) : null,
      d.lead ? el("a", { class: "btn btn-sm btn-ghost", href: `#leads/${d.lead.id}` }, "← к лиду") : null),

    el("div", { class: "d-section items" }, el("h3", {}, "Товары"),
      d.items.length ? itemsTable : el("div", { class: "empty" }, "Позиций пока нет"),
      addRow,
      el("div", { class: "total" }, el("span", {}, `Итого · ${d.vat}`), el("b", {}, rub(d.amount)))),

    el("div", { class: "d-section" }, el("h3", {}, "Реквизиты и контакт"),
      el("div", { class: "fields" },
        el("label", { class: "field" }, "НДС", select(["без НДС", "с НДС"], d.vat, (v) => patch({ vat: v }))),
        field("ИНН", "inn"), field("Контактное лицо", "contact_name"), field("Телефон", "phone", "tel"), field("Почта", "email", "email"),
        field("Следующее действие", "next_action"), field("Когда", "next_at", "date"))),

    feedSection("deals", id, d.activities, () => openDeal(id)),
  );
  showDrawer();
}

function groupedProducts() {
  const groups = new Map();
  for (const p of state.products) { if (!groups.has(p.group_name)) groups.set(p.group_name, []); groups.get(p.group_name).push(p); }
  return [...groups].map(([g, ps]) => el("optgroup", { label: g }, ps.map((p) => el("option", { value: p.id }, `${p.name} — ${rub(p.price)}`))));
}

/* ——— ТОВАРЫ ——— */
async function renderProducts() {
  const rows = []; let last = null;
  for (const p of state.products) {
    if (p.group_name !== last) { rows.push(el("tr", { class: "group" }, el("td", { colspan: 5 }, p.group_name))); last = p.group_name; }
    rows.push(el("tr", {}, el("td", {}, p.name), el("td", {}, p.pack_type), el("td", { class: "num" }, p.weight_kg ?? ""), el("td", { class: "num price" }, rub(p.price)), el("td", { class: "num" }, p.rrc ? rub(p.rrc) : "")));
  }
  $("#view").replaceChildren(
    el("div", { class: "view-head" }, el("h1", {}, "Товары"), el("span", { class: "d-sub" }, `${state.products.length} позиций · дилерский прайс`)),
    el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Наименование"), el("th", {}, "Упаковка"), el("th", { class: "num" }, "Вес, кг"), el("th", { class: "num" }, "Дилерская"), el("th", { class: "num" }, "РРЦ"))), el("tbody", {}, rows)));
}

/* ——— скрипты ——— */
const S = () => window.SCRIPTS;
const cityLoc = (c) => !c ? "вашем городе" : c === "Ростов-на-Дону" ? "Ростове-на-Дону" : /ь$/.test(c) ? c.replace(/ь$/, "и") : /а$/.test(c) ? c.replace(/а$/, "е") : /[ыи]$/.test(c) ? c : c + "е";
const signature = () => { const d = S().signature; let o = {}; try { o = JSON.parse(localStorage.getItem("svp.signature") || "{}"); } catch {} return { ...d, ...o }; };
function pitchFor(lead) {
  const P = S().pitches;
  if (lead.competitor) return P.find((p) => p.competitor);
  return P.find((p) => p.match && p.match.test(lead.segment || "")) || P.find((p) => p.key === "store");
}
function fillTemplate(tpl, lead, pitch) {
  const sig = signature();
  const name = (lead.contact_name || "").trim();
  const map = {
    company: lead.company, city: lead.city || "", cityLoc: cityLoc(lead.city), name,
    nameComma: name ? ", " + name : "", nameOrHello: name || "Здравствуйте",
    competitor: lead.competitor || "текущим поставщиком", segmentParagraph: pitch?.email || "",
    manager: sig.manager, phone: sig.phone, email: sig.email,
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] ?? "");
}
const copyText = async (t, btn) => { try { await navigator.clipboard.writeText(t); btn.textContent = "Скопировано"; setTimeout(() => (btn.textContent = "Скопировать"), 1500); } catch { prompt("Скопируйте текст", t); } };

function scriptSection(l) {
  const pitch = pitchFor(l);
  const pitchText = fillTemplate(pitch.text, l, pitch);
  const emailSel = el("select", {}, S().emails.map((e) => el("option", { value: e.key }, e.title)));
  const subj = el("input", { class: "email-subj", readonly: "" });
  const body = el("textarea", { class: "email-body", rows: 12 });
  const mailBtn = el("a", { class: "btn btn-sm", target: "_blank" }, "Открыть в почте");
  const render = () => {
    const t = S().emails.find((e) => e.key === emailSel.value);
    subj.value = fillTemplate(t.subject, l, pitch); body.value = fillTemplate(t.body, l, pitch);
    mailBtn.href = `mailto:${l.email || ""}?subject=${encodeURIComponent(subj.value)}&body=${encodeURIComponent(body.value)}`;
  };
  emailSel.addEventListener("change", render); render();
  return el("div", { class: "d-section script" }, el("h3", {}, "Скрипт и письмо"),
    el("div", { class: "pitch" },
      el("div", { class: "pitch-title" }, pitch.title, el("a", { href: "#scripts", class: "pitch-more" }, "все скрипты →")),
      el("p", {}, pitchText),
      el("div", { class: "accents" }, pitch.accents.map((a) => el("span", { class: "tag" }, a))),
      el("button", { class: "btn btn-sm btn-ghost", onclick: (e) => copyText(pitchText, e.target) }, "Скопировать")),
    el("details", { class: "objs" }, el("summary", {}, "Возражения"),
      S().objections.map(([q, a]) => el("div", { class: "obj" }, el("b", {}, q), el("span", {}, a)))),
    el("div", { class: "email-box" },
      el("div", { class: "email-head" }, emailSel, el("button", { class: "btn btn-sm", onclick: (e) => copyText(subj.value + "\n\n" + body.value, e.target) }, "Скопировать"), l.email ? mailBtn : el("span", { class: "d-sub" }, "почты нет — добавьте выше")),
      subj, body,
      el("div", { class: "d-sub files" }, "Вложения: ", el("a", { href: "/files/svp-dealer-price.pdf", target: "_blank" }, "дилерский прайс PDF"), " · ", el("a", { href: "/files/svp-partner-deck.pdf", target: "_blank" }, "презентация PDF"), " · подпись — в разделе «Скрипты»")));
}

function renderScripts() {
  const s = S(); const sig = signature();
  const sigForm = el("div", { class: "fields sig" }, ...[["manager", "Имя в подписи"], ["phone", "Телефон"], ["email", "Почта"]].map(([k, label]) =>
    el("label", { class: "field" }, label, el("input", { value: sig[k], onchange: (e) => { const o = signature(); o[k] = e.target.value; localStorage.setItem("svp.signature", JSON.stringify(o)); } }))));
  const block = (title, kids) => el("section", { class: "doc-block" }, el("h2", {}, title), kids);
  const kv = (rows) => el("div", { class: "kv" }, rows.map(([k, v]) => el("div", {}, el("b", {}, k), el("span", { html: esc(v).replace(/\[\?[^\]]*\]/g, (m) => `<mark>${m}</mark>`) }))));
  $("#view").replaceChildren(
    el("div", { class: "view-head" }, el("h1", {}, "Скрипты и письма"), el("span", { class: "d-sub" }, "заход подставляется в карточку лида по сегменту и конкуренту · [?] — уточнить у заказчика")),
    el("div", { class: "doc" },
      block("Подпись в письмах", sigForm),
      block("На чём стоим", kv(s.facts)),
      block("Структура звонка · 3–4 минуты", kv(s.call)),
      block("Заходы по сегментам", el("div", { class: "pitches" }, s.pitches.map((p) => el("div", { class: "pitch" },
        el("div", { class: "pitch-title" }, p.title), el("div", { class: "d-sub" }, p.pain), el("p", {}, p.text.replace("{{competitor}}", "TLS-Profi")),
        el("div", { class: "accents" }, p.accents.map((a) => el("span", { class: "tag" }, a))))))),
      block("Возражения", kv(s.objections)),
      block("Письма", el("div", { class: "pitches" }, s.emails.map((e) => el("div", { class: "pitch" }, el("div", { class: "pitch-title" }, e.title), el("div", { class: "d-sub" }, "Тема: " + e.subject), el("pre", {}, e.body))))),
      block("Вложения", el("div", {}, el("div", { class: "files-row" }, el("a", { class: "btn btn-sm", href: "/files/svp-dealer-price.pdf", target: "_blank" }, "Дилерский прайс PDF ↓"), el("a", { class: "btn btn-sm", href: "/files/svp-partner-deck.pdf", target: "_blank" }, "Презентация PDF ↓")),
        kv(s.attachments.map(([k, v, ok]) => [(ok ? "✓ " : "○ ") + k, v])))),
      block("Вопросы заказчику до старта звонков", el("ol", { class: "qs" }, s.questions.map((q) => el("li", {}, q))))));
}

/* ——— КЛИЕНТЫ (компании) ——— */
const daysUntil = (iso) => iso ? Math.round((new Date(iso) - new Date(new Date().toDateString())) / 86400000) : null;
const dueLabel = (iso) => { const d = daysUntil(iso); if (d == null) return null; return d < 0 ? `просрочен на ${-d} дн.` : d === 0 ? "сегодня" : d <= 7 ? `через ${d} дн.` : fmtDay(iso); };

async function renderCompanies() {
  const params = new URLSearchParams(); if (state.q) params.set("q", state.q); if (state.cstatus) params.set("status", state.cstatus);
  const rows = await api("/companies?" + params);
  const due = rows.filter((c) => c.status === "active" && daysUntil(c.next_order_at) != null && daysUntil(c.next_order_at) <= 7 && !c.open_deals);
  const head = el("div", { class: "view-head" }, el("h1", {}, "Клиенты"), el("span", { class: "d-sub" }, `${rows.length} компаний · ${rub(rows.reduce((a, c) => a + c.total_amount, 0))} за всё время`),
    el("div", { class: "filters" }, select(["Все статусы", "active", "paused", "lost"], state.cstatus, (v) => { state.cstatus = v; renderCompanies(); }),
      el("button", { class: "btn btn-sm", onclick: newCompany }, "+ Клиент")));
  const card = (c) => el("div", { class: "card" + (due.includes(c) ? " p-high" : ""), onclick: () => openCompany(c.id) },
    el("div", { class: "card-title" }, el("span", {}, c.name), c.status !== "active" ? el("span", { class: "chain" }, c.status === "paused" ? "пауза" : "потерян") : null),
    el("div", { class: "card-meta" }, [c.city, c.segment, c.vat].filter(Boolean).join(" · ")),
    el("div", { class: "card-foot" },
      el("span", {}, c.orders_count ? `${c.orders_count} заказ${c.orders_count === 1 ? "" : c.orders_count < 5 ? "а" : "ов"} · ${rub(c.total_amount)}` : "заказов пока нет"),
      c.open_deals ? el("span", { class: "amount" }, `в работе ${rub(c.open_amount)}`) : c.next_order_at ? el("span", { class: daysUntil(c.next_order_at) <= 7 ? "due" : "" }, `заказ ${dueLabel(c.next_order_at)}`) : null));
  const table = el("div", { class: "companies" },
    due.length ? el("div", { class: "col reorder" }, el("div", { class: "col-head" }, el("b", {}, "Пора заказывать"), el("span", {}, String(due.length))), el("div", { class: "col-body" }, due.map(card))) : null,
    el("div", { class: "cgrid" }, rows.filter((c) => !due.includes(c)).map(card)));
  $("#view").replaceChildren(head, table);
}

async function newCompany() {
  const name = prompt("Название компании"); if (!name) return;
  const city = prompt("Город") || null;
  const c = await api("/companies", { method: "POST", body: { name, city } });
  location.hash = `companies/${c.id}`; renderCompanies();
}

async function openCompany(id) {
  const c = await api(`/companies/${id}`);
  const S = state.meta;
  const inner = $("#drawer-inner");
  const refresh = () => { if (state.view === "companies") renderCompanies(); refreshStats(); };
  const patch = (body) => api(`/companies/${id}`, { method: "PATCH", body }).then(refresh);
  const field = (label, key, type = "text") => el("label", { class: "field" }, label, el("input", { type, value: c[key] ?? "", onchange: (e) => patch({ [key]: e.target.value }) }));
  const lastWon = c.deals.find((d) => d.outcome === "won");
  const openDeals = c.deals.filter((d) => !d.outcome);
  const newDealBtn = (copyFrom, label, cls) => el("button", { class: cls, onclick: async () => { const d = await api(`/companies/${id}/deals`, { method: "POST", body: copyFrom ? { copy_from: copyFrom } : {} }); location.hash = `deals/${d.id}`; } }, label);

  inner.replaceChildren(
    el("div", { class: "d-head" },
      el("div", {}, el("h2", {}, c.name), el("div", { class: "d-sub" }, [c.legal_name, c.city, c.segment].filter(Boolean).join(" · "))),
      c.status !== "active" ? el("span", { class: "outcome-badge " + (c.status === "lost" ? "lost" : "nurture") }, c.status === "paused" ? "Пауза" : "Потерян") : null,
      el("button", { class: "btn btn-ghost d-close", onclick: closeDrawer }, "✕")),

    el("div", { class: "kpis" },
      el("div", {}, el("b", {}, String(c.orders_count)), el("span", {}, "заказов")),
      el("div", {}, el("b", {}, rub(c.total_amount)), el("span", {}, "за всё время")),
      el("div", {}, el("b", {}, c.last_order_at ? fmtDay(c.last_order_at) : "—"), el("span", {}, "последний заказ")),
      el("div", { class: daysUntil(c.next_order_at) != null && daysUntil(c.next_order_at) <= 7 ? "due" : "" }, el("b", {}, c.next_order_at ? dueLabel(c.next_order_at) : "—"), el("span", {}, "следующий ожидаем"))),

    el("div", { class: "d-actions" },
      lastWon ? newDealBtn(lastWon.id, "Повторить последний заказ", "btn btn-accent") : null,
      newDealBtn(null, lastWon ? "+ Новая сделка" : "+ Первая сделка", lastWon ? "btn" : "btn btn-accent"),
      c.lead ? el("a", { class: "btn btn-sm btn-ghost", href: `#leads/${c.lead.id}` }, "← лид") : null,
      el("label", { class: "field inline" }, "Статус", select(["active", "paused", "lost"], c.status, (v) => patch({ status: v }).then(() => openCompany(id))))),

    el("div", { class: "d-section" }, el("h3", {}, `Сделки · ${c.deals.length}`),
      c.deals.length ? el("div", { class: "deal-list" }, c.deals.map((d) => el("a", { class: "deal-row" + (d.outcome ? " " + d.outcome : ""), href: `#deals/${d.id}` },
        el("span", { class: "dr-title" }, d.title), el("span", { class: "dr-stage" }, d.outcome ? S.DEAL_OUTCOMES.find((o) => o.key === d.outcome)?.title : S.DEAL_STAGES.find((s) => s.key === d.stage)?.title),
        el("span", { class: "dr-date" }, fmtDay(d.closed_at || d.created_at)), el("span", { class: "dr-amount" }, rub(d.amount))))) : el("div", { class: "empty" }, "Сделок пока нет")),

    el("div", { class: "d-section" }, el("h3", {}, "Реквизиты и доставка"),
      el("div", { class: "fields" },
        field("Юр. название", "legal_name"), field("ИНН", "inn"),
        el("label", { class: "field" }, "НДС", select(["без НДС", "с НДС"], c.vat, (v) => patch({ vat: v }))),
        field("Город", "city"), el("label", { class: "field wide" }, "Адрес доставки", el("input", { value: c.address ?? "", onchange: (e) => patch({ address: e.target.value }) })))),

    el("div", { class: "d-section" }, el("h3", {}, "Контакты"),
      el("div", { class: "phones" }, c.phones.map((p) => el("a", { href: "tel:" + p.replace(/\D/g, "") }, p)), c.email ? el("a", { href: "mailto:" + c.email }, c.email) : null, c.site ? el("a", { href: c.site, target: "_blank", rel: "noopener" }, c.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")) : null),
      el("div", { class: "fields", style: "margin-top:10px" }, field("Контактное лицо", "contact_name"), field("Должность", "contact_role"), field("Почта", "email", "email"),
        el("label", { class: "field" }, "Телефоны (через запятую)", el("input", { value: c.phones.join(", "), onchange: (e) => patch({ phones: e.target.value.split(",").map((p) => p.trim()).filter(Boolean) }) })))),

    el("div", { class: "d-section" }, el("h3", {}, "Ритм заказов"),
      el("div", { class: "fields" },
        el("label", { class: "field" }, "Интервал, дней (пусто — по истории)", el("input", { type: "number", min: 7, value: c.order_interval_days ?? "", onchange: (e) => patch({ order_interval_days: e.target.value ? Number(e.target.value) : null }).then(() => openCompany(id)) })),
        el("label", { class: "field" }, "Следующий заказ ожидаем", el("input", { type: "date", value: c.next_order_at ?? "", onchange: (e) => patch({ next_order_at: e.target.value || null }) }))),
      el("div", { class: "d-sub" }, "Когда дата подходит и открытой сделки нет — клиент попадает в «Пора заказывать» в шапке и на доске.")),

    el("div", { class: "d-section" }, el("h3", {}, "Заметка"), el("textarea", { class: "note", rows: 3, onchange: (e) => patch({ note: e.target.value }) }, c.note ?? "")),
    feedSection("companies", id, c.activities, () => openCompany(id)),
  );
  showDrawer();
}

/* ——— НАСТРОЙКИ: пользователи и пароль ——— */
async function renderSettings() {
  const me = state.meta.user; const users = await api("/users");
  const row = (u) => el("tr", {}, el("td", {}, u.name, u.id === me.id ? el("span", { class: "d-sub" }, " (вы)") : null), el("td", {}, u.login), el("td", {}, u.is_admin ? "администратор" : "менеджер"), el("td", {}, u.last_seen ? fmtDate(u.last_seen) : "—"),
    el("td", {}, me.is_admin && u.id !== me.id ? el("button", { class: "btn btn-sm btn-ghost", onclick: async () => { await api(`/users/${u.id}`, { method: "PATCH", body: { active: !u.active } }); renderSettings(); } }, u.active ? "Отключить" : "Включить") : null,
      me.is_admin ? el("button", { class: "btn btn-sm btn-ghost", onclick: async () => { const p = prompt(`Новый пароль для ${u.login}`); if (p) { await api(`/users/${u.id}`, { method: "PATCH", body: { password: p } }); alert("Пароль изменён"); } } }, "Сменить пароль") : null));
  const addForm = me.is_admin ? el("div", { class: "fields sig" },
    el("label", { class: "field" }, "Логин", el("input", { id: "nu-login" })), el("label", { class: "field" }, "Имя", el("input", { id: "nu-name" })), el("label", { class: "field" }, "Пароль", el("input", { id: "nu-pass", type: "password" })),
    el("label", { class: "field inline" }, el("input", { id: "nu-admin", type: "checkbox" }), " администратор"),
    el("button", { class: "btn btn-accent", onclick: async () => { try { await api("/users", { method: "POST", body: { login: $("#nu-login").value, name: $("#nu-name").value, password: $("#nu-pass").value, is_admin: $("#nu-admin").checked ? 1 : 0 } }); renderSettings(); } catch (e) { alert(e.message); } } }, "Добавить")) : null;
  const pwForm = el("div", { class: "fields sig" }, el("label", { class: "field" }, "Текущий пароль", el("input", { id: "pw-cur", type: "password" })), el("label", { class: "field" }, "Новый пароль", el("input", { id: "pw-new", type: "password" })),
    el("button", { class: "btn", onclick: async () => { try { await api("/auth/password", { method: "POST", body: { current: $("#pw-cur").value, password: $("#pw-new").value } }); alert("Пароль изменён"); $("#pw-cur").value = $("#pw-new").value = ""; } catch (e) { alert(e.message); } } }, "Сменить"));
  $("#view").replaceChildren(
    el("div", { class: "view-head" }, el("h1", {}, "Настройки"), el("span", { class: "d-sub" }, `вы вошли как ${me.name}`), el("div", { class: "filters" }, el("button", { class: "btn btn-sm btn-ghost", onclick: async () => { await api("/auth/logout", { method: "POST" }); location.reload(); } }, "Выйти"))),
    el("div", { class: "doc" },
      el("section", { class: "doc-block" }, el("h2", {}, "Пользователи"), el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Имя"), el("th", {}, "Логин"), el("th", {}, "Роль"), el("th", {}, "Был в системе"), el("th", {}))), el("tbody", {}, users.map(row))), addForm),
      el("section", { class: "doc-block" }, el("h2", {}, "Мой пароль"), pwForm),
      el("section", { class: "doc-block" }, el("h2", {}, "Подпись в письмах"), el("div", { class: "d-sub" }, "Задаётся в разделе «Скрипты» — хранится в этом браузере."))));
}

/* ——— ВХОД ——— */
function showLogin() {
  if ($("#login")) return;
  const login = el("input", { placeholder: "логин", autocomplete: "username" }), pass = el("input", { type: "password", placeholder: "пароль", autocomplete: "current-password" }), err = el("div", { class: "login-err" });
  const submit = async (e) => { e?.preventDefault(); try { await api("/auth/login", { method: "POST", body: { login: login.value.trim(), password: pass.value } }); location.reload(); } catch (x) { err.textContent = x.message === "auth" ? "Неверный логин или пароль" : x.message; } };
  const form = el("form", { id: "login", onsubmit: submit }, el("div", { class: "login-box" }, el("div", { class: "brand" }, el("span", { class: "mark" }, "СВП"), el("span", { class: "brand-sub" }, "CRM · дилерская сеть")), login, pass, err, el("button", { class: "btn btn-accent", type: "submit" }, "Войти")));
  document.body.append(form); login.focus();
}

/* ——— лента и комментарии ——— */
function feedSection(entity, id, activities, reload) {
  const input = el("input", { placeholder: "Комментарий: что обсудили, что дальше…" });
  const send = async () => { if (!input.value.trim()) return; await api(`/${entity}/${id}/activities`, { method: "POST", body: { text: input.value.trim() } }); input.value = ""; reload(); refreshStats(); };
  input.addEventListener("keydown", (e) => e.key === "Enter" && send());
  return el("div", { class: "d-section" }, el("h3", {}, "Лента"),
    el("div", { class: "comment-form" }, input, el("button", { class: "btn btn-accent btn-sm", onclick: send }, "Отправить")),
    el("div", { class: "feed", style: "margin-top:10px" }, activities.length ? activities.map((a) =>
      el("div", { class: `feed-item k-${a.kind}` }, a.text, el("div", { class: "feed-meta" }, `${a.author} · ${fmtDate(a.created_at)}`))) : el("div", { class: "empty" }, "Пока пусто")));
}

/* ——— новый лид ——— */
$("#btn-new-lead").addEventListener("click", async () => {
  const company = prompt("Компания"); if (!company) return;
  const city = prompt("Город") || null;
  const phone = prompt("Телефон") || null;
  const l = await api("/leads", { method: "POST", body: { company, city, phones: phone ? [phone] : [], source: "manual" } });
  location.hash = `leads/${l.id}`;
  renderLeads();
});

/* ——— поиск ——— */
let qTimer;
$("#search").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); route(); }, 250); });

/* ——— вспомогательные ——— */
function select(options, value, onchange) {
  const s = el("select", { onchange: (e) => onchange(e.target.selectedIndex === 0 && options[0].startsWith("Все") ? "" : e.target.value) },
    options.map((o) => el("option", { value: o, selected: o === value ? "" : null }, o)));
  return s;
}
function draggable(card, id) {
  card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", String(id)); card.classList.add("dragging"); });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
}
function dropzone(col, onDrop) {
  col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop"); });
  col.addEventListener("dragleave", () => col.classList.remove("drop"));
  col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("drop"); onDrop(Number(e.dataTransfer.getData("text/plain"))); });
}
function showDrawer() { $("#drawer").hidden = false; $("#scrim").hidden = false; }
function closeDrawer() { $("#drawer").hidden = true; $("#scrim").hidden = true; location.hash = "#" + state.view; }
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => e.key === "Escape" && !$("#drawer").hidden && closeDrawer());

/* ——— старт ——— */
(async () => {
  try { [state.meta, state.products] = await Promise.all([api("/meta"), api("/products")]); } catch { return; }
  $("#user-name").textContent = state.meta.user?.name || "";
  route();
})();
