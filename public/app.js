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
  if (id) view === "leads" ? openLead(Number(id)) : view === "deals" ? openDeal(Number(id)) : null;
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
    el("div", { class: "card-title" }, el("span", {}, l.company), l.is_chain ? el("span", { class: "chain" }, `сеть · ${l.points.length}`) : null),
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
        ? el("button", { class: "btn btn-accent", onclick: async () => { const d = await api(`/leads/${id}/convert`, { method: "POST", body: {} }); location.hash = `deals/${d.id}`; } }, "В сделку →")
        : el("a", { class: "btn btn-accent", href: `#deals/${l.deal_id}` }, `Сделка #${l.deal_id} →`),
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
  [state.meta, state.products] = await Promise.all([api("/meta"), api("/products")]);
  route();
})();
