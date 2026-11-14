"use strict";
/* Гостевая аптечка: всё то же самое, но в localStorage.
 *
 * Зачем вообще: сервис должен приносить пользу до того, как человек решит
 * заводить аккаунт — как у Brain и PDD. Открыл, внёс три упаковки, увидел
 * подсветку. Вход добавляет общий дом, напоминания и синхронизацию.
 *
 * Интерфейс намеренно совпадает с remote.js — методы, аргументы и форма
 * ответа. Экраны не знают, вошёл человек или нет, и не обрастают ветками
 * «если гость». Правила сроков берутся из общего expiry.js, поэтому
 * подсветка у гостя и у вошедшего не может разъехаться.
 *
 * При первом входе всё это уезжает на сервер (exportAll → /api/import-guest)
 * и стирается отсюда.
 */
const KEY = "bh-zapas-v1";
const X = globalThis.ZapasExpiry;

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  }));

const today = () => new Date().toLocaleDateString("sv-SE");

function empty() {
  return { v: 1, places: [{ id: uid(), parentId: null, name: "Аптечка", sort: 1 }], items: [], packs: [], events: [] };
}
function read() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    return d && d.v === 1 ? { ...empty(), ...d } : empty();
  } catch { return empty(); }
}
function write(d) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); }
  catch { /* приватный режим или квота: вести учёт это не мешает, переживёт ли он визит — нет */ }
}

const norm = s => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

function readItemFields(b) {
  const name = norm(b?.name);
  if (!name) return null;
  const n = (v, d = null) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    name, kind: b?.kind || "drug",
    mnn: norm(b?.mnn) || null, form: norm(b?.form) || null, dose: norm(b?.dose) || null,
    packQty: n(b?.packQty), unit: norm(b?.unit) || null,
    afterOpenDays: n(b?.afterOpenDays), storageMaxC: n(b?.storageMaxC),
    rx: b?.rx === null || b?.rx === undefined ? null : !!b.rx,
    leafletUrl: /^https:\/\//.test(b?.leafletUrl || "") ? b.leafletUrl : null,
    lowAt: n(b?.lowAt), gtin: /^\d{8,14}$/.test(b?.gtin || "") ? b.gtin : null, source: "manual",
  };
}

