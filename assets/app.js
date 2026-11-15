"use strict";
/* «Что у нас есть?» — интерфейс. Этап 1: ручной учёт, сроки, места, журнал.
 *
 * Устройство файла:
 *   1. данные   — два хранилища с одинаковым интерфейсом (сервер / гость);
 *   2. роутер   — History API, три экрана;
 *   3. экраны   — список, места, докупить;
 *   4. листы    — добавление и карточка упаковки;
 *   5. мелочи   — тосты с отменой, форматирование.
 *
 * Чего здесь нет и не должно появиться: показаний, дозировок, советов по
 * применению. Сервис ведёт учёт (ARCHITECTURE.md, «Граница»).
 */
import { createLocalStore } from "./local.js";
import { openScanner, canScan } from "./scan.js";

const X = globalThis.ZapasExpiry;
const GS1 = globalThis.ZapasGs1;
const $ = sel => document.querySelector(sel);
const view = $("#view");
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();

let cfg = { authBase: null, clientId: "zapas", units: [] };
let auth = null;          // null — вход недоступен (нет AUTH_ISSUER или auth лёг)
let api = null;           // текущее хранилище: сервер или localStorage
let state = { me: null, places: [], packs: [], summary: null, place: null, status: null, q: "", showGone: false };

/* ---------- 1. данные ---------- */

/** Сервер. Методы и форма ответа — те же, что у гостевого local.js. */
function createRemoteStore() {
  async function call(path, init = {}) {
    const url = path + (path.includes("?") ? "&" : "?") + "tz=" + encodeURIComponent(TZ);
    const res = await auth.fetch(url, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { status: res.status });
    return res.json();
  }
  return {
    guest: false,
    me: () => call("/api/me"),
    places: () => call("/api/places").then(r => r.places),
    addPlace: body => call("/api/places", { method: "POST", body }),
    renamePlace: (id, name) => call(`/api/places/${id}`, { method: "PATCH", body: { name } }),
    deletePlace: id => call(`/api/places/${id}`, { method: "DELETE" }),
    items: () => call("/api/items").then(r => r.items),
    household: () => call("/api/household"),
    renameHousehold: name => call("/api/household", { method: "PATCH", body: { name } }),
    leaveHousehold: () => call("/api/household/leave", { method: "POST" }),
    friends: () => call("/api/friends").then(r => r?.friends || []),
    inviteFriend: userId => call("/api/household/invite", { method: "POST", body: { userId } }),
    answerInvite: (id, how) => call(`/api/invites/${id}/${how}`, { method: "POST" }),
    cancelInvite: id => call(`/api/invites/${id}`, { method: "DELETE" }),
    removeMember: userId => call(`/api/household/members/${userId}`, { method: "DELETE" }),
    setNotify: body => call("/api/me/notify", { method: "PUT", body }),
    readLeaflet: (image, name) => call("/api/leaflet/photo", { method: "POST", body: { image, name } }),
    shareToCatalog: body => call("/api/catalog", { method: "POST", body: { ...body, source: "photo" } }),
    pushKey: () => call("/api/push/key").then(r => r?.publicKey),
    pushSubscribe: subscription => call("/api/push/subscribe", { method: "POST", body: { subscription } }),
    pushUnsubscribe: endpoint => call("/api/push/unsubscribe", { method: "POST", body: { endpoint } }),
    lookup: ({ gtin, serial } = {}) => call("/api/lookup?" + new URLSearchParams(
      Object.entries({ gtin: gtin || "", serial: serial || "" }).filter(([, v]) => v))),
    addItem: body => call("/api/items", { method: "POST", body }),
    updateItem: (id, body) => call(`/api/items/${id}`, { method: "PATCH", body }),
    packs: (f = {}) => call("/api/packs?" + new URLSearchParams(
      Object.entries({ place: f.placeId || "", status: f.status || "have", kind: f.kind || "" }).filter(([, v]) => v))),
    addPack: body => call("/api/packs", { method: "POST", body }),
    patchPack: (id, body) => call(`/api/packs/${id}`, { method: "PATCH", body }),
    deletePack: id => call(`/api/packs/${id}`, { method: "DELETE" }),
    undo: () => call("/api/undo", { method: "POST" }),
    history: id => call(`/api/packs/${id}/history`),
    shopping: () => call("/api/shopping").then(r => r.list),
  };
}

const local = createLocalStore();

async function loadConfig() {
  try { cfg = { ...cfg, ...await (await fetch("/api/config")).json() }; }
  catch { /* без сети работаем как гость — это не ошибка, а режим */ }
}

/** Вход необязателен. Если он есть и человек вошёл — работаем с сервером. */
async function initAuth() {
  if (!cfg.authBase || typeof createAuthClient !== "function") return;
  auth = createAuthClient({
    authBase: cfg.authBase,
    clientId: cfg.clientId,
    // Фиксированный корень: redirect_uri сверяется побайтово с тем, что
    // зарегистрировано в auth, а маршрутов у нас несколько.
    redirectUri: location.origin + "/",
    storagePrefix: "zapas",
  });
  try { await auth.handleRedirect(); } catch (e) { console.error("Вход не завершился:", e); }
  if (!auth.isAuthenticated()) return;
  api = createRemoteStore();
  // Первый вход: то, что человек успел завести гостем, уезжает в дом.
  if (!local.isEmpty()) {
    try {
      const r = await auth.fetch("/api/import-guest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: local.exportAll() }),
      }).then(x => x.json());
      if (r && r.imported) { local.clear(); toast(`Аптечка перенесена: ${r.packs} упаковок`); }
    } catch (e) { console.error("Перенос гостевой аптечки не удался:", e); }
  }
}

/* ---------- 2. роутер ---------- */

const route = () => location.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];

function go(href) {
  if (location.pathname === href) return;
  history.pushState(null, "", href);
  render();
}

document.addEventListener("click", e => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(new URL(a.href).pathname);
});
addEventListener("popstate", () => render());

/* ---------- 3. экраны ---------- */

async function refresh() {
  const [me, data] = await Promise.all([api.me(), api.packs({ placeId: state.place, status: state.showGone ? "all" : "have" })]);
  state.me = me;
  state.places = me.places;
  state.packs = data.packs;
  state.summary = data.summary;
}

