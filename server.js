#!/usr/bin/env node
"use strict";
/**
 * «Что у нас есть?» — учёт домашних запасов, zapas.burninghouse.ru.
 * План целиком — ARCHITECTURE.md.
 *
 * Сервер отдаёт index.html на все маршруты клиентского роутера (History API:
 * /mesta, /dokupit), статику из assets/ и API вошедшего пользователя: дома,
 * места, позиции, упаковки (/api/me, /api/packs...). Вся логика — в
 * lib/store.js, здесь только разбор запросов.
 *
 * Вход необязателен, как у Brain и PDD: гость ведёт аптечку в localStorage
 * (assets/local.js), и при первом входе она уезжает на сервер. Если
 * auth-client не поднялся, /api/config отдаёт authBase: null и фронт просто
 * не предлагает войти.
 *
 * Сервис ведёт УЧЁТ и ничего не советует о применении — см. ARCHITECTURE.md,
 * «Граница». Поэтому здесь нет и не должно появиться ни показаний, ни
 * дозировок: только то, что написано на упаковке, и ссылка на инструкцию.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 8799;
const ROOT = __dirname;
const SITE_URL = "https://zapas.burninghouse.ru";
const SERVICE_NAME = "Что у нас есть?";
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");

// ---------- вход и хранилище ----------

// auth-client.js — копия Auth/client/auth-client.js (см. Auth/INTEGRATION.md):
// подпись access-токена проверяется локально, в auth на каждый запрос не ходим.
const AUTH_ISSUER = (process.env.AUTH_ISSUER || "https://auth.burninghouse.ru").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "zapas";
let auth = null;
try {
  auth = require("./auth-client")({ issuer: AUTH_ISSUER, audience: AUTH_CLIENT_ID, jwksUrl: process.env.AUTH_JWKS_URL });
  auth.warmup();
} catch (e) {
  console.error("auth-client не поднялся — вход будет недоступен:", e.message);
}

/* Справочник по кодам с упаковок — часть образа, а не данные (bank/README.md).
   Читается один раз при старте: в рантайме сеть не нужна, обновление
   справочника = новый образ. Файла нет или он битый — работаем без него. */
const readBank = (file, what) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "bank", file), "utf8")); }
  catch (e) { console.warn(`bank/${file} не прочитан — ${what}:`, e.message); return {}; }
};
const BANK = readBank("gtin.json", "коды будут спрашивать название");
const LEAFLETS = readBank("leaflets.json", "поля из инструкций подставляться не будут");

const store = require("./lib/store")({ dataDir: DATA_DIR, bank: BANK, leaflets: LEAFLETS });
const { checkAdminKey, createAdminLog } = require("./admin-internal");
const adminLog = createAdminLog(store.db);

// Server-to-server с Auth (/internal/*) — тем же ключом, что у Admin.
const AUTH_INTERNAL_URL = (process.env.AUTH_INTERNAL_URL || AUTH_ISSUER).replace(/\/+$/, "");
const ADMIN_INTERNAL_KEY = process.env.ADMIN_INTERNAL_KEY || "";
// Куда ведут ссылки в уведомлениях. Локально — http://localhost:8799.
const PUBLIC_URL = (process.env.PUBLIC_URL || SITE_URL).replace(/\/+$/, "");

const { createWebPush } = require("./lib/webpush");
const webpush = createWebPush({ dataDir: DATA_DIR, subject: process.env.VAPID_SUBJECT || SITE_URL });