export function createLocalStore() {
  const ok = v => Promise.resolve(v);

  const decorate = (d, p) => {
    const item = d.items.find(i => i.id === p.itemId);
    return {
      ...p, item,
      expiry: X.effective(p, item || {}, today()),
      low: item && item.lowAt != null && p.qty <= item.lowAt,
    };
  };

  function summaryOf(d) {
    const s = { total: 0, expired: 0, urgent: 0, soon: 0, ok: 0, unknown: 0, low: 0, opened: 0 };
    for (const p of d.packs) {
      if (p.status !== "have") continue;
      const v = decorate(d, p);
      if (!v.item) continue;
      s.total++; s[v.expiry.status]++;
      if (v.low) s.low++;
      if (p.openedOn) s.opened++;
    }
    return s;
  }

  const api = {
    guest: true,

    me() {
      const d = read();
      write(d); // первый вызов создаёт «Аптечку»
      return ok({
        user: null,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow",
        household: { id: "guest", name: "Мой дом", role: "owner" },
        households: [],
        places: api._places(d),
        summary: summaryOf(d),
      });
    },

    _places(d) {
      const counts = new Map();
      for (const p of d.packs) if (p.status === "have") counts.set(p.placeId, (counts.get(p.placeId) || 0) + 1);
      return d.places.map(p => ({ ...p, packs: counts.get(p.id) || 0 }));
    },

    places() { return ok(api._places(read())); },

    addPlace({ name }) {
      const d = read();
      const n = norm(name);
      if (!n) return ok(null);
      const place = { id: uid(), parentId: null, name: n, sort: d.places.length + 1 };
      d.places.push(place); write(d);
      return ok({ ...place, packs: 0 });
    },

    renamePlace(id, name) {
      const d = read();
      const pl = d.places.find(p => p.id === id);
      const n = norm(name);
      if (!pl || !n) return ok(null);
      pl.name = n; write(d);
      return ok({ id, name: n });
    },

    deletePlace(id) {
      const d = read();
      d.places = d.places.filter(p => p.id !== id);
      for (const p of d.packs) if (p.placeId === id) p.placeId = null;
      write(d);
      return ok({ deleted: true });
    },

    items() { return ok(read().items); },

    addItem(body) {
      const d = read();
      const r = api._addItem(d, body);
      write(d);
      return ok(r);
    },

    _addItem(d, body) {
      const f = readItemFields(body);
      if (!f) return null;
      const have = d.items.find(i => i.name.toLowerCase() === f.name.toLowerCase() && (i.dose || "") === (f.dose || ""));
      if (have) return have;
      const item = { id: uid(), ...f };
      d.items.push(item);
      return item;
    },

    updateItem(id, body) {
      const d = read();
      const i = d.items.findIndex(x => x.id === id);
      if (i < 0) return ok(null);
      const f = readItemFields({ ...d.items[i], ...body });
      if (!f) return ok(null);
      d.items[i] = { ...d.items[i], ...f };
      write(d);
      return ok(d.items[i]);
    },

    packs({ placeId, status = "have", kind } = {}) {
      const d = read();
      const out = d.packs
        .filter(p => (status === "all" || p.status === status) && (!placeId || p.placeId === placeId))
        .map(p => decorate(d, p))
        .filter(p => p.item && (!kind || p.item.kind === kind));
      out.sort((a, b) => X.compare(a.expiry, b.expiry) || a.item.name.localeCompare(b.item.name, "ru"));
      return ok({ packs: out, summary: summaryOf(d) });
    },

    /** То же, что /api/lookup у сервера: что знаем про код и не добавляли ли коробку. */
    lookup({ gtin, serial } = {}) {
      const d = read();
      const g = typeof gtin === "string" && /^\d{8,14}$/.test(gtin) ? gtin.padStart(14, "0") : null;
      const item = g ? d.items.find(i => i.gtin === g) : null;
      // Справочника сервиса у гостя нет — он часть образа и приезжает с
      // сервером. Для гостя источник знаний только один: его же каталог.
      const dup = serial ? d.packs.find(p => p.serial === String(serial)) : null;
      return ok({
        gtin: g,
        item: item || null,
        source: item ? "household" : null,
        existingPack: dup ? decorate(d, dup) : null,
      });
    },

    addPack(body) {
      const d = read();
      const g = typeof body.gtin === "string" && /^\d{8,14}$/.test(body.gtin) ? body.gtin.padStart(14, "0") : null;
      const serial = /^[\x20-\x7e]{4,60}$/.test(body.serial || "") ? body.serial : null;
      // Ту же коробку второй раз не заводим — открываем существующую запись.
      if (serial) {
        const dup = d.packs.find(p => p.serial === serial);
        if (dup) return ok({ ...decorate(d, dup), duplicate: true });
      }
      let item = body.itemId ? d.items.find(i => i.id === body.itemId) : null;
      if (!item && g) item = d.items.find(i => i.gtin === g);
      if (!item) item = api._addItem(d, { ...(body.item || body), gtin: g });
      if (!item) return ok(null);
      const pack = {
        id: uid(), itemId: item.id, placeId: body.placeId || null,
        expiresOn: X.isMonth(body.expiresOn) ? body.expiresOn : null,
        openedOn: X.isDay(body.openedOn) ? body.openedOn : null,
        qty: Number.isFinite(Number(body.qty)) ? Number(body.qty) : (item.packQty ?? 1),
        serial, status: "have", note: norm(body.note) || null,
        addedBy: "guest", addedAt: Date.now(),
      };
      d.packs.push(pack);
      d.events.push({ id: uid(), packId: pack.id, kind: "add", at: Date.now(), before: null });
      write(d);
      return ok(decorate(d, pack));
    },

    patchPack(id, body) {
      const d = read();
      const p = d.packs.find(x => x.id === id);
      if (!p) return ok(null);
      const item = d.items.find(i => i.id === p.itemId) || {};
      const before = { placeId: p.placeId, expiresOn: p.expiresOn, openedOn: p.openedOn, qty: p.qty, status: p.status, note: p.note };
      const a = body.action;

      if (a === "take") {
        const n = Number(body.qty) > 0 ? Number(body.qty) : 1;
        p.qty = Math.max(0, Math.round((p.qty - n) * 1000) / 1000);
        if (!p.openedOn) p.openedOn = today();
        if (p.qty <= 0) p.status = "used";
      } else if (a === "open") p.openedOn = p.openedOn || today();
      else if (a === "unopen") p.openedOn = null;
      else if (a === "move") p.placeId = body.placeId || null;
      else if (a === "discard") p.status = "discarded";
      else if (a === "restore") { p.status = "have"; if (p.qty <= 0) p.qty = item.packQty ?? 1; }
      else if (a === "edit") {
        if (body.expiresOn !== undefined) p.expiresOn = X.isMonth(body.expiresOn) ? body.expiresOn : null;
        if (body.openedOn !== undefined) p.openedOn = X.isDay(body.openedOn) ? body.openedOn : null;
        if (body.qty !== undefined && Number.isFinite(Number(body.qty))) {
          p.qty = Number(body.qty);
          if (p.qty > 0 && p.status === "used") p.status = "have";
        }
        if (body.note !== undefined) p.note = norm(body.note) || null;
        if (body.placeId !== undefined) p.placeId = body.placeId || null;
      } else return ok(null);

      d.events.push({ id: uid(), packId: p.id, kind: a, at: Date.now(), before });
      write(d);
      return ok(decorate(d, p));
    },

    deletePack(id) {
      const d = read();
      d.packs = d.packs.filter(p => p.id !== id);
      d.events = d.events.filter(e => e.packId !== id);
      write(d);
      return ok({ deleted: true });
    },

    undo() {
      const d = read();
      for (let i = d.events.length - 1; i >= 0; i--) {
        const e = d.events[i];
        if (!e.before) continue;
        const p = d.packs.find(x => x.id === e.packId);
        if (!p) continue;
        Object.assign(p, e.before);
        d.events.splice(i, 1);
        write(d);
        return ok({ undone: e.kind, pack: decorate(d, p) });
      }
      return ok(null);
    },

    history(packId) {
      const d = read();
      return ok(d.events.filter(e => e.packId === packId).slice(-50).reverse()
        .map(e => ({ kind: e.kind, qty: e.qty ?? null, at: e.at, by: "guest" })));
    },

    shopping() {
      const d = read();
      const live = new Map();
      for (const p of d.packs) {
        const rec = live.get(p.itemId) || { have: 0, usable: 0, qty: 0 };
        if (p.status === "have") {
          rec.have++; rec.qty += p.qty;
          if (decorate(d, p).expiry.status !== "expired") rec.usable++;
        }
        live.set(p.itemId, rec);
      }
      const out = [];
      for (const [itemId, rec] of live) {
        const item = d.items.find(i => i.id === itemId);
        if (!item) continue;
        if (!rec.have) out.push({ item, reason: "out" });
        else if (!rec.usable) out.push({ item, reason: "expired" });
        else if (item.lowAt != null && rec.qty <= item.lowAt) out.push({ item, reason: "low", qty: rec.qty });
      }
      const order = ["out", "expired", "low"];
      out.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason) || a.item.name.localeCompare(b.item.name, "ru"));
      return ok(out);
    },

    /** Для переноса на сервер при первом входе. */
    exportAll() {
      const d = read();
      return { places: d.places, items: d.items, packs: d.packs };
    },
    isEmpty() {
      const d = read();
      return !d.packs.length && !d.items.length;
    },
    clear() { try { localStorage.removeItem(KEY); } catch { /* нечего чистить */ } },
  };

  return api;
}
