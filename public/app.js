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

/* replaceChildren превращает null в текст «null» — фильтруем */
const fillDrawer = (node, ...kids) => node.replaceChildren(...kids.flat().filter(Boolean));
const state = { meta: null, view: "leads", q: "", city: "", segment: "", products: [] };

/* ——— маршрутизация ——— */
window.addEventListener("hashchange", route);
async function route() {
  const hash = location.hash.slice(1) || "today";
  const [view, id] = hash.split("/");
  state.view = view;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  if (view === "today") await renderToday();
  else if (view === "leads") await renderLeads();
  else if (view === "deals") await renderDeals();
  else if (view === "products") await renderProducts();
  else if (view === "scripts") renderScripts();
  else if (view === "companies") await renderCompanies();
  else if (view === "settings") await renderSettings();
  else if (view === "mail") await renderMail();
  else if (view === "sequences") await renderSequences();
  else if (view === "reports") await renderReports();
  if (id) view === "leads" ? openLead(Number(id)) : view === "deals" ? openDeal(Number(id)) : view === "companies" ? openCompany(Number(id)) : null;
  refreshStats();
}

async function refreshStats() {
  const s = await api("/stats");
  const active = s.leads.filter((r) => !r.outcome).reduce((a, r) => a + r.n, 0);
  const deals = s.deals.filter((r) => !r.outcome);
  const amount = deals.reduce((a, r) => a + r.amount, 0);
  $("#top-stats").innerHTML = `
    <span title="Лидов в работе · сделок в работе · клиентов">${active} · ${deals.reduce((a, r) => a + r.n, 0)} / ${rub(amount)} · ${s.companies?.n ?? 0}</span>
    ${s.reorder_due ? `<a class="due" href="#companies" title="Пора заказывать">↻ <b>${s.reorder_due}</b></a>` : ""}
    ${s.mail?.unassigned ? `<a class="due" href="#mail" title="Неразобранных писем">✉ <b>${s.mail.unassigned}</b></a>` : ""}
    ${s.due_today ? `<a class="due" href="#today" title="Касаний сегодня">☎ <b>${s.due_today}</b></a>` : ""}`;
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

  const withEmail = leads.filter((l) => l.email && l.stage === "new");
  const head = el("div", { class: "view-head" },
    el("h1", {}, "Лиды"),
    el("span", { class: "d-sub" }, `${leads.length} в работе`),
    el("div", { class: "filters" },
      withEmail.length ? el("button", { class: "btn btn-sm", title: "Запустить холодную цепочку для всех новых лидов с e-mail в текущем фильтре", onclick: async () => { if (!confirm(`Запустить цепочку писем для ${withEmail.length} новых лидов с e-mail?`)) return; const r = await api("/sequences/start", { method: "POST", body: { lead_ids: withEmail.map((l) => l.id) } }); alert(`В цепочке: ${r.started}. Пропущено: ${r.skipped.length}`); route(); } }, `▶ В цепочку (${withEmail.length})`) : null,
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

  fillDrawer(inner, 
    el("div", { class: "d-head" },
      el("div", {}, el("h2", {}, l.company), el("div", { class: "d-sub" }, [l.city, l.segment, l.is_chain ? `сеть, ${l.points.length} точек` : null].filter(Boolean).join(" · ")),
        el("div", { class: "d-sub src", title: l.source_note || "" }, `${l.source === "site" ? "✦ заявка с сайта" : l.source === "email" ? "✉ из письма" : l.source === "manual" ? "внесён вручную" : "парсинг: " + (l.source || "")}${l.source_note ? " · " + (l.source_note.length > 140 ? l.source_note.slice(0, 140) + "…" : l.source_note) : ""}`)),
      l.outcome ? el("span", { class: `outcome-badge ${l.outcome}` }, S.LEAD_OUTCOMES.find((o) => o.key === l.outcome)?.title) : null,
      el("button", { class: "btn btn-ghost d-close", onclick: closeDrawer }, "✕")),

    el("div", { class: "d-section" }, el("h3", {}, "Этап"),
      el("div", { class: "stage-pills" }, S.LEAD_STAGES.map((s) =>
        el("button", { class: "pill" + (l.stage === s.key ? " on" : ""), onclick: async () => { await patchLead(id, { stage: s.key }); openLead(id); } }, s.title)))),

    el("div", { class: "d-actions" },
      callBtn("leads", id, l.phones[0], () => openLead(id)),
      !l.deal_id
        ? el("button", { class: "btn btn-accent", title: "Создаст карточку клиента и первую сделку", onclick: async () => { const d = await api(`/leads/${id}/convert`, { method: "POST", body: {} }); location.hash = `deals/${d.id}`; } }, "В клиенты и сделку →")
        : el("a", { class: "btn btn-accent", href: `#deals/${l.deal_id}` }, `Сделка #${l.deal_id} →`),
      l.company_id ? el("a", { class: "btn btn-sm btn-ghost", href: `#companies/${l.company_id}` }, "Карточка клиента") : null,
      !l.outcome && l.email ? el("button", { class: "btn btn-sm btn-ghost", title: "3 письма: заход → напоминание через 4 дня → «как образцы» через 7. Остановится сама при ответе", onclick: async () => { const r = await api("/sequences/start", { method: "POST", body: { lead_ids: [id] } }); alert(r.started ? "Лид в цепочке — первое письмо уйдёт в ближайшее рабочее окно" : "Не запущено: " + r.skipped[0]?.reason); openLead(id); } }, "▶ В цепочку писем") : null,
      ...S.LEAD_OUTCOMES.filter((o) => o.key !== "won").map((o) =>
        el("button", { class: "btn btn-sm" + (l.outcome === o.key ? " btn-ok" : ""), onclick: async () => { await patchLead(id, { outcome: l.outcome === o.key ? null : o.key }); openLead(id); } }, o.title))),

    el("div", { class: "d-section" }, el("h3", {}, "Контакты"),
      el("div", { class: "phones" }, l.phones.map((p) => el("a", { href: "tel:" + p.replace(/\D/g, "") }, p)), l.site ? el("a", { href: l.site, target: "_blank", rel: "noopener" }, l.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")) : null),
      el("div", { class: "fields", style: "margin-top:10px" },
        field("Контактное лицо", "contact_name"), field("Почта", "email", "email"),
        el("label", { class: "field" }, "Приоритет", select(["высокий", "средний", "низкий"], l.priority, (v) => patchLead(id, { priority: v }))),
        field("Конкурент на полке", "competitor"),
        field("ИНН", "inn"), el("label", { class: "field" }, "НДС", select(["без НДС", "с НДС"], l.vat || "без НДС", (v) => patchLead(id, { vat: v }))),
        field("Следующее действие", "next_action"), field("Когда", "next_at", "date"))),

    l.points.length ? el("div", { class: "d-section" }, el("h3", {}, `Точки · ${l.points.length}`),
      el("div", { class: "points" }, l.points.map((p) => el("div", {}, p.name !== l.company ? el("b", {}, p.name + " — ") : null, p.address, p.city && p.city !== l.city ? el("span", { class: "pt-city" }, ` · ${p.city}`) : null)))) : null,

    scriptSection(l),
    mailSection("lead", id, { to: l.email, name: l.contact_name, lead: l }),
    feedSection("leads", id, l.activities, () => openLead(id)),
  );
  showDrawer();
}

const patchLead = (id, body) => api(`/leads/${id}`, { method: "PATCH", body }).then(() => { if (state.view === "leads") renderLeads(); refreshStats(); });

/* ——— СДЕЛКИ ——— */
async function renderDeals() {
  const deals = await api("/deals" + (state.q ? "?q=" + encodeURIComponent(state.q) : ""));
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
  const companies = await api("/companies?status=active");
  const v = await quickForm("Новая сделка", [
    { key: "company", label: "Клиент (существующий)", options: ["— новый —", ...companies.map((c) => `${c.name}${c.city ? " · " + c.city : ""}`)] },
    { key: "title", label: "Название сделки", placeholder: "например: Партия для магазина на Ленина" },
    { key: "city", label: "Город" }, { key: "vat", label: "НДС", options: ["без НДС", "с НДС"] }]);
  if (!v) return;
  const idx = companies.findIndex((c) => `${c.name}${c.city ? " · " + c.city : ""}` === v.company);
  let d;
  if (idx >= 0) d = await api(`/companies/${companies[idx].id}/deals`, { method: "POST", body: { title: v.title || undefined } });
  else { if (!v.title) return alert("Укажите название или выберите клиента"); d = await api("/deals", { method: "POST", body: { title: v.title, company: v.title, city: v.city || null, vat: v.vat } }); }
  location.hash = `deals/${d.id}`; route();
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

  fillDrawer(inner, 
    el("div", { class: "d-head" },
      el("div", {}, el("h2", {}, d.title), el("div", { class: "d-sub" }, [d.company, d.city, d.lead ? `из лида #${d.lead.id}` : null].filter(Boolean).join(" · "))),
      d.outcome ? el("span", { class: `outcome-badge ${d.outcome}` }, S.DEAL_OUTCOMES.find((o) => o.key === d.outcome)?.title) : null,
      el("button", { class: "btn btn-ghost d-close", onclick: closeDrawer }, "✕")),

    el("div", { class: "d-section" }, el("h3", {}, "Этап"),
      el("div", { class: "stage-pills" }, S.DEAL_STAGES.map((s) =>
        el("button", { class: "pill" + (d.stage === s.key ? " on" : ""), onclick: async () => { await patch({ stage: s.key }); openDeal(id); } }, s.title)))),

    el("div", { class: "d-actions" },
      callBtn("deals", id, d.phone, () => openDeal(id)),
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

    mailSection("deal", id, { to: d.email, name: d.contact_name }),
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
  if (lead.source === "site" || lead.source === "email") return P.find((p) => p.inbound);
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
  const mailOn = Array.isArray(mailAccounts) && mailAccounts.length > 0;
  return el("div", { class: "d-section script" }, el("h3", {}, mailOn ? "Скрипт звонка" : "Скрипт и письмо"),
    el("div", { class: "pitch" },
      el("div", { class: "pitch-title" }, pitch.title, el("a", { href: "#scripts", class: "pitch-more" }, "все скрипты →")),
      el("p", {}, pitchText),
      el("div", { class: "accents" }, pitch.accents.map((a) => el("span", { class: "tag" }, a))),
      el("button", { class: "btn btn-sm btn-ghost", onclick: (e) => copyText(pitchText, e.target) }, "Скопировать")),
    el("details", { class: "objs" }, el("summary", {}, "Возражения"),
      S().objections.map(([q, a]) => el("div", { class: "obj" }, el("b", {}, q), el("span", {}, a)))),
    mailOn ? null : el("div", { class: "email-box" },
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
  const v = await quickForm("Новый клиент", [
    { key: "name", label: "Название", required: true }, { key: "city", label: "Город" },
    { key: "inn", label: "ИНН" }, { key: "vat", label: "НДС", options: ["без НДС", "с НДС"] },
    { key: "phone", label: "Телефон", type: "tel" }, { key: "email", label: "E-mail", type: "email" }, { key: "contact_name", label: "Контактное лицо" },
    { key: "segment", label: "Сегмент", options: ["салон плитки", "магазин стройматериалов", "сеть салонов плитки", "оптовик / дистрибьютор", "федеральная сеть", "другое"] }]);
  if (!v) return;
  const c = await api("/companies", { method: "POST", body: { name: v.name, city: v.city || null, inn: v.inn || null, vat: v.vat, phones: v.phone ? [v.phone] : [], email: v.email || null, contact_name: v.contact_name || null, segment: v.segment } });
  location.hash = `companies/${c.id}`; route();
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

  fillDrawer(inner, 
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
      callBtn("companies", id, c.phones[0], () => openCompany(id)),
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
    mailSection("company", id, { to: c.email, name: c.contact_name }),
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

/* ——— ПОЧТА ——— */
let mailAccounts = null;
const getAccounts = async () => mailAccounts ?? (mailAccounts = await api("/mail/accounts"));
const fmtAddr = (a) => a?.name ? `${a.name} <${a.address}>` : a?.address || "";

function mailSection(type, id, ctx = {}) {
  const box = el("div", { class: "d-section mail" }, el("h3", {}, "Почта"));
  (async () => {
    const [msgs, accs] = await Promise.all([api(`/mail/for/${type}/${id}`), getAccounts()]);
    const list = el("div", { class: "mail-list" }, msgs.length ? msgs.map((m) => mailRow(m)) : el("div", { class: "empty" }, accs.length ? "Переписки пока нет" : "Почта не подключена"));
    const actions = el("div", { class: "d-actions" });
    if (accs.length) {
      actions.append(el("button", { class: "btn btn-sm btn-accent", onclick: () => composer(box, { type, id, to: ctx.to, name: ctx.name, lead: ctx.lead, accs }) }, ctx.to ? `✉ Написать ${ctx.to}` : "✉ Написать"));
      const lastIn = msgs.find((m) => m.direction === "in");
      if (lastIn) actions.append(el("button", { class: "btn btn-sm", onclick: () => composer(box, { type, id, to: lastIn.from_addr, replyTo: lastIn, accs, account: lastIn.account }) }, "↩ Ответить на последнее"));
    }
    box.append(actions, list);
    if (state.autoReply && state.autoReply.entity_type === type && state.autoReply.entity_id === id) { const m = state.autoReply; state.autoReply = null; composer(box, { type, id, to: m.from_addr, replyTo: m, accs, account: m.account }); box.scrollIntoView({ block: "start" }); }
  })();
  return box;
}
function mailRow(m) {
  const who = m.direction === "in" ? (m.from_name || m.from_addr) : `→ ${m.to_addrs.map((t) => t.name || t.address).join(", ")}`;
  return el("div", { class: `mail-row ${m.direction}` + (m.seen ? "" : " unread"), onclick: () => openMessage(m.id) },
    el("div", { class: "mr-head" }, el("span", { class: "mr-who" }, who), el("span", { class: "mr-date" }, fmtDate(m.date), m.has_attachments ? " 📎" : "", el("span", { class: "mr-acc" }, ` · ${m.account}@`))),
    el("div", { class: "mr-subj" }, m.subject || "(без темы)"), el("div", { class: "mr-snip" }, m.snippet));
}
async function openMessage(id) {
  const m = await api(`/mail/messages/${id}`);
  const accs = await getAccounts();
  const modal = el("div", { class: "modal", onclick: (e) => { if (e.target === modal) modal.remove(); } },
    el("div", { class: "modal-box" },
      el("div", { class: "d-head" }, el("div", {}, el("h2", {}, m.subject || "(без темы)"), el("div", { class: "d-sub" }, `${m.direction === "in" ? "От" : "Кому"}: ${m.direction === "in" ? fmtAddr({ name: m.from_name, address: m.from_addr }) : m.to_addrs.map(fmtAddr).join(", ")} · ${fmtDate(m.date)} · ящик ${m.account}@`)),
        el("button", { class: "btn btn-ghost d-close", onclick: () => modal.remove() }, "✕")),
      m.attachments?.length ? el("div", { class: "atts" }, m.attachments.map((a) => el("a", { href: `/api/mail/attachments/${a.id}`, target: "_blank" }, `📎 ${a.filename} (${Math.round(a.size / 1024)} КБ)`))) : null,
      el("pre", { class: "mail-body" }, m.text || "(пусто)"),
      el("div", { class: "d-actions" },
        m.direction === "in" && m.entity_type ? el("button", { class: "btn btn-accent btn-sm", onclick: () => { modal.remove(); const box = document.querySelector(".d-section.mail"); if (box) composer(box, { type: m.entity_type, id: m.entity_id, to: m.from_addr, replyTo: m, accs, account: m.account }); else { state.autoReply = m; location.hash = `${m.entity_type === "company" ? "companies" : m.entity_type + "s"}/${m.entity_id}`; } } }, "↩ Ответить") : null,
        m.entity_type ? el("a", { class: "btn btn-sm btn-ghost", href: `#${m.entity_type === "company" ? "companies" : m.entity_type + "s"}/${m.entity_id}`, onclick: () => modal.remove() }, `Открыть ${m.entity_type === "lead" ? "лид" : m.entity_type === "deal" ? "сделку" : "клиента"}`) : null)));
  document.body.append(modal);
}
/* Форма письма: адресат, тема, текст (шаблон из скриптов при наличии лида), вложения-PDF, ящик */
function composer(box, { type, id, to, name, lead, replyTo, accs, account }) {
  box.querySelector(".composer")?.remove();
  const accSel = el("select", {}, accs.map((a) => el("option", { value: a.key, selected: (account || (type === "lead" ? "dealers" : "sales")) === a.key ? "" : null }, a.address)));
  const toIn = el("input", { value: to || "", placeholder: "кому@example.ru" });
  const subjIn = el("input", { value: replyTo ? (/^re:/i.test(replyTo.subject) ? replyTo.subject : "Re: " + replyTo.subject) : "", placeholder: "Тема" });
  const body = el("textarea", { rows: 10, placeholder: "Текст письма" });
  if (lead && !replyTo) { const pitch = pitchFor(lead); const t = S().emails[0]; subjIn.value = fillTemplate(t.subject, lead, pitch); body.value = fillTemplate(t.body, lead, pitch); }
  else if (replyTo) body.value = `\n\n${"—".repeat(20)}\n${fmtDate(replyTo.date)}, ${replyTo.from_name || replyTo.from_addr}:\n${(replyTo.snippet || "").split("\n").map((l) => "> " + l).join("\n")}`;
  const tpl = lead ? el("select", { onchange: (e) => { const t = S().emails.find((x) => x.key === e.target.value); if (t) { const pitch = pitchFor(lead); subjIn.value = fillTemplate(t.subject, lead, pitch); body.value = fillTemplate(t.body, lead, pitch); } } }, el("option", { value: "" }, "Шаблон…"), S().emails.map((t) => el("option", { value: t.key }, t.title))) : null;
  const files = [["svp-dealer-price.pdf", "прайс PDF"], ["svp-partner-deck.pdf", "презентация PDF"]].map(([f, l]) => { const cb = el("input", { type: "checkbox", value: f }); return el("label", { class: "field inline" }, cb, l); });
  const err = el("div", { class: "login-err" });
  const send = el("button", { class: "btn btn-accent btn-sm", onclick: async () => {
    send.disabled = true; err.textContent = "";
    try {
      await api("/mail/send", { method: "POST", body: { account: accSel.value, to: toIn.value.trim(), subject: subjIn.value, text: body.value, in_reply_to: replyTo?.message_id, entity_type: type, entity_id: id, files: files.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.value) } });
      form.remove(); const drawer = location.hash.slice(1).split("/"); route();
    } catch (e) { err.textContent = e.message; send.disabled = false; }
  } }, "Отправить");
  const form = el("div", { class: "composer" },
    el("div", { class: "email-head" }, accSel, tpl, el("button", { class: "btn btn-sm btn-ghost", onclick: () => form.remove() }, "Отмена")),
    el("div", { class: "fields" }, el("label", { class: "field" }, "Кому", toIn), el("label", { class: "field" }, "Тема", subjIn)),
    body, el("div", { class: "email-head" }, ...files, send), err);
  box.querySelector("h3").after(form); body.focus();
}

/* Раздел «Почта»: неразобранное + последние письма */
async function renderMail() {
  const [un, recent, accs] = await Promise.all([api("/mail/unassigned"), api("/mail/recent"), getAccounts()]);
  const assignUI = (m) => {
    const sel = el("input", { placeholder: "Компания, лид или сделка…", class: "assign-q" });
    const res = el("div", { class: "assign-res" });
    let t; sel.addEventListener("input", () => { clearTimeout(t); t = setTimeout(async () => {
      const q = sel.value.trim(); if (q.length < 2) return res.replaceChildren();
      const [cs, ls, ds] = await Promise.all([api("/companies?q=" + encodeURIComponent(q)), api("/leads?q=" + encodeURIComponent(q)), api("/deals")]);
      const opts = [...cs.slice(0, 4).map((c) => ["company", c.id, `клиент · ${c.name}${c.city ? " · " + c.city : ""}`]), ...ls.slice(0, 4).map((l) => ["lead", l.id, `лид · ${l.company}${l.city ? " · " + l.city : ""}`]), ...ds.filter((d) => !d.outcome && d.title.toLowerCase().includes(q.toLowerCase())).slice(0, 3).map((d) => ["deal", d.id, `сделка · ${d.title}`])];
      res.replaceChildren(...opts.map(([et, eid, label]) => el("button", { class: "btn btn-sm btn-ghost", onclick: async () => { await api(`/mail/messages/${m.id}/assign`, { method: "POST", body: { entity_type: et, entity_id: eid } }); renderMail(); refreshStats(); } }, label)));
    }, 250); });
    return el("div", { class: "assign" }, sel, res,
      el("button", { class: "btn btn-sm", onclick: async () => { const r = await api(`/mail/messages/${m.id}/to-lead`, { method: "POST", body: {} }); location.hash = `leads/${r.id}`; } }, "+ Новый лид из письма"),
      el("button", { class: "btn btn-sm btn-ghost", title: "Служебное письмо — убрать из неразобранного (все письма этого отправителя)", onclick: async () => { await api(`/mail/messages/${m.id}/dismiss`, { method: "POST", body: { all_from_sender: true } }); renderMail(); refreshStats(); } }, "Скрыть"));
  };
  $("#view").replaceChildren(
    el("div", { class: "view-head" }, el("h1", {}, "Почта"), el("span", { class: "d-sub" }, accs.length ? `${accs.map((a) => a.address).join(", ")} · синхронизация каждую минуту` : "ящики не подключены"),
      el("div", { class: "filters" }, el("button", { class: "btn btn-sm", onclick: async () => { await api("/mail/sync", { method: "POST" }); renderMail(); refreshStats(); } }, "Проверить сейчас"))),
    el("div", { class: "mail-cols" },
      el("div", { class: "col" }, el("div", { class: "col-head" }, el("b", {}, "Неразобранное"), el("span", {}, String(un.length))),
        el("div", { class: "col-body" }, un.length ? un.map((m) => el("div", { class: "card mail-card" + (m.seen ? "" : " unread") },
          el("div", { class: "card-title", onclick: () => openMessage(m.id), style: "cursor:pointer" }, el("span", {}, m.from_name || m.from_addr), el("span", { class: "mr-date" }, fmtDate(m.date))),
          el("div", { class: "card-meta", onclick: () => openMessage(m.id), style: "cursor:pointer" }, el("b", {}, m.subject || "(без темы)"), " — ", m.snippet?.slice(0, 120)),
          el("div", { class: "d-sub" }, `${m.from_addr} · ${m.account}@`), assignUI(m))) : el("div", { class: "empty" }, "Все письма разобраны"))),
      el("div", { class: "col" }, el("div", { class: "col-head" }, el("b", {}, "Последние письма"), el("span", {}, String(recent.length))),
        el("div", { class: "col-body" }, recent.map((m) => el("div", { class: `mail-row ${m.direction}` + (m.seen ? "" : " unread"), onclick: () => openMessage(m.id) },
          el("div", { class: "mr-head" }, el("span", { class: "mr-who" }, m.direction === "in" ? (m.from_name || m.from_addr) : `→ ${m.to_addrs.map((t) => t.address).join(", ")}`), el("span", { class: "mr-date" }, fmtDate(m.date), el("span", { class: "mr-acc" }, ` · ${m.account}@`))),
          el("div", { class: "mr-subj" }, m.subject || "(без темы)", m.entity_type === "ignored" ? el("span", { class: "tag" }, "скрыто") : m.entity_type ? el("span", { class: "tag" }, m.entity_type === "lead" ? "лид" : m.entity_type === "deal" ? "сделка" : "клиент") : el("span", { class: "tag warn" }, "не привязано"))))))));
}

/* ——— СЕГОДНЯ ——— */
const linkTo = (type, id) => `#${type === "company" ? "companies" : type + "s"}/${id}`;
const openEntity = (type, id) => { location.hash = linkTo(type, id); };
async function renderToday() {
  const t = await api("/today");
  const me = state.meta.user;
  const block = (title, count, hint, kids, cls = "") => el("section", { class: "today-block " + cls }, el("div", { class: "tb-head" }, el("h2", {}, title), count ? el("span", { class: "tb-count" }, String(count)) : null, hint ? el("span", { class: "d-sub" }, hint) : null), kids?.length ? el("div", { class: "tb-list" }, kids) : el("div", { class: "empty small" }, "Пусто — хорошо"));
  const row = (main, sub, right, onclick, cls = "") => el("div", { class: "tb-row " + cls, onclick }, el("div", { class: "tb-main" }, el("b", {}, main), sub ? el("span", {}, sub) : null), right ? el("div", { class: "tb-right" }, right) : null);
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
  $("#view").replaceChildren(
    el("div", { class: "view-head" }, el("h1", {}, `${greet}, ${me.name.split(" ")[0]}`),
      el("span", { class: "d-sub" }, `сегодня: ${t.done.calls} звонков · ${t.done.emails} писем · ${t.done.comments} комментариев · ${t.done.stages} движений по воронке${t.done.won.n ? ` · выиграно ${t.done.won.n} на ${rub(t.done.won.amount)}` : ""}${t.done.sequence_sent ? ` · цепочка отправила ${t.done.sequence_sent}` : ""}`)),
    el("div", { class: "today" },
      block("Заявки с сайта", t.fresh.length, "новые, ещё не тронуты", t.fresh.map((l) => row(l.company, [l.contact_name, l.city, l.phones[0]].filter(Boolean).join(" · "), fmtDate(l.created_at), () => openEntity("lead", l.id), "hot")), t.fresh.length ? "accent" : ""),
      block("Ответили", t.replied.length, "входящие без нашего ответа за 7 дней", t.replied.map((m) => row(m.title || m.from_name || m.from_addr, `${m.subject} — ${m.snippet?.slice(0, 90)}`, fmtDate(m.date), () => openMessage(m.mail_id), m.seen ? "" : "unread"))),
      block("Неразобранные письма", t.unassigned.length, null, t.unassigned.slice(0, 6).map((m) => row(m.from_name || m.from_addr, m.subject, fmtDate(m.date), () => { location.hash = "mail"; })).concat(t.unassigned.length > 6 ? [el("a", { class: "text-link", href: "#mail" }, `ещё ${t.unassigned.length - 6} → в «Почту»`)] : [])),
      block("Касания на сегодня", t.touches.length, "следующее действие с датой ≤ сегодня", t.touches.map((x) => row(x.title, `${x.next_action || "касание"} · ${x.type === "lead" ? "лид" : "сделка"}${x.city ? " · " + x.city : ""}`, el("span", { class: isDue(x.next_at) && daysUntil(x.next_at) < 0 ? "due" : "" }, fmtDay(x.next_at)), () => openEntity(x.type, x.id)))),
      block("Пора заказывать", t.reorder.length, "ритм подошёл, открытой сделки нет", t.reorder.map((c) => row(c.name, `${c.orders_count} заказов · ${rub(c.total_amount)} · последний ${fmtDay(c.last_order_at)}${c.phones[0] ? " · " + c.phones[0] : ""}`, el("span", { class: "due" }, dueLabel(c.next_order_at)), () => openEntity("company", c.id)))),
      block("Зависшие сделки", t.stale.length, `без движения больше 7 дней`, t.stale.map((d) => row(d.title, `${state.meta.DEAL_STAGES.find((s) => s.key === d.stage)?.title} · ${rub(d.amount)}`, `${d.days} дн.`, () => openEntity("deal", d.id))))));
}

/* ——— ЦЕПОЧКИ (настройки и очередь) ——— */
async function renderSequences() {
  const s = await api("/sequences");
  const set = (k, v) => api("/sequences/settings", { method: "POST", body: { [k]: v } }).then(renderSequences);
  const st = s.settings;
  const field = (label, k, type = "text", extra = {}) => el("label", { class: "field" }, label, el("input", { type, value: st[k] ?? "", ...extra, onchange: (e) => set(k, e.target.value) }));
  $("#view").replaceChildren(
    el("div", { class: "view-head" }, el("h1", {}, "Цепочки писем"), el("span", { class: "d-sub" }, `сегодня отправлено ${s.sent_today} из ${st.seq_daily_limit} · ${s.in_work_hours ? "рабочее окно открыто" : "вне рабочего окна"} · ${st.seq_enabled === "1" ? "включены" : "выключены"}`)),
    el("div", { class: "doc" },
      el("section", { class: "doc-block" }, el("h2", {}, "Настройки"),
        el("div", { class: "fields sig" },
          el("label", { class: "field inline" }, el("input", { type: "checkbox", checked: st.seq_enabled === "1" ? "" : null, onchange: (e) => set("seq_enabled", e.target.checked ? "1" : "0") }), " Отправка включена"),
          field("Писем в день", "seq_daily_limit", "number", { min: 1, max: 100 }), field("Рабочие часы (МСК, пн–пт)", "seq_hours"),
          el("label", { class: "field" }, "Ящик", select(["dealers", "sales"], st.seq_account, (v) => set("seq_account", v))),
          field("Имя в подписи", "seq_signature_name"), field("Телефон в подписи", "seq_signature_phone")),
        el("div", { class: "d-sub", style: "margin-top:10px" }, "Письма уходят по одному со случайными паузами 10–25 минут только в рабочие часы. Первое — без вложений. Цепочка останавливается сама, если контакт ответил, лид взят в работу или закрыт, письмо не доставлено. Ответ «нет» переводит лид в «Отказ».")),
      el("section", { class: "doc-block" }, el("h2", {}, "Шаги"), el("div", { class: "kv" }, s.sequences[0].steps.map((x, i) => el("div", {}, el("b", {}, `Письмо ${i + 1}`), el("span", {}, `${S().emails.find((e) => e.key === x.template)?.title}${x.delay ? ` — через ${x.delay} дн. после предыдущего` : " — сразу"}`))))),
      el("section", { class: "doc-block" }, el("h2", {}, `Очередь · ${s.queue.length} лидов`),
        s.queue.length ? el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Компания"), el("th", {}, "Город"), el("th", {}, "E-mail"), el("th", {}, "Шаг"), el("th", {}, "Следующее письмо"), el("th", {}))),
          el("tbody", {}, s.queue.map((q) => el("tr", {}, el("td", {}, el("a", { href: `#leads/${q.lead_id}` }, q.company)), el("td", {}, q.city || ""), el("td", {}, q.email), el("td", {}, `${q.step + 1} из 3`), el("td", {}, fmtDate(q.next_at)), el("td", {}, el("button", { class: "btn btn-sm btn-ghost", onclick: async () => { await api("/sequences/stop", { method: "POST", body: { lead_id: q.lead_id } }); renderSequences(); } }, "Стоп")))))) : el("div", { class: "empty" }, "Очередь пуста — запустите цепочку из карточки лида или кнопкой «В цепочку» над доской лидов"),
        el("div", { class: "d-sub", style: "margin-top:8px" }, `Всего: ${s.stats.map((x) => `${x.status} ${x.n}`).join(", ") || "—"}`))));
}

/* ——— ОТЧЁТЫ ——— */
const rstate = { tab: "funnel", from: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), entity: "deals", metric: "won_amount", rows: "month", cols: "", only_won: false };
const num = (v, metric) => metric && /conv/.test(metric) ? `${v} %` : metric && /amount|avg/.test(metric) ? rub(v) : new Intl.NumberFormat("ru-RU").format(Math.round(v || 0));
const bar = (v, max) => el("div", { class: "bar" }, el("i", { style: `width:${max ? Math.max(2, Math.round(100 * v / max)) : 0}%` }));
function rtable(head, rows, opts = {}) {
  return el("div", { class: "rt-wrap" }, el("table", { class: "rt" }, el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i ? "num" : "" }, h)))),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el("td", { class: i ? "num" : "" }, c)))))));
}
async function renderReports() {
  const q = `from=${rstate.from}&to=${rstate.to}`;
  const tabs = [["funnel", "Воронка"], ["sales", "Продажи"], ["clients", "Клиенты"], ["activity", "Активность"], ["pivot", "Сводная"]];
  const periodUI = el("div", { class: "filters" },
    el("label", { class: "field inline" }, "с", el("input", { type: "date", value: rstate.from, onchange: (e) => { rstate.from = e.target.value; renderReports(); } })),
    el("label", { class: "field inline" }, "по", el("input", { type: "date", value: rstate.to, onchange: (e) => { rstate.to = e.target.value; renderReports(); } })),
    ...[["30 дн", 30], ["90 дн", 90], ["год", 365]].map(([l, d]) => el("button", { class: "btn btn-sm btn-ghost", onclick: () => { rstate.to = new Date().toISOString().slice(0, 10); rstate.from = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10); renderReports(); } }, l)));
  const body = el("div", { class: "doc wide" });
  $("#view").replaceChildren(el("div", { class: "view-head" }, el("h1", {}, "Отчёты"), el("div", { class: "tabs" }, tabs.map(([k, t]) => el("button", { class: "tab" + (rstate.tab === k ? " on" : ""), onclick: () => { rstate.tab = k; renderReports(); } }, t))), rstate.tab !== "clients" ? periodUI : null), body);
  const S = state.meta;
  if (rstate.tab === "funnel") {
    const f = await api(`/reports/funnel?${q}`);
    const max = Math.max(...f.bySource.map((b) => b.total), 1);
    body.append(
      el("section", { class: "doc-block" }, el("h2", {}, "Лиды по источникам за период"),
        rtable(["Источник", "Всего", "Тронуто", "Контакт", "Квалиф.", "Сделка", "Догрев", "Отказ", "Конверсия"], f.bySource.map((b) => [el("div", {}, b.source, bar(b.total, max)), b.total, b.touched, b.contacted, b.qualified, el("b", { class: "acc" }, String(b.won)), b.nurture, b.lost, `${Math.round(100 * b.won / Math.max(b.total, 1))} %`])),
        el("div", { class: "d-sub" }, `Среднее время от лида до сделки: ${f.avg_days_lead_to_deal ?? "—"} дн.`)),
      el("div", { class: "two" },
        el("section", { class: "doc-block" }, el("h2", {}, "Лиды сейчас по этапам"), el("div", { class: "kpis" }, f.stageNow.map((s) => el("div", {}, el("b", {}, String(s.n)), el("span", {}, s.title))))),
        el("section", { class: "doc-block" }, el("h2", {}, "Сделки сейчас по этапам"), rtable(["Этап", "Сделок", "Сумма"], f.dealStages.map((s) => [s.title, s.n, rub(s.amount)])))));
  } else if (rstate.tab === "sales") {
    const f = await api(`/reports/sales?${q}`);
    const maxM = Math.max(...f.byMonth.map((m) => m.amount), 1);
    body.append(
      el("div", { class: "kpis" }, el("div", {}, el("b", {}, String(f.totals.n)), el("span", {}, "выигранных сделок")), el("div", {}, el("b", { class: "acc" }, rub(f.totals.amount)), el("span", {}, "выручка")), el("div", {}, el("b", {}, rub(f.totals.avg)), el("span", {}, "средний чек"))),
      el("section", { class: "doc-block" }, el("h2", {}, "По месяцам"), rtable(["Месяц", "Сделок", "Выручка", "из них новые клиенты"], f.byMonth.map((m) => [el("div", {}, m.m, bar(m.amount, maxM)), m.n, rub(m.amount), rub(m.new_amount)]))),
      el("div", { class: "two" },
        el("section", { class: "doc-block" }, el("h2", {}, "По городам"), rtable(["Город", "Сделок", "Выручка"], f.byCity.map((c) => [c.k, c.n, rub(c.amount)]))),
        el("section", { class: "doc-block" }, el("h2", {}, "По группам товаров"), rtable(["Группа", "Штук", "Сумма"], f.byGroup.map((c) => [c.k, num(c.qty), rub(c.amount)])))),
      el("section", { class: "doc-block" }, el("h2", {}, "Топ товаров"), rtable(["Товар", "Штук", "Сумма"], f.topProducts.map((c) => [c.k, num(c.qty), rub(c.amount)]))));
  } else if (rstate.tab === "clients") {
    const f = await api(`/reports/clients`);
    body.append(
      el("div", { class: "kpis" }, el("div", {}, el("b", {}, String(f.summary.n)), el("span", {}, "активных клиентов")), el("div", {}, el("b", {}, String(f.summary.repeat)), el("span", {}, "с повторными заказами")), el("div", {}, el("b", {}, rub(f.summary.avg_check)), el("span", {}, "средний заказ"))),
      el("section", { class: "doc-block" }, el("h2", {}, "Топ по выручке"), rtable(["Клиент", "Город", "Заказов", "Сумма", "Последний", "Следующий"], f.top.map((c) => [el("a", { href: `#companies/${c.id}` }, c.name), c.city || "", c.orders_count, rub(c.total_amount), fmtDay(c.last_order_at), c.next_order_at ? dueLabel(c.next_order_at) : "—"]))),
      el("section", { class: "doc-block" }, el("h2", {}, "Риск потери — просрочили свой ритм больше недели"), f.risk.length ? rtable(["Клиент", "Город", "Заказов", "Сумма", "Просрочка"], f.risk.map((c) => [el("a", { href: `#companies/${c.id}` }, c.name), c.city || "", c.orders_count, rub(c.total_amount), `${c.overdue} дн.`])) : el("div", { class: "empty small" }, "Никто не просрочил")));
  } else if (rstate.tab === "activity") {
    const f = await api(`/reports/activity?${q}`);
    body.append(
      el("div", { class: "kpis" }, el("div", {}, el("b", {}, String(f.mail.sent || 0)), el("span", {}, "писем отправлено")), el("div", {}, el("b", {}, String(f.mail.received || 0)), el("span", {}, "получено")), el("div", {}, el("b", {}, String(f.sequences.total)), el("span", {}, "лидов в цепочках")), el("div", {}, el("b", {}, `${f.sequences.replied} / ${f.sequences.said_no} / ${f.sequences.bounced}`), el("span", {}, "ответили / «нет» / отлуп"))),
      el("div", { class: "two" },
        el("section", { class: "doc-block" }, el("h2", {}, "По людям"), rtable(["Кто", "Всего", "Писем", "Комментариев", "Движений"], f.byAuthor.map((a) => [a.author, a.n, a.emails, a.comments, a.stages]))),
        el("section", { class: "doc-block" }, el("h2", {}, "По дням"), rtable(["День", "Комм.", "Письма", "Звонки", "Этапы"], f.byDay.slice(-30).reverse().map((d) => [d.d, d.comments, d.emails, d.calls, d.stages])))));
  } else {
    const meta = await api("/reports/meta");
    if (!meta.metrics[rstate.entity][rstate.metric]) rstate.metric = Object.keys(meta.metrics[rstate.entity])[0];
    if (!meta.dims[rstate.entity][rstate.rows]) rstate.rows = Object.keys(meta.dims[rstate.entity])[0];
    if (rstate.cols && !meta.dims[rstate.entity][rstate.cols]) rstate.cols = "";
    const sel = (obj, val, key) => el("select", { onchange: (e) => { rstate[key] = e.target.value; renderReports(); } }, Object.entries(obj).map(([k, v]) => el("option", { value: k, selected: k === val ? "" : null }, v)));
    const pq = `entity=${rstate.entity}&metric=${rstate.metric}&rows=${rstate.rows}${rstate.cols ? "&cols=" + rstate.cols : ""}&${q}${rstate.only_won ? "&only_won=1" : ""}`;
    const p = await api(`/reports/pivot?${pq}`);
    const multi = p.cols.length > 1;
    body.append(
      el("section", { class: "doc-block" }, el("h2", {}, "Конструктор"),
        el("div", { class: "pivot-ctl" },
          el("label", { class: "field" }, "Что", sel(meta.entities, rstate.entity, "entity")),
          el("label", { class: "field" }, "Считаем", sel(meta.metrics[rstate.entity], rstate.metric, "metric")),
          el("label", { class: "field" }, "Строки", sel(meta.dims[rstate.entity], rstate.rows, "rows")),
          el("label", { class: "field" }, "Колонки", sel({ "": "—", ...meta.dims[rstate.entity] }, rstate.cols, "cols")),
          rstate.entity === "deals" ? el("label", { class: "field inline" }, el("input", { type: "checkbox", checked: rstate.only_won ? "" : null, onchange: (e) => { rstate.only_won = e.target.checked; renderReports(); } }), " только выигранные") : null,
          el("a", { class: "btn btn-sm", href: `/api/reports/pivot?${pq}&format=csv` }, "↓ CSV"))),
      el("section", { class: "doc-block" }, el("h2", {}, `${meta.entities[rstate.entity]} · ${meta.metrics[rstate.entity][rstate.metric]} · по ${meta.dims[rstate.entity][rstate.rows]}${rstate.cols ? " × " + meta.dims[rstate.entity][rstate.cols] : ""}`),
        p.table.length ? rtable([meta.dims[rstate.entity][rstate.rows], ...(multi ? p.cols : [meta.metrics[rstate.entity][rstate.metric]]), ...(multi ? ["итого"] : [])].concat([]),
          [...p.table.map((r) => { const total = r.cells.reduce((a, b) => a + b, 0); const max = Math.max(...p.table.map((x) => x.cells.reduce((a, b) => a + b, 0)), 1); return [el("div", {}, r.key, bar(total, max)), ...r.cells.map((c) => num(c, rstate.metric)), ...(multi ? [el("b", {}, num(total, rstate.metric))] : [])]; }),
            ...(p.totals[0] != null ? [[el("b", {}, "Итого"), ...p.totals.map((t) => el("b", {}, num(t, rstate.metric))), ...(multi ? [el("b", { class: "acc" }, num(p.totals.reduce((a, b) => a + b, 0), rstate.metric))] : [])]] : [])]) : el("div", { class: "empty small" }, "Нет данных за период")));
  }
}