/** Запрос к Auth: по токену человека или по общему ключу (internal). */
async function authCall(p, { bearer, method = "GET", body, internal = false } = {}) {
  const res = await fetch((internal ? AUTH_INTERNAL_URL : AUTH_ISSUER) + p, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(internal ? { "X-Admin-Key": ADMIN_INTERNAL_KEY } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw Object.assign(new Error(`${method} ${p}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}

/* Уведомление на устройства человека. Отозванные подписки (404/410) стираем:
   иначе список подписок растёт мусором после каждой переустановки браузера. */
async function pushTo(userId, message) {
  let sent = 0;
  for (const sub of store.pushSubs(userId)) {
    try {
      const r = await webpush.send(sub, message);
      if (r.gone) store.dropPushSub(sub.endpoint);
      else sent++;
    } catch (e) { console.error("Push не ушёл:", e.message); }
  }
  return sent;
}

/* Событие в кабинет BurningHouse. С токеном человека, когда он сам нажал
   кнопку; по общему ключу — когда шлёт планировщик и токена нет и быть не
   может. Сбой не роняет основное действие: уведомление не главное. */
async function notify(userId, { type, title, body, url, bearer }) {
  const payload = { userId, type, title, body: body || undefined, url: url || PUBLIC_URL + "/" };
  try {
    if (bearer) await authCall("/api/notifications", { bearer, method: "POST", body: payload });
    else if (ADMIN_INTERNAL_KEY) await authCall("/internal/notifications", { internal: true, method: "POST", body: { ...payload, source: AUTH_CLIENT_ID } });
  } catch (e) { console.error("Уведомление не ушло:", type, e.message); }
  await pushTo(userId, { title, body: body || "", url: payload.url, tag: type });
}

/* Аккаунт удалили в Auth — сервисам об этом не сообщают, поэтому раз в 6 часов
   сверяемся со списком и стираем данные тех, кого нет дольше суток. Пустой или
   неудачный ответ — ничего не трогаем: пустой список означал бы «удалить всё». */
async function purgeDeletedAccounts() {
  if (!ADMIN_INTERNAL_KEY) return;
  const res = await fetch(AUTH_INTERNAL_URL + "/internal/users", {
    headers: { "X-Admin-Key": ADMIN_INTERNAL_KEY }, signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { users } = await res.json();
  if (!Array.isArray(users) || !users.length) return console.error("Уборка: Auth вернул пустой список — пропускаем");
  const r = store.purgeMissing(new Set(users.map(u => u.id)));
  if (r.purged) adminLog.info(`Уборка: стёрты данные ${r.purged} удалённых в Auth аккаунтов`);
}
setInterval(() => purgeDeletedAccounts().catch(e => console.error("Уборка:", e.message)), 6 * 3600 * 1000).unref();
setTimeout(() => purgeDeletedAccounts().catch(e => console.error("Уборка:", e.message)), 60 * 1000).unref();

/* ---------- напоминания ---------- */

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m100 >= 11 && m100 <= 14 ? many : m10 === 1 ? one : m10 >= 2 && m10 <= 4 ? few : many}`;
};
/** Текст одной дневной сводки. Не список из двадцати строк, а одна фраза. */
function reminderText(items) {
  const parts = [];
  if (items.expired.length) parts.push(`${plural(items.expired.length, "упаковка истекла", "упаковки истекли", "упаковок истекли")}`);
  if (items.openExpiring.length) parts.push(`${plural(items.openExpiring.length, "вскрытая заканчивается", "вскрытые заканчиваются", "вскрытых заканчиваются")}`);
  if (items.expiring.length) parts.push(`${plural(items.expiring.length, "истекает в этом месяце", "истекают в этом месяце", "истекают в этом месяце")}`);
  if (items.low.length) parts.push(`${plural(items.low.length, "заканчивается", "заканчиваются", "заканчиваются")}`);
  const names = [...items.expired, ...items.openExpiring, ...items.expiring, ...items.low]
    .slice(0, 4).map(x => x.name);
  return {
    title: parts.join(", ").replace(/^./, c => c.toUpperCase()),
    body: names.join(", ") + (names.length < 4 ? "" : " и другое"),
  };
}

/* Раз в пять минут смотрим, у кого по местному времени наступило выбранное
   время и сегодня ещё не рассылали. Пачкой за день, а не по упаковке. */
async function sendReminders() {
  for (const due of store.dueReminders()) {
    if (due.total) {
      const { title, body } = reminderText(due.items);
      await notify(due.userId, { type: "zapas.expiring", title, body });
    }
    // День отмечаем в любом случае: иначе пустую проверку будем гонять
    // каждые пять минут до полуночи.
    store.markNotified(due.userId, due.day, due.items);
  }
}
setInterval(() => sendReminders().catch(e => console.error("Напоминания:", e.message)), 5 * 60 * 1000).unref();
setTimeout(() => sendReminders().catch(e => console.error("Напоминания:", e.message)), 20 * 1000).unref();
if (!ADMIN_INTERNAL_KEY) console.log("ADMIN_INTERNAL_KEY не задан — /internal/* выключены, уборка удалённых аккаунтов тоже.");

// ---------- маршруты ----------

/* Домашняя аптечка — личные данные, в поиске ей делать нечего: noindex на всех
   страницах, без исключений и без переменной «включить». Заголовки всё равно
   свои: они видны во вкладках и в истории браузера. */
const ROUTES = {
  "": { title: SERVICE_NAME, description: "Домашняя аптечка и запасы: что есть, когда истекает, где лежит." },
  mesta: { title: `Места — ${SERVICE_NAME}`, description: "Где что лежит: аптечка, дорожная сумка, дача." },
  dokupit: { title: `Докупить — ${SERVICE_NAME}`, description: "Что кончилось, истекло или заканчивается." },
  istorija: { title: `История — ${SERVICE_NAME}`, description: "Что брали, вскрывали и выбрасывали." },
  dom: { title: `Дом — ${SERVICE_NAME}`, description: "Кто в доме, приглашения и напоминания." },
  privacy: { title: `Политика конфиденциальности — ${SERVICE_NAME}`, description: "Какие данные хранит сервис и как их удалить." },
  "delete-account": { title: `Удаление данных — ${SERVICE_NAME}`, description: "Как удалить свою аптечку и данные." },
};
const isAppRoute = rel => Object.prototype.hasOwnProperty.call(ROUTES, rel)
  || /^upakovka\/[0-9a-f-]{36}$/.test(rel) || /^mesto\/[0-9a-f-]{36}$/.test(rel);

const escapeAttr = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Подмена по месту вместо шаблонизатора, как у Brain: страница одна, полей мало. */
function injectSeo(html, rel) {
  const seo = ROUTES[rel] || ROUTES[""];
  const t = escapeAttr(seo.title), d = escapeAttr(seo.description);
  return html
    .replace(/<title>.*?<\/title>/, () => `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${d}">`);
}

// ---------- HTTP ----------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // Без этой строки распознаватель уезжал как application/octet-stream, и
  // ломались сразу две вещи: nginx не жал его (gzip работает по типу — 925 КБ
  // вместо 409 на телефон) и браузер не компилировал wasm на лету, откатываясь
  // на медленный путь через ArrayBuffer.
  ".wasm": "application/wasm",
};

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", c => {
      data += c;
      if (data.length > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

const UUID = "[0-9a-f-]{36}";

async function handleApi(req, res, p) {
  const method = req.method;
  const url = new URL(req.url, "http://localhost");

  if (p === "/api/config" && method === "GET") {
    return json(res, 200, {
      // null — вход сейчас недоступен, фронт не покажет кнопку «Войти».
      authBase: auth ? AUTH_ISSUER : null,
      clientId: AUTH_CLIENT_ID,
      kinds: store.KINDS,
      units: store.UNITS,
    });
  }

  /* Что известно из официальной инструкции по названию. Без входа: гость
     ведёт аптечку наравне с вошедшим, и подсказка «годен 28 дней после
     вскрытия» нужна ему ровно так же. Личного тут ничего нет — это
     содержимое bank/leaflets.json, одинаковое для всех. */
  if (p === "/api/leaflet" && method === "GET") {
    const leaf = store.leafletFor(url.searchParams.get("name") || "");
    res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "public, max-age=3600" });
    return res.end(JSON.stringify({ leaflet: leaf }));
  }

  // ---- server-to-server для Admin (не SSO, общий ключ) ----
  if (p.startsWith("/internal/")) {
    if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
    if (p === "/internal/stats" && method === "GET") return json(res, 200, { ok: true, ...store.stats() });
    if (p === "/internal/logs" && method === "GET") {
      const since = Number(url.searchParams.get("since")) || undefined;
      return json(res, 200, { logs: adminLog.recent({ since, limit: Number(url.searchParams.get("limit")) || 200 }) });
    }
    return json(res, 404, { error: "not_found" });
  }

  // ---- всё ниже — только для вошедших ----
  if (!auth) return json(res, 503, { error: "auth_unavailable" });
  const user = await auth.userFromRequest(req);
  if (!user) return json(res, 401, { error: "unauthorized" });

  // Пояс приходит с каждым запросом: «сегодня» считает сервер, и считать его
  // надо там, где человек сейчас, а не там, где стоит контейнер.
  const tz = url.searchParams.get("tz") || req.headers["x-tz"] || null;
  const hh = () => store.ensureHousehold(user.id, tz).household.id;
  const need = v => v === null || v === undefined
    ? json(res, 400, { error: "bad_request" })
    : json(res, 200, v);

  const who = user.name || user.username;

  if (p === "/api/me" && method === "GET") {
    return json(res, 200, { user: { id: user.id, name: who }, ...store.me(user.id, tz, who) });
  }
  if (p === "/api/me/notify" && method === "PUT") return json(res, 200, store.setNotify(user.id, await readJson(req), tz));
  if (p === "/api/me/household" && method === "PUT") {
    const b = await readJson(req);
    return need(b?.id ? store.switchHousehold(user.id, String(b.id)) : null);
  }

  /* ---------- дом ---------- */

  if (p === "/api/household" && method === "GET") {
    const hid = hh();
    return json(res, 200, {
      household: store.me(user.id, tz, who).household,
      members: store.members(user.id, hid),
      invites: { incoming: store.incomingInvites(user.id), outgoing: store.outgoingInvites(user.id, hid) },
    });
  }
  if (p === "/api/household" && method === "PATCH") return need(store.renameHousehold(user.id, hh(), (await readJson(req)).name));
  if (p === "/api/households" && method === "POST") return need(store.createHousehold(user.id, (await readJson(req)).name, tz));
  if (p === "/api/household/leave" && method === "POST") {
    const r = store.leaveHousehold(user.id, hh());
    return r?.error ? json(res, 409, { error: r.error }) : need(r);
  }

  /* Друзья — из Auth, своего списка контактов сервис не заводит. Помечаем,
     кто уже в доме и кого уже позвали, чтобы интерфейс не предлагал звать
     дважды. */
  if (p === "/api/friends" && method === "GET") {
    const hid = hh();
    let friends = [];
    try { friends = (await authCall("/api/friends", { bearer: auth.bearer(req) })).friends || []; }
    catch (e) { return json(res, 502, { error: "auth_unreachable", message: e.message }); }
    const inHouse = new Set(store.members(user.id, hid).map(m => m.userId));
    const invited = new Set(store.outgoingInvites(user.id, hid).map(i => i.toUser));
    return json(res, 200, {
      friends: friends.map(f => ({
        userId: f.userId, name: f.name || f.username, username: f.username,
        member: inHouse.has(f.userId), invited: invited.has(f.userId),
      })),
    });
  }

  if (p === "/api/household/invite" && method === "POST") {
    const hid = hh();
    const b = await readJson(req);
    // Звать можно только друга: у сервиса нет поиска людей, и появиться он
    // не должен — иначе по user_id можно будет дёргать кого угодно.
    let friends = [];
    try { friends = (await authCall("/api/friends", { bearer: auth.bearer(req) })).friends || []; }
    catch (e) { return json(res, 502, { error: "auth_unreachable" }); }
    const friend = friends.find(f => f.userId === b?.userId);
    if (!friend) return json(res, 403, { error: "not_a_friend" });
    const r = store.invite(user.id, hid, { toUser: friend.userId, fromName: who });
    if (!r) return json(res, 400, { error: "bad_request" });
    if (!r.already && !r.repeated) {
      const hhName = store.me(user.id, tz, who).household.name;
      notify(friend.userId, {
        type: "zapas.invite", title: `${who} зовёт вас в аптечку «${hhName}»`,
        body: "Откройте «Что у нас есть?», чтобы принять", bearer: auth.bearer(req),
      }).catch(() => {});
    }
    return json(res, 200, r);
  }

  let im = /^\/api\/invites\/([0-9a-f-]{36})\/(accept|decline)$/.exec(p);
  if (im && method === "POST") {
    const r = im[2] === "accept" ? store.acceptInvite(user.id, im[1], who) : store.declineInvite(user.id, im[1]);
    if (!r) return json(res, 404, { error: "not_found" });
    if (im[2] === "accept") {
      notify(r.invitedBy, {
        type: "zapas.invite_accepted", title: `${who} теперь в аптечке «${r.joined.name}»`,
        bearer: auth.bearer(req),
      }).catch(() => {});
    }
    return json(res, 200, r);
  }
  im = /^\/api\/invites\/([0-9a-f-]{36})$/.exec(p);
  if (im && method === "DELETE") return need(store.cancelInvite(user.id, hh(), im[1]));

  im = /^\/api\/household\/members\/([0-9a-f-]{36})$/.exec(p);
  if (im && method === "DELETE") {
    const r = store.removeMember(user.id, hh(), im[1]);
    return r?.error ? json(res, 403, { error: r.error }) : need(r);
  }

  /* ---------- уведомления на устройство ---------- */

  if (p === "/api/push/key" && method === "GET") return json(res, 200, { publicKey: webpush.publicKey });
  if (p === "/api/push/subscribe" && method === "POST") return need(store.addPushSub(user.id, (await readJson(req)).subscription));
  if (p === "/api/push/unsubscribe" && method === "POST") return json(res, 200, store.dropPushSub((await readJson(req)).endpoint));
  if (p === "/api/push/test" && method === "POST") {
    const sent = await pushTo(user.id, { title: "Проверка", body: "Уведомления работают", url: PUBLIC_URL + "/" });
    return json(res, 200, { sent });
  }
  // «Удалить мои данные»: аптечка в этом сервисе. Аккаунт BurningHouse
  // остаётся — он в Auth и удаляется в его кабинете.
  if (p === "/api/me" && method === "DELETE") {
    const r = store.deleteUserData(user.id);
    adminLog.info("Данные стёрты по просьбе пользователя", { userId: user.id, households: r.households });
    return json(res, 200, r);
  }

  if (p === "/api/places" && method === "GET") return json(res, 200, { places: store.places(user.id, hh()) });
  if (p === "/api/places" && method === "POST") return need(store.addPlace(user.id, hh(), await readJson(req)));
  let m = new RegExp(`^/api/places/(${UUID})$`).exec(p);
  if (m && method === "PATCH") return need(store.renamePlace(user.id, hh(), m[1], (await readJson(req)).name));
  if (m && method === "DELETE") return need(store.deletePlace(user.id, hh(), m[1]));

  // Сканер: один запрос на весь сценарий — что это за препарат и не
  // добавляли ли мы уже ЭТУ коробку (по серийному номеру).
  if (p === "/api/lookup" && method === "GET") {
    return json(res, 200, store.lookup(user.id, hh(), {
      gtin: url.searchParams.get("gtin"),
      serial: url.searchParams.get("serial"),
    }));
  }

  if (p === "/api/items" && method === "GET") return json(res, 200, { items: store.items(user.id, hh()) });
  if (p === "/api/items" && method === "POST") return need(store.addItem(user.id, hh(), await readJson(req)));
  m = new RegExp(`^/api/items/(${UUID})$`).exec(p);
  if (m && method === "PATCH") return need(store.updateItem(user.id, hh(), m[1], await readJson(req)));

  if (p === "/api/packs" && method === "GET") {
    return json(res, 200, {
      packs: store.packs(user.id, hh(), {
        placeId: url.searchParams.get("place") || undefined,
        status: url.searchParams.get("status") || "have",
        kind: url.searchParams.get("kind") || undefined,
      }),
      summary: store.summary(user.id, hh()),
    });
  }
  if (p === "/api/packs" && method === "POST") return need(store.addPack(user.id, hh(), await readJson(req)));
  m = new RegExp(`^/api/packs/(${UUID})$`).exec(p);
  if (m && method === "PATCH") return need(store.patchPack(user.id, hh(), m[1], await readJson(req)));
  if (m && method === "DELETE") return need(store.deletePack(user.id, hh(), m[1]));
  m = new RegExp(`^/api/packs/(${UUID})/history$`).exec(p);
  if (m && method === "GET") return need(store.history(user.id, hh(), m[1]));

  if (p === "/api/undo" && method === "POST") {
    const r = store.undoLast(user.id, hh());
    return r ? json(res, 200, r) : json(res, 404, { error: "nothing_to_undo" });
  }
  if (p === "/api/shopping" && method === "GET") return json(res, 200, { list: store.shopping(user.id, hh()) });

  if (p === "/api/import-guest" && method === "POST") {
    // Гостевая аптечка целиком: сотни позиций — сотни килобайт.
    const b = await readJson(req, 1024 * 1024);
    return json(res, 200, store.importGuest(user.id, b.data, tz));
  }

  return json(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400).end(); return; }

  if (pathname.startsWith("/api/") || pathname.startsWith("/internal/")) {
    handleApi(req, res, pathname).catch(err => {
      if (err.status) return json(res, err.status, { error: err.code || (err.status === 413 ? "too_large" : "bad_request") });
      adminLog.error("Необработанная ошибка API", { path: pathname, message: err.message });
      if (!res.headersSent) json(res, 500, { error: "internal" });
    });
    return;
  }

  const isHead = req.method === "HEAD";
  if (req.method !== "GET" && !isHead) {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method Not Allowed");
    return;
  }

  const rel = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel === "robots.txt") {
    // Личная аптечка — закрыта целиком и навсегда, переменной «включить» нет.
    res.writeHead(200, { "Content-Type": TYPES[".txt"], "Cache-Control": "public, max-age=3600" });
    res.end(isHead ? undefined : "User-agent: *\nDisallow: /\n");
    return;
  }

  if (rel === "index.html" || isAppRoute(rel)) {
    fs.readFile(path.join(ROOT, "index.html"), "utf8", (err, html) => {
      if (err) { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Internal Error"); return; }
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
      res.end(isHead ? undefined : injectSeo(html, rel === "index.html" ? "" : rel.split("/")[0]));
    });
    return;
  }

  // Белый список: assets/, фавикон и корневые файлы приложения. sw.js обязан
  // отдаваться с корня — иначе его scope не накроет навигацию по "/".
  const ROOT_FILES = ["favicon.svg", "sw.js", "manifest.webmanifest"];
  if (!(rel.startsWith("assets/") || ROOT_FILES.includes(rel)) || rel.split("/").includes("..")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
    return;
  }
  const filePath = path.join(ROOT, rel === "favicon.svg" ? "assets/favicon.svg" : rel);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found"); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      // sw.js браузер обязан перепроверять при каждой навигации — иначе
      // обновления не дойдут до установленного приложения.
      "Cache-Control": rel === "sw.js" ? "no-cache" : "public, max-age=300",
    });
    res.end(isHead ? undefined : data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`${SERVICE_NAME} слушает http://${HOST}:${PORT}`);
});