async function render() {
  const r = route();
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("on", a.dataset.tab === r);
  renderAccount();
  try {
    if (r === "mesta") return await renderPlaces();
    if (r === "dokupit") return await renderShopping();
    if (r === "dom") return await renderHome();
    return await renderList();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<p class="empty">Не получилось загрузить. <button class="link" id="retry">Повторить</button></p>`;
    $("#retry").onclick = () => render();
  }
}

function renderAccount() {
  const box = $("#account");
  if (api.guest) {
    box.innerHTML = cfg.authBase
      ? `<button class="btn ghost" id="loginBtn">Войти</button>`
      : "";
    const b = $("#loginBtn");
    if (b) b.onclick = () => auth.login();
    return;
  }
  const name = state.me?.user?.name || "вы";
  box.innerHTML = `<details class="menu"><summary>${esc(name)}</summary><div class="menu-body">
      <a href="${esc(auth.accountUrl())}" target="_blank" rel="noopener">Аккаунт BurningHouse</a>
      <button class="link" id="outBtn">Выйти</button>
    </div></details>`;
  $("#outBtn").onclick = () => auth.logout();
}

const STATUS_TITLE = {
  expired: "Истекло",
  urgent: "Вот-вот истечёт",
  soon: "Скоро истечёт",
  ok: "В запасе",
  unknown: "Без срока",
};

async function renderList() {
  await refresh();
  // Имя в шапке приезжает тем же /api/me, что и список: до него в углу
  // честное «вы», после — имя, и перерисовать шапку нужно здесь.
  renderAccount();
  const s = state.summary || {};
  const q = state.q.trim().toLowerCase();
  const packs = state.packs.filter(p => (!q
    || p.item.name.toLowerCase().includes(q)
    || (p.item.mnn || "").toLowerCase().includes(q))
    // Фильтр по состоянию: сводка — это не только счётчики, но и вопрос
    // «покажи именно их». Законченное и выброшенное сроков уже не имеют,
    // поэтому под фильтр состояния не попадают.
    && (!state.status || (p.status === "have" && p.expiry.status === state.status)));

  const groups = new Map();
  for (const p of packs) {
    const key = p.status === "have" ? p.expiry.status : "gone";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  view.innerHTML = `
    <h1 class="sr-only">Аптечка</h1>
    <section class="summary" aria-label="Сводка и фильтр по состоянию">
      ${chip("expired", s.expired, "истекло")}
      ${chip("urgent", s.urgent, "вот-вот")}
      ${chip("soon", s.soon, "скоро")}
      ${chip("all", s.total, "всего упаковок")}
    </section>
    <section class="filters">
      <input class="search" id="q" type="search" placeholder="Название или вещество" value="${esc(state.q)}" autocomplete="off">
      <div class="chips" id="placeChips">
        <button class="chip${state.place ? "" : " on"}" data-place="">Везде</button>
        ${state.places.map(pl => `<button class="chip${state.place === pl.id ? " on" : ""}" data-place="${pl.id}">${esc(pl.name)}<i>${pl.packs}</i></button>`).join("")}
      </div>
    </section>
    ${packs.length ? [...groups.entries()].map(([k, list]) => `
      <section class="group st-${k}">
        <h2>${k === "gone" ? "Закончилось и выброшено" : STATUS_TITLE[k]} <i>${list.length}</i></h2>
        <ul class="packs">${list.map(packCard).join("")}</ul>
      </section>`).join("") : `<p class="empty">${state.q || state.place || state.status ? "Ничего не нашлось." : "Пока пусто. Нажмите «Добавить» и внесите первую упаковку."}</p>`}
    <p class="more"><button class="link" id="toggleGone">${state.showGone ? "Скрыть законченное" : "Показать законченное и выброшенное"}</button></p>
  `;

  $("#q").oninput = e => {
    state.q = e.target.value;
    // Перерисовываем только список: перерисовка всего экрана отнимает фокус
    // у поля, и набирать становится невозможно.
    renderList();
  };
  if (state.q) { const el = $("#q"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  for (const b of view.querySelectorAll("#placeChips .chip")) {
    b.onclick = () => { state.place = b.dataset.place || null; renderList(); };
  }
  for (const b of view.querySelectorAll(".sum[data-status]")) {
    b.onclick = () => {
      const k = b.dataset.status;
      // Повторный клик по включённому блоку снимает фильтр — иначе из него
      // не выйти, не догадавшись нажать «всего».
      state.status = k === "all" || state.status === k ? null : k;
      // Под фильтром состояния законченному и выброшенному места нет.
      if (state.status) state.showGone = false;
      renderList();
    };
  }
  $("#toggleGone").onclick = () => { state.showGone = !state.showGone; renderList(); };
  bindPackCards();
}

/** Блок сводки — он же фильтр: цифра отвечает на «сколько», клик — на «какие». */
function chip(kind, n, label) {
  const on = kind === "all" ? !state.status : state.status === kind;
  // Пустую группу не на что фильтровать: кнопка остаётся, но не нажимается —
  // так счётчик не исчезает из сводки и не прыгает вёрстка.
  const dead = !n && kind !== "all";
  return `<button type="button" class="sum sum-${kind}${n ? "" : " zero"}${on ? " on" : ""}"
    data-status="${kind}" aria-pressed="${on}"${dead ? " disabled" : ""}>
    <b>${n ?? 0}</b><span>${label}</span></button>`;
}

function packCard(p) {
  const i = p.item;
  const label = p.status === "have" ? X.label(p.expiry) : (p.status === "used" ? "закончилось" : "выброшено");
  const sub = [i.dose, i.form].filter(Boolean).join(", ");
  return `<li class="pack st-${p.status === "have" ? p.expiry.status : "gone"}" data-id="${p.id}">
    <button class="pack-main" data-open="${p.id}">
      <span class="pack-name">${esc(i.name)}${i.rx ? ` <i class="rx" title="по рецепту">Rx</i>` : ""}</span>
      ${sub ? `<span class="pack-sub">${esc(sub)}</span>` : ""}
      <span class="pack-meta">
        <span class="exp">${esc(X.human(p.expiry))}</span>
        ${label ? `<span class="dot">·</span><span class="left">${esc(label)}</span>` : ""}
        ${p.openedOn ? `<span class="dot">·</span><span class="opened">вскрыто</span>` : ""}
      </span>
    </button>
    <span class="pack-qty${p.low ? " low" : ""}">${fmtQty(p.qty, i.unit)}</span>
  </li>`;
}

function bindPackCards() {
  for (const b of view.querySelectorAll("[data-open]")) {
    b.onclick = () => openPack(b.dataset.open);
  }
}

/** 'YYYY-MM-DD' → «14 ноября 2026». Формат даёт Intl, а не наша табличка:
 *  у браузера он всегда правильный для языка страницы. */
function humanDate(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return String(iso || "");
  try { return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d))); }
  catch { return iso; }
}

const fmtQty = (q, unit) => `${Number(q) % 1 ? Number(q).toFixed(1).replace(".", ",") : q}${unit ? " " + unit : ""}`;

async function renderPlaces() {
  const places = await api.places();
  state.places = places;
  view.innerHTML = `
    <h1 class="h1">Места</h1>
    <p class="hint">Куда вы реально кладёте вещи: аптечка в ванной, дорожная сумка, дача. Удаление места не трогает упаковки — они просто остаются без места.</p>
    <ul class="places">
      ${places.map(p => `<li data-id="${p.id}">
        <span class="place-name">${esc(p.name)}</span>
        <span class="place-n">${p.packs}</span>
        <button class="icon-btn" data-rename="${p.id}" title="Переименовать" aria-label="Переименовать место «${esc(p.name)}»">${ICON.pencil}</button>
        <button class="icon-btn danger" data-del="${p.id}" title="Удалить" aria-label="Удалить место «${esc(p.name)}»">${ICON.trash}</button>
      </li>`).join("") || `<li class="empty">Мест пока нет.</li>`}
    </ul>
    <form class="row" id="addPlace">
      <input name="name" autocomplete="off" placeholder="Новое место" maxlength="80" required>
      <button class="btn" type="submit">Добавить</button>
    </form>`;

  $("#addPlace").onsubmit = async e => {
    e.preventDefault();
    const name = e.target.name.value;
    if (await api.addPlace({ name })) renderPlaces();
  };
  for (const b of view.querySelectorAll("[data-rename]")) b.onclick = async () => {
    const cur = places.find(p => p.id === b.dataset.rename);
    const name = await askSheet({
      title: "Новое название места", confirm: "Переименовать",
      field: { label: "Название", value: cur.name, maxlength: 80 },
    });
    if (name && await api.renamePlace(b.dataset.rename, name)) renderPlaces();
  };
  for (const b of view.querySelectorAll("[data-del]")) b.onclick = async () => {
    const cur = places.find(p => p.id === b.dataset.del);
    if (!await askSheet({ title: `Удалить место «${cur.name}»?`,
      hint: "Упаковки останутся, но без места.", confirm: "Удалить", danger: true })) return;
    await api.deletePlace(b.dataset.del);
    renderPlaces();
  };
}

const REASON = {
  out: { title: "Кончилось", hint: "упаковок не осталось" },
  expired: { title: "Только просроченное", hint: "всё, что есть, уже истекло" },
  low: { title: "Заканчивается", hint: "осталось меньше порога" },
};

async function renderShopping() {
  const list = await api.shopping();
  const groups = ["out", "expired", "low"].map(r => [r, list.filter(x => x.reason === r)]).filter(([, l]) => l.length);
  view.innerHTML = `
    <h1 class="h1">Докупить</h1>
    ${groups.length ? groups.map(([r, l]) => `
      <section class="group">
        <h2>${REASON[r].title} <i>${l.length}</i></h2>
        <p class="hint">${REASON[r].hint}</p>
        <ul class="buy">${l.map(x => `<li>${esc(x.item.name)}${x.item.dose ? `<span class="pack-sub">${esc(x.item.dose)}</span>` : ""}${x.reason === "low" ? `<span class="pack-qty low">${fmtQty(x.qty, x.item.unit)}</span>` : ""}</li>`).join("")}</ul>
      </section>`).join("") : `<p class="empty">Ничего докупать не нужно.</p>`}`;
}

/* ---------- экран дома: участники, приглашения, напоминания ---------- */

/* Иконки для кнопок без слов. Сам значок всегда aria-hidden, а что кнопка
   делает — написано в aria-label рядом, с названием места: «Удалить место
   „Аптечка“». Иначе человек, слушающий страницу, получает список из
   одинаковых «кнопка, кнопка, кнопка». */
const ICON = {
  pencil: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
  // Участника не удаляют, а выводят из дома: корзина здесь сказала бы о
  // человеке не то. Человек со знаком минус — ровно про «больше не с нами».
  userMinus: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M17 11h5"/></svg>`,
};

const KIND_LABEL = {
  expiring: "истекает в этом месяце",
  expired: "уже истекло",
  openExpiring: "вскрытое заканчивается",
  low: "остаётся мало",
};

async function renderHome() {
  if (api.guest) {
    view.innerHTML = `
      <h1 class="h1">Дом</h1>
      <p class="hint">Аптечка сейчас живёт только в этом браузере. Вход добавляет три вещи:
      общий дом с домашними, напоминания о сроках и синхронизацию между устройствами.</p>
      ${cfg.authBase ? `<button class="btn" id="homeLogin">Войти</button>` : `<p class="empty">Вход сейчас недоступен.</p>`}`;
    const b = $("#homeLogin");
    if (b) b.onclick = () => auth.login();
    return;
  }

  const [data, me] = await Promise.all([api.household(), api.me()]);
  state.me = me;
  const notify = me.notify || { remindAt: "10:00", kinds: {} };
  const isOwner = data.household.role === "owner";

  view.innerHTML = `
    <h1 class="h1">${esc(data.household.name)}</h1>
    <p class="hint">Аптечка общая: всё, что добавил один, видят остальные. Участники — из вашего списка друзей BurningHouse.</p>

    ${data.invites.incoming.length ? `<section class="group">
      <h2>Вас зовут</h2>
      <ul class="places">${data.invites.incoming.map(i => `<li>
        <span class="place-name">${esc(i.fromName || "Кто-то")} → «${esc(i.householdName)}»</span>
        <button class="link" data-accept="${i.id}">принять</button>
        <button class="link danger" data-decline="${i.id}">отклонить</button>
      </li>`).join("")}</ul>
    </section>` : ""}

    <section class="group">
      <h2>Кто в доме <i>${data.members.length}</i></h2>
      <ul class="places">${data.members.map(m => `<li>
        <span class="place-name">${esc(m.name || "участник")}${m.isMe ? " <small>— вы</small>" : ""}</span>
        <span class="place-n">${m.role === "owner" ? "владелец" : ""}</span>
        ${isOwner && !m.isMe ? `<button class="icon-btn danger" data-remove="${m.userId}" title="Убрать из дома"
          aria-label="Убрать из дома: ${esc(m.name || "участник")}">${ICON.userMinus}</button>` : ""}
      </li>`).join("")}</ul>
      ${data.invites.outgoing.length ? `<p class="hint">Ждут ответа: ${data.invites.outgoing.map(i =>
        `${esc(i.toUser.slice(0, 8))}… <button class="link" data-cancel="${i.id}">отменить</button>`).join(", ")}</p>` : ""}
      <div class="row">
        <button class="btn ghost" id="inviteBtn">Позвать</button>
        ${isOwner ? `<button class="btn ghost" id="renameBtn">Переименовать</button>` : ""}
        <button class="btn ghost danger" id="leaveBtn">Выйти из дома</button>
      </div>
    </section>

    <section class="group">
      <h2>Напоминания</h2>
      <p class="hint">Одно сообщение в день, пачкой — а не по уведомлению на каждую упаковку.</p>
      <label class="row-label">Время<input type="time" id="remindAt" value="${esc(notify.remindAt)}"></label>
      <ul class="kinds">${Object.entries(KIND_LABEL).map(([k, label]) => `<li>
        <label class="check"><input type="checkbox" data-kind="${k}"${notify.kinds[k] === false ? "" : " checked"}> ${label}</label>
      </li>`).join("")}</ul>
      <div class="row">
        <button class="btn ghost" id="pushBtn">Уведомления на это устройство</button>
      </div>
      <p class="hint" id="pushState"></p>
    </section>`;

  for (const b of view.querySelectorAll("[data-accept]")) b.onclick = async () => {
    const r = await api.answerInvite(b.dataset.accept, "accept");
    toast(r ? `Вы в доме «${r.joined.name}»` : "Не получилось");
    renderHome();
  };
  for (const b of view.querySelectorAll("[data-decline]")) b.onclick = async () => { await api.answerInvite(b.dataset.decline, "decline"); renderHome(); };
  for (const b of view.querySelectorAll("[data-cancel]")) b.onclick = async () => { await api.cancelInvite(b.dataset.cancel); renderHome(); };
  for (const b of view.querySelectorAll("[data-remove]")) b.onclick = async () => {
    // Кнопка теперь без слов, поэтому имя называет подтверждение: при
    // нескольких участниках иначе не видно, кого именно убираешь.
    const who = data.members.find(m => m.userId === b.dataset.remove);
    if (!await askSheet({
      title: `Убрать из дома: ${who?.name || "участник"}?`,
      hint: "Аптечка останется у дома, а не у него.", confirm: "Убрать", danger: true,
    })) return;
    await api.removeMember(b.dataset.remove);
    renderHome();
  };
  $("#inviteBtn").onclick = () => openInvite();
  const rn = $("#renameBtn");
  if (rn) rn.onclick = async () => {
    const name = await askSheet({
      title: "Как назвать дом?", confirm: "Переименовать",
      field: { label: "Название", value: data.household.name, maxlength: 80 },
    });
    if (name && await api.renameHousehold(name)) renderHome();
  };
  $("#leaveBtn").onclick = async () => {
    if (!await askSheet({ title: "Выйти из дома?",
      hint: "Общая аптечка останется у остальных.", confirm: "Выйти", danger: true })) return;
    const r = await api.leaveHousehold();
    if (!r) return toast("В доме вы один — выйти некуда. Данные удаляются отдельно.");
    toast("Вы вышли из дома");
    go("/");
  };

  const save = async () => {
    const kinds = {};
    for (const c of view.querySelectorAll("[data-kind]")) kinds[c.dataset.kind] = c.checked;
    await api.setNotify({ remindAt: $("#remindAt").value, kinds });
    toast("Сохранено");
  };
  $("#remindAt").onchange = save;
  for (const c of view.querySelectorAll("[data-kind]")) c.onchange = save;
  initPush();
}

/** Подписка браузера на уведомления. Кнопка честно говорит, что происходит. */
async function initPush() {
  const btn = $("#pushBtn"), st = $("#pushState");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.disabled = true;
    st.textContent = "Этот браузер не умеет уведомления на устройство.";
    return;
  }
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const sub = reg && await reg.pushManager.getSubscription();
  const paint = on => {
    btn.textContent = on ? "Выключить на этом устройстве" : "Уведомления на это устройство";
    st.textContent = on ? "Включены здесь." : "Пока выключены здесь.";
  };
  paint(!!sub);
  btn.onclick = async () => {
    const cur = reg && await reg.pushManager.getSubscription();
    if (cur) {
      await api.pushUnsubscribe(cur.endpoint);
      await cur.unsubscribe();
      return paint(false);
    }
    if (await Notification.requestPermission() !== "granted") {
      st.textContent = "Браузер не разрешил уведомления — это решается в его настройках.";
      return;
    }
    const key = await api.pushKey();
    const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
    await api.pushSubscribe(fresh.toJSON());
    paint(true);
  };
}