/* ——— лента и комментарии ——— */
function feedSection(entity, id, activities, reload) {
  const input = el("input", { placeholder: "Комментарий: что обсудили, что дальше…" });
  const send = async () => { if (!input.value.trim()) return; await api(`/${entity}/${id}/activities`, { method: "POST", body: { text: input.value.trim() } }); input.value = ""; reload(); refreshStats(); };
  input.addEventListener("keydown", (e) => e.key === "Enter" && send());
  return el("div", { class: "d-section" }, el("h3", {}, "Лента"),
    el("div", { class: "comment-form" }, input, el("button", { class: "btn btn-accent btn-sm", onclick: send }, "Отправить")),
    el("div", { class: "feed", style: "margin-top:10px" }, activities.length ? activities.map((a) =>
      el("div", { class: `feed-item k-${a.kind}`, onclick: a.kind === "email" && a.meta ? () => openMessage(JSON.parse(a.meta).mail_id) : null, style: a.kind === "email" ? "cursor:pointer" : "" }, a.text, el("div", { class: "feed-meta" }, `${a.author} · ${fmtDate(a.created_at)}`))) : el("div", { class: "empty" }, "Пока пусто")));
}

/* ——— быстрая форма в модалке: fields = [{key,label,type?,options?,required?}] → значения или null ——— */
function quickForm(title, fields, submitLabel = "Создать") {
  return new Promise((resolve) => {
    const inputs = {};
    const modal = el("div", { class: "modal", onclick: (e) => { if (e.target === modal) { modal.remove(); resolve(null); } } });
    const form = el("form", { class: "modal-box qf", onsubmit: (e) => { e.preventDefault(); const v = {}; for (const f of fields) { v[f.key] = inputs[f.key].value.trim(); if (f.required && !v[f.key]) { inputs[f.key].focus(); return; } } modal.remove(); resolve(v); } },
      el("div", { class: "d-head" }, el("h2", {}, title), el("button", { class: "btn btn-ghost d-close", type: "button", onclick: () => { modal.remove(); resolve(null); } }, "✕")),
      el("div", { class: "fields" }, fields.map((f) => el("label", { class: "field" + (f.wide ? " wide" : "") }, f.label + (f.required ? " *" : ""),
        inputs[f.key] = f.options ? el("select", {}, f.options.map((o) => el("option", { value: o }, o))) : el("input", { type: f.type || "text", placeholder: f.placeholder || "", value: f.value || "" })))),
      el("div", { class: "d-actions" }, el("button", { class: "btn btn-accent", type: "submit" }, submitLabel), el("button", { class: "btn btn-ghost", type: "button", onclick: () => { modal.remove(); resolve(null); } }, "Отмена")));
    modal.append(form); document.body.append(modal); Object.values(inputs)[0]?.focus();
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { modal.remove(); resolve(null); document.removeEventListener("keydown", esc); } });
  });
}

