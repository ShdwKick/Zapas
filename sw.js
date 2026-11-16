"use strict";
/* Service worker: оболочка в кэше, данные — всегда из сети.
 *
 * Зачем он вообще на первом этапе: сервисом пользуются стоя у шкафчика в
 * ванной, где связь ловит хуже всего. Оболочка должна открываться мгновенно
 * и без сети — иначе человек видит белый экран там, где у него на руках
 * коробка с лекарством.
 *
 * Чего он НЕ делает: не кэширует ответы API. Срок годности и остаток — это
 * то, из-за чего сюда пришли; показать вчерашний остаток как сегодняшний
 * хуже, чем честно сказать «нет сети». Очередь операций без сети — этап 4
 * вместе с общим домом (ARCHITECTURE.md, «Гость и офлайн»).
 *
 * Распознаватель (assets/vendor/zxing/) в SHELL намеренно не входит: это
 * 925 КБ, которые нужны не всем и не сразу. Он попадёт в кэш сам, когда
 * человек первый раз откроет сканер, — обычным правилом для статики ниже.
 */
const VERSION = "zapas-v3";   // v3: в оболочку добавился assets/tags.js
const SHELL = [
  "/",
  "/assets/app.js",
  "/assets/local.js",
  "/assets/expiry.js",
  "/assets/gs1.js",
  "/assets/tags.js",
  "/assets/scan.js",
  "/assets/styles.css",
  "/assets/brand.css",
  "/assets/brand.js",
  "/assets/auth-client.js",
  "/assets/favicon.svg",
  "/assets/icons/icon-192.png",
  "/assets/icons/apple-touch-icon-180.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll падает целиком, если не скачался один файл; по одному — нет.
    await Promise.all(SHELL.map(u => cache.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* Уведомление с сервера. Без этого обработчика подписка бессмысленна:
   сообщение дойдёт до браузера и не покажется никому. */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data && e.data.text() }; }
  const title = d.title || "Что у нас есть?";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/icon-192.png",
    // tag без renotify: напоминание за день одно, и новое должно заменять
    // старое, а не копиться стопкой на экране блокировки.
    tag: d.tag || "zapas",
    data: { url: d.url || "/" },
  }));
});

/* Клик по уведомлению: если вкладка уже открыта — поднимаем её, а не
   плодим вторую. */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) { await c.focus(); return c.navigate(url).catch(() => {}); }
    }
    return self.clients.openWindow(url);
  })());
});

self.addEventListener("fetch", e => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // API мимо кэша: см. шапку файла.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/")) return;

  // Навигация: сеть первой (чтобы свежий index.html доезжал), кэш — запасной
  // вариант. Любой маршрут приложения отдаётся из кэшированного "/".
  if (request.mode === "navigate") {
    e.respondWith((async () => {
      try { return await fetch(request); }
      catch { return (await caches.match("/")) || Response.error(); }
    })());
    return;
  }

  // Статика: кэш первым, сеть следом — и тихо обновляем копию на будущее.
  e.respondWith((async () => {
    const hit = await caches.match(request);
    const fresh = fetch(request).then(res => {
      if (res.ok) caches.open(VERSION).then(c => c.put(request, res.clone()));
      return res;
    }).catch(() => hit || Response.error());
    return hit || fresh;
  })());
});