/** base64url → Uint8Array: applicationServerKey принимает только его. */
function urlB64(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function openInvite() {
  openSheet(`<div class="pack-sheet"><h2>Кого позвать</h2><p class="loading">Загружаю друзей…</p></div>`);
  let friends = [];
  try { friends = await api.friends(); }
  catch { /* ниже покажем пустой список с объяснением */ }
  openSheet(`
    <div class="pack-sheet">
      <h2>Кого позвать</h2>
      <p class="hint">Список — друзья вашего аккаунта BurningHouse. Своего списка контактов сервис не ведёт: дружба заводится один раз в кабинете и действует во всех сервисах.</p>
      ${friends.length ? `<ul class="places">${friends.map(f => `<li>
        <span class="place-name">${esc(f.name)}</span>
        ${f.member ? `<span class="place-n">уже в доме</span>`
          : f.invited ? `<span class="place-n">позвали</span>`
            : `<button class="link" data-invite="${f.userId}">позвать</button>`}
      </li>`).join("")}</ul>`
      : `<p class="empty">Друзей пока нет. Их добавляют в кабинете BurningHouse${auth ? ` — <a href="${esc(auth.accountUrl())}" target="_blank" rel="noopener">открыть</a>` : ""}.</p>`}
      <p class="sheet-close"><button class="link" data-close>Закрыть</button></p>
    </div>`, () => {
    for (const b of host.querySelectorAll("[data-invite]")) b.onclick = async () => {
      const r = await api.inviteFriend(b.dataset.invite);
      closeSheet();
      toast(r?.already ? "Этот человек уже в доме" : "Приглашение отправлено");
      renderHome();
    };
  });
}

/* ---------- 4. листы: добавление и карточка ---------- */

const host = $("#sheetHost");

function openSheet(html, onMount) {
  host.hidden = false;
  host.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  for (const el of host.querySelectorAll("[data-close]")) el.onclick = closeSheet;
  document.body.classList.add("locked");
  if (onMount) onMount();
  focusFirst(host);
}

/** Фокус в первое поле — только там, где есть настоящий курсор. На телефоне
 *  это вызывает клавиатуру, и она закрывает половину только что открытой формы. */
function focusFirst(scope) {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const first = scope.querySelector("input:not([type=hidden]), select, button:not([data-close])");
  if (first) first.focus();
}
function closeSheet() {
  host.hidden = true;
  host.innerHTML = "";
  document.body.classList.remove("locked");
}
addEventListener("keydown", e => { if (e.key === "Escape" && !host.hidden) closeSheet(); });

/**
 * Маленький лист вместо системных prompt() и confirm().
 *
 * prompt() на телефоне — окно без нужной клавиатуры и без выбора из
 * списка: «куда переложить» он превращал в нумерованное меню, которое
 * надо читать стоя у шкафчика. Здесь же сразу числовая клавиатура,
 * настоящий <select> и кнопка под большим пальцем.
 *
 * Возвращает введённое значение или null, если человек передумал.
 */
function askSheet({ title, hint, field, confirm: confirmText, danger }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; closeSheet(); resolve(v); } };
    const body = field ? (field.options
      ? `<label>${esc(field.label)}<select name="v">${field.options.map(o =>
        `<option value="${esc(o.value)}"${o.value === field.value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`
      : `<label>${esc(field.label)}<input name="v" value="${esc(field.value ?? "")}"
           ${field.numeric ? 'inputmode="decimal"' : ""} maxlength="${field.maxlength || 200}" autocomplete="off"></label>`)
      : "";
    openSheet(`
      <form id="askForm">
        <h2>${esc(title)}</h2>
        ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}
        ${body}
        <div class="actions">
          <button class="btn ghost" type="button" id="askNo">Отмена</button>
          <button class="btn${danger ? " danger" : ""}" type="submit">${esc(confirmText || "Готово")}</button>
        </div>
      </form>`, () => {
      $("#askNo").onclick = () => finish(null);
      for (const el of host.querySelectorAll("[data-close]")) el.onclick = () => finish(null);
      $("#askForm").onsubmit = e => {
        e.preventDefault();
        finish(field ? (new FormData(e.target).get("v") || "").toString().trim() : true);
      };
      focusFirst(host);
    });
    // Закрыли крестиком/фоном/Escape — промис не должен зависнуть.
    const watch = setInterval(() => { if (host.hidden) { clearInterval(watch); finish(null); } }, 200);
  });
}

/** Барабаны месяца и года вместо календаря: на упаковке напечатан месяц,
 *  а календарь на телефоне — три тапа и промах (ARCHITECTURE.md). */
function monthPicker(value) {
  const now = new Date();
  const [vy, vm] = (value || "").split("-").map(Number);
  const years = Array.from({ length: 16 }, (_, i) => now.getFullYear() - 1 + i);
  return `<div class="ym">
    <select name="expMonth" aria-label="Месяц">
      <option value="">— месяц —</option>
      ${X.MONTHS.map((n, i) => `<option value="${String(i + 1).padStart(2, "0")}"${vm === i + 1 ? " selected" : ""}>${n}</option>`).join("")}
    </select>
    <select name="expYear" aria-label="Год">
      <option value="">— год —</option>
      ${years.map(y => `<option value="${y}"${vy === y ? " selected" : ""}>${y}</option>`).join("")}
    </select>
  </div>`;
}

const UNIT_OPTIONS = ["таб", "капс", "мл", "г", "шт", "доза", "пак"];

/**
 * Форма добавления. pre — то, что уже известно из кода на упаковке:
 * { gtin, serial, expiresOn, item, known } (см. afterScan).
 *
 * Когда код знаком, форма открывается заполненной, и человеку остаётся
 * срок — это и есть обещанные «два тапа». Незнакомый код спрашивает
 * название ОДИН раз: связка «код → позиция» потом живёт в каталоге дома.
 */
function openAdd(pre = {}) {
  const it = pre.item || {};
  const val = v => (v === null || v === undefined ? "" : esc(v));
  openSheet(`
    <form id="addForm">
      <h2>${pre.known ? "Знакомая упаковка" : pre.gtin ? "Новый код" : "Новая упаковка"}</h2>
      ${pre.gtin ? `<p class="scanned">Код: <code>${esc(pre.gtin)}</code>${pre.serial ? " · коробка опознана" : ""}${
        pre.known ? "" : "<br><small>Назовите препарат один раз — дальше этот код будет узнаваться сам.</small>"}</p>` : ""}
      <label>Название<input name="name" required maxlength="200" autocomplete="off" placeholder="Ибупрофен" value="${val(it.name)}"></label>
      <div class="two">
        <label>Дозировка<input name="dose" autocomplete="off" maxlength="60" placeholder="200 мг" value="${val(it.dose)}"></label>
        <label>Форма<input name="form" autocomplete="off" maxlength="120" placeholder="таблетки" value="${val(it.form)}"></label>
      </div>
      <label>Срок годности на упаковке${monthPicker(pre.expiresOn || "")}</label>
      <div class="two">
        <label>Сколько<input name="qty" autocomplete="off" inputmode="decimal" placeholder="20" value="${val(it.packQty)}"></label>
        <label>Единица<select name="unit">${UNIT_OPTIONS.map(u => `<option${u === (it.unit || "таб") ? " selected" : ""}>${u}</option>`).join("")}</select></label>
      </div>
      <label>Где лежит<select name="placeId">
        <option value="">— не указано —</option>
        ${state.places.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
      </select></label>
      ${cfg.photoReading && !api.guest ? `<p class="shoot">
        <button class="btn ghost" type="button" id="shootBtn">Прочитать с инструкции</button>
        <small>Сфотографируйте вкладыш — срок после вскрытия и условия хранения заполнятся сами.</small>
      </p>` : ""}
      <details class="extra">
        <summary>Ещё</summary>
        <label>Годен после вскрытия, дней<input name="afterOpenDays" autocomplete="off" inputmode="numeric" placeholder="28" value="${val(it.afterOpenDays)}">
          <small>Капли и сиропы живут недели после вскрытия, а на коробке стоит далёкий год. Если знаете — впишите, срок пересчитается сам.</small></label>
        <label>Действующее вещество<input name="mnn" autocomplete="off" maxlength="200" placeholder="ибупрофен" value="${val(it.mnn)}"></label>
        <label>Предупреждать, когда останется<input name="lowAt" autocomplete="off" inputmode="decimal" placeholder="4" value="${val(it.lowAt)}"></label>
        <label>Заметка<input name="note" autocomplete="off" maxlength="300"></label>
      </details>
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Отмена</button>
        <button class="btn" type="submit">Добавить</button>
      </div>
    </form>`, () => {
    // Знакомый код — курсор сразу в месяц: остальное уже заполнено.
    const first = pre.known ? host.querySelector('[name="expMonth"]') : host.querySelector('[name="name"]');
    if (first) first.focus();

    const shoot = $("#shootBtn");
    if (shoot) shoot.onclick = () => {
      const form = $("#addForm");
      if (!form.name.value.trim()) return toast("Сначала название — по нему препарат попадёт в каталог");
      // Форму переоткрываем: лист со снимком её закрывает, а введённое терять нельзя.
      const keep = Object.fromEntries(new FormData(form).entries());
      readLeafletPhoto(form, (taken, quotes) => {
        const merged = { ...pre, item: { ...(pre.item || {}), ...taken }, keep, fromPhoto: { ...taken, quotes } };
        openAdd(merged);
        toast(Object.keys(taken).length ? "Подставлено — проверьте и добавьте" : "Ничего не подставлено");
      });
    };

    // Возврат после снимка: восстанавливаем то, что человек уже ввёл.
    if (pre.keep) for (const [k, v] of Object.entries(pre.keep)) {
      const el = host.querySelector(`[name="${k}"]`);
      if (el && !el.value && v) el.value = v;
    }
    $("#addForm").onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const v = k => (f.get(k) || "").toString().trim();
      const body = {
        name: v("name"), dose: v("dose"), form: v("form"), mnn: v("mnn"),
        unit: v("unit"), qty: v("qty") || null,
        afterOpenDays: v("afterOpenDays") || null, lowAt: v("lowAt") || null,
        note: v("note"), placeId: v("placeId") || null,
        expiresOn: v("expMonth") && v("expYear") ? `${v("expYear")}-${v("expMonth")}` : null,
        gtin: pre.gtin || null, serial: pre.serial || null, itemId: it.id || null,
      };
      if (!body.name) return;
      // Что про этот препарат написано в официальной инструкции. Своё не
      // трогаем: человек смотрит на свою упаковку, а она могла быть другой
      // серии. Справочник общий для гостя и вошедшего — ручка без входа.
      try {
        const { leaflet } = await (await fetch("/api/leaflet?name=" + encodeURIComponent(body.name))).json();
        if (leaflet) {
          if (!body.afterOpenDays && leaflet.afterOpenDays) body.afterOpenDays = leaflet.afterOpenDays;
          if (!body.form && leaflet.form) body.form = leaflet.form;
          if (!body.mnn && leaflet.mnn) body.mnn = leaflet.mnn;
          if (body.storageMaxC === undefined && leaflet.storageMaxC !== undefined) body.storageMaxC = leaflet.storageMaxC;
          if (body.rx === undefined && typeof leaflet.rx === "boolean") body.rx = leaflet.rx;
        }
      } catch { /* нет сети или справочника — просто добавим как есть */ }
      const r = await api.addPack(body);
      closeSheet();
      if (!r) return toast("Не добавилось. Проверьте название и попробуйте ещё раз");
      // Подтверждённое со снимка уезжает в общий каталог: следующий дом с
      // этим препаратом получит поля даром. Анонимно — см. ARCHITECTURE.md.
      if (pre.fromPhoto) {
        const { quotes, ...fields } = pre.fromPhoto;
        api.shareToCatalog({ name: body.name, dose: body.dose, gtin: body.gtin, ...fields, quotes })
          .catch(e => console.error("В общий каталог не ушло:", e));
      }
      toast(r.duplicate ? "Эта коробка уже была в аптечке" : `«${r.item.name}» добавлен`);
      render();
    };
  });
}

/* ---------- снимок вкладыша ---------- */

const FIELD_LABEL = {
  afterOpenDays: "Годен после вскрытия",
  storageMaxC: "Хранить не выше",
  rx: "Отпуск",
  form: "Форма",
  mnn: "Действующее вещество",
};
const fieldText = (k, v) => k === "afterOpenDays" ? `${v} ${X.plural(v, "день", "дня", "дней").split(" ")[1]}`
  : k === "storageMaxC" ? `${v} °C`
    : k === "rx" ? (v ? "по рецепту" : "без рецепта")
      : String(v);

/** Снимок → черновик полей → экран подтверждения. Применяет только то, что человек подтвердил. */
async function readLeafletPhoto(form, onApply) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  // capture подсказывает телефону открыть камеру сразу, но выбор из галереи
  // остаётся: вкладыш могли сфотографировать заранее.
  input.capture = "environment";
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
    toast("Читаю вкладыш…");
    let r;
    try { r = await api.readLeaflet(image, form.name.value.trim()); }
    catch (e) { return toast("Снимок не прочитался. Снимите ближе и при свете или введите руками"); }
    if (!r) return toast("Снимок не подошёл — нужен кадр страницы инструкции");
    showLeafletDraft(r, form, onApply);
  };
  input.click();
}

function showLeafletDraft(r, form, onApply) {
  const got = Object.entries(r.fields || {});
  openSheet(`
    <div class="pack-sheet">
      <h2>Что удалось прочитать</h2>
      ${r.mismatch ? `<p class="warn">На снимке написано «${esc(r.nameOnPhoto)}», а вы вводите «${esc(form.name.value.trim())}». Та ли это коробка?</p>` : ""}
      ${got.length ? `
        <p class="hint">Сверьте с бумагой в руке — распознавание может ошибиться в цифре, и по цитате это не видно.</p>
        <ul class="draft">${got.map(([k, v]) => `<li>
          <label class="check"><input type="checkbox" data-take="${k}" checked>
            <span><b>${esc(FIELD_LABEL[k] || k)}:</b> ${esc(fieldText(k, v))}</span></label>
          ${r.quotes && r.quotes[k] ? `<q>${esc(r.quotes[k])}</q>` : `<q class="noq">цитаты нет</q>`}
        </li>`).join("")}</ul>`
        : `<p class="empty">Ничего прочитать не удалось. Бывает: мятый вкладыш, тень, слишком мелкий текст. Можно снять ещё раз или ввести руками.</p>`}
      ${(r.rejected || []).length ? `<p class="hint">Отброшено как неподтверждённое: ${r.rejected.map(x => esc(FIELD_LABEL[x.key] || x.key)).join(", ")}.</p>` : ""}
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Отмена</button>
        ${got.length ? `<button class="btn" type="button" id="takeDraft">Подставить</button>` : ""}
      </div>
    </div>`, () => {
    const btn = $("#takeDraft");
    if (!btn) return;
    btn.onclick = () => {
      const taken = {};
      for (const c of host.querySelectorAll("[data-take]")) if (c.checked) taken[c.dataset.take] = r.fields[c.dataset.take];
      closeSheet();
      onApply(taken, r.quotes || {});
    };
  });
}

/* ---------- сканирование ---------- */

async function startScan() {
  const hit = await openScanner(host);
  if (!hit) return;                      // закрыли видоискатель
  await afterScan(hit.raw, hit.format);
}

/**
 * Что делать с распознанным кодом. Три исхода, и у каждого свой экран:
 * эту коробку уже заводили → открываем её; код знаком → форма заполнена;
 * код новый → спрашиваем название один раз.
 */
async function afterScan(raw, format) {
  const code = GS1.parse(raw, format);
  if (!code.ok) return toast(GS1.WHY[code.reason] || "код не распознан");

  let info = { item: null, source: null, existingPack: null, gtin: code.gtin };
  try { info = await api.lookup({ gtin: code.gtin, serial: code.serial }) || info; }
  catch (e) { console.error("Поиск по коду не удался:", e); }

  if (info.existingPack) {
    // Серийный номер уникален для физической коробки: это та же самая.
    await refresh();
    toast("Эта коробка уже в аптечке");
    return openPack(info.existingPack.id, info.existingPack);
  }
  openAdd({
    gtin: code.gtin,
    serial: code.serial,
    expiresOn: code.expiresOn,            // (17) бывает на импорте, у лекарств РФ — нет
    item: info.item,
    known: !!info.item,
  });
}

/** fallback — упаковка, пришедшая не из списка (например, найденная по коду). */
async function openPack(id, fallback) {
  const p = state.packs.find(x => x.id === id) || fallback;
  if (!p) return;
  const i = p.item;
  openSheet(`
    <div class="pack-sheet">
      <h2>${esc(i.name)}</h2>
      <p class="pack-sub">${esc([i.dose, i.form].filter(Boolean).join(", ")) || "&nbsp;"}</p>
      <dl class="facts">
        <div><dt>Срок</dt><dd class="st-${p.expiry.status}">${esc(X.human(p.expiry))}${p.expiry.source === "opened" ? " <small>— считается от вскрытия</small>" : ""}</dd></div>
        <div><dt>Осталось</dt><dd>${fmtQty(p.qty, i.unit)}</dd></div>
        <div><dt>Где</dt><dd>${esc(state.places.find(x => x.id === p.placeId)?.name || "не указано")}</dd></div>
        ${p.openedOn ? `<div><dt>Вскрыто</dt><dd>${esc(humanDate(p.openedOn))}</dd></div>` : ""}
        ${i.mnn ? `<div><dt>Вещество</dt><dd>${esc(i.mnn)}</dd></div>` : ""}
        ${i.storageMaxC !== null && i.storageMaxC !== undefined ? `<div><dt>Хранить</dt><dd>не выше ${i.storageMaxC} °C</dd></div>` : ""}
        ${p.note ? `<div><dt>Заметка</dt><dd>${esc(p.note)}</dd></div>` : ""}
      </dl>
      ${i.leafletUrl ? `<p><a href="${esc(i.leafletUrl)}" target="_blank" rel="noopener">Официальная инструкция</a></p>` : ""}
      <div class="grid-actions">
        ${p.status === "have" ? `
          <button class="btn" data-act="take">Взять</button>
          ${p.openedOn ? "" : `<button class="btn ghost" data-act="open">Вскрыть</button>`}
          <button class="btn ghost" data-act="move">Переложить</button>
          <button class="btn ghost" data-act="edit">Править</button>
          <button class="btn ghost danger" data-act="discard">Выбросить</button>
        ` : `<button class="btn" data-act="restore">Вернуть в запас</button>
             <button class="btn ghost danger" data-act="delete">Удалить запись</button>`}
      </div>
      <p class="sheet-close"><button class="link" data-close>Закрыть</button></p>
    </div>`, () => {
    for (const b of host.querySelectorAll("[data-act]")) b.onclick = () => packAction(p, b.dataset.act);
  });
}

async function packAction(p, act) {
  if (act === "take") {
    const raw = await askSheet({
      title: "Сколько взяли?",
      hint: `Осталось ${fmtQty(p.qty, p.item.unit)}`,
      field: { label: `Сколько, ${p.item.unit || "штук"}`, value: "1", numeric: true, maxlength: 8 },
      confirm: "Взять",
    });
    if (raw === null) return;
    const qty = Number(String(raw).replace(",", "."));
    if (!(qty > 0)) return toast("Нужно число больше нуля");
    await apply(p, { action: "take", qty }, `Взяли ${fmtQty(qty, p.item.unit)}`);
  } else if (act === "open") {
    await apply(p, { action: "open" }, "Отмечено как вскрытое");
  } else if (act === "move") {
    const chosen = await askSheet({
      title: "Куда переложить?",
      field: {
        label: "Место", value: p.placeId || "",
        options: [{ value: "", label: "— без места —" }, ...state.places.map(pl => ({ value: pl.id, label: pl.name }))],
      },
      confirm: "Переложить",
    });
    if (chosen === null) return;
    await apply(p, { action: "move", placeId: chosen || null }, "Переложено");
  } else if (act === "discard") {
    await apply(p, { action: "discard" }, "Выброшено");
  } else if (act === "restore") {
    await apply(p, { action: "restore" }, "Вернули в запас");
  } else if (act === "edit") {
    openEdit(p);
  } else if (act === "delete") {
    if (!await askSheet({ title: "Удалить запись совсем?",
      hint: "Журнал по ней тоже исчезнет.", confirm: "Удалить", danger: true })) return;
    await api.deletePack(p.id);
    closeSheet();
    toast("Запись удалена");
    render();
  }
}

async function apply(p, body, message) {
  const r = await api.patchPack(p.id, body);
  closeSheet();
  if (!r) return toast("Не вышло. Обновите страницу и повторите");
  toast(message, { undo: true });
  render();
}

function openEdit(p) {
  const i = p.item;
  openSheet(`
    <form id="editForm">
      <h2>Править: ${esc(i.name)}</h2>
      <label>Срок годности${monthPicker(p.expiresOn)}</label>
      <label>Осталось<input name="qty" autocomplete="off" inputmode="decimal" value="${esc(p.qty)}"></label>
      <label>Где лежит<select name="placeId">
        <option value="">— не указано —</option>
        ${state.places.map(pl => `<option value="${pl.id}"${pl.id === p.placeId ? " selected" : ""}>${esc(pl.name)}</option>`).join("")}
      </select></label>
      <label>Заметка<input name="note" autocomplete="off" maxlength="300" value="${esc(p.note || "")}"></label>
      ${p.openedOn ? `<label class="check"><input type="checkbox" name="unopen"> Вскрытие отмечено по ошибке</label>` : ""}
      <label>Годен после вскрытия, дней<input name="afterOpenDays" autocomplete="off" inputmode="numeric" value="${esc(i.afterOpenDays ?? "")}">
        <small>Свойство препарата, а не этой упаковки: изменится у всех упаковок «${esc(i.name)}».</small></label>
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Отмена</button>
        <button class="btn" type="submit">Сохранить</button>
      </div>
    </form>`, () => {
    $("#editForm").onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const v = k => (f.get(k) || "").toString().trim();
      const after = v("afterOpenDays");
      if (String(i.afterOpenDays ?? "") !== after) await api.updateItem(i.id, { ...i, afterOpenDays: after || null });
      const body = {
        action: "edit",
        expiresOn: v("expMonth") && v("expYear") ? `${v("expYear")}-${v("expMonth")}` : null,
        qty: v("qty"), note: v("note"), placeId: v("placeId") || null,
      };
      if (f.get("unopen")) body.openedOn = null;
      await api.patchPack(p.id, body);
      closeSheet();
      toast("Сохранено");
      render();
    };
  });
}

/* ---------- 5. тосты с отменой ---------- */

let toastTimer = null;
function toast(text, { undo = false } = {}) {
  const box = $("#toastHost");
  box.innerHTML = `<div class="toast">${esc(text)}${undo ? ` <button class="link" id="undoBtn">Отменить</button>` : ""}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.innerHTML = ""; }, undo ? 7000 : 3000);
  const u = $("#undoBtn");
  if (u) u.onclick = async () => {
    box.innerHTML = "";
    const r = await api.undo();
    toast(r ? "Отменено" : "Отменять нечего");
    render();
  };
}

/* ---------- запуск ---------- */

$("#addBtn").onclick = () => openAdd();
$("#scanBtn").onclick = () => startScan();

(async function start() {
  await loadConfig();
  await initAuth();
  if (!api) api = local;
  // Кнопка сканирования появляется, только если есть чем сканировать:
  // нет камеры или страница не по https — предлагать нечего.
  if (canScan()) {
    $("#scanBtn").hidden = false;
    $("#addBtn").classList.add("with-scan");
  }
  await render();
  // Ярлык «Сканировать» с домашнего экрана (manifest, shortcuts) открывает
  // приложение сразу с камерой. Адрес после этого чистим, чтобы перезагрузка
  // страницы не включала камеру снова.
  if (new URLSearchParams(location.search).get("scan") === "1") {
    history.replaceState(null, "", location.pathname);
    if (canScan()) startScan();
  }
  if ("serviceWorker" in navigator) {
    // Регистрируем после первой отрисовки: установка воркера не должна
    // соревноваться за сеть с первым экраном.
    navigator.serviceWorker.register("/sw.js").catch(() => { /* не критично */ });
  }
})();