/* ——— звонок: результат + комментарий → лента, «перезвонить» ставит дату ——— */
async function logCall(entity, id, reload) {
  const v = await quickForm("Звонок", [
    { key: "result", label: "Результат", options: ["Дозвонился", "Не ответил", "Перезвонить", "Занято", "Неверный номер"] },
    { key: "next_at", label: "Перезвонить когда (для «не ответил / перезвонить»)", type: "date", value: new Date(Date.now() + 86400000).toISOString().slice(0, 10) },
    { key: "comment", label: "Что обсудили / договорились", wide: true, placeholder: "коротко, попадёт в ленту" }], "Записать");
  if (!v) return;
  const map = { "Дозвонился": "reached", "Не ответил": "no_answer", "Перезвонить": "callback", "Занято": "busy", "Неверный номер": "wrong" };
  await api(`/${entity}/${id}/call`, { method: "POST", body: { result: map[v.result], comment: v.comment, next_at: v.next_at } });
  reload(); refreshStats();
}
const callBtn = (entity, id, phone, reload) => el("button", { class: "btn btn-sm", title: phone ? `Позвонить ${phone} и записать результат` : "Записать звонок", onclick: () => { if (phone) window.open("tel:" + phone.replace(/\D/g, ""), "_self"); logCall(entity, id, reload); } }, "☎ Звонок");

/* ——— новый лид ——— */
$("#btn-new-lead").addEventListener("click", async () => {
  const v = await quickForm("Новый лид", [
    { key: "company", label: "Компания", required: true }, { key: "city", label: "Город" },
    { key: "phone", label: "Телефон", type: "tel" }, { key: "email", label: "E-mail", type: "email" },
    { key: "contact_name", label: "Контактное лицо" }, { key: "segment", label: "Сегмент", options: ["салон плитки", "магазин стройматериалов", "сеть салонов плитки", "оптовик / дистрибьютор", "федеральная сеть", "другое"] },
    { key: "source_note", label: "Откуда узнали / заметка", wide: true }]);
  if (!v) return;
  const l = await api("/leads", { method: "POST", body: { company: v.company, city: v.city || null, phones: v.phone ? [v.phone] : [], email: v.email || null, contact_name: v.contact_name || null, segment: v.segment, source: "manual", source_note: v.source_note || null } });
  location.hash = `leads/${l.id}`; route();
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
  try { [state.meta, state.products, mailAccounts] = await Promise.all([api("/meta"), api("/products"), api("/mail/accounts")]); } catch { return; }
  $("#user-name").textContent = state.meta.user?.name || "";
  route();
})();
