"use strict";
/**
 * Хранилище и бизнес-логика этапа 1: дома, места, позиции, упаковки, журнал.
 * server.js только разбирает запросы и зовёт отсюда.
 *
 * Главные решения (подробнее — ARCHITECTURE.md):
 *
 *   - Данные принадлежат ДОМУ, а не человеку. Одиночка — дом из одного; это
 *     не усложнение, а отсутствие самой болезненной миграции в будущем.
 *   - «Что это» (items) и «что лежит» (packs) — разные таблицы. Дома три
 *     упаковки ибупрофена с разными сроками, а препарат один.
 *   - Срок хранится месяцем ('YYYY-MM'), фактический считается в
 *     assets/expiry.js — общий файл с фронтом, чтобы подсветка у гостя и у
 *     вошедшего не разъехалась.
 *   - Журнал (events) пишется на каждое действие. «Выбросил по ошибке»
 *     случается чаще, чем кажется, а список докупить честно строится только
 *     из истории.
 *   - rid у операций: повторная отправка из офлайн-очереди (запрос дошёл, а
 *     ответ потерялся) не создаёт вторую упаковку.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const X = require("../assets/expiry.js");

const DEFAULT_TZ = "Europe/Moscow";
/** Разделы. Этап 1 рисует только аптечку, колонка — чтобы второй раздел не требовал миграции. */
const KINDS = ["drug", "hygiene", "household", "other"];
const UNITS = ["таб", "капс", "мл", "г", "шт", "доза", "пак"];
/** Таблицы, где строки принадлежат человеку напрямую (остальное — дому). */
const USER_TABLES = ["profiles", "household_members"];
const PURGE_GRACE_MS = 24 * 3600 * 1000; // аккаунта нет в Auth дольше суток — стираем
const NAME_MAX = 200;
const PACKS_MAX = 5000;  // упаковок на дом: защита от зациклившейся очереди
const ID = () => crypto.randomUUID();

/* ---------- даты ---------- */

function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return null; }
}
const dayFmt = new Map();
/** 'YYYY-MM-DD' в поясе tz. sv-SE — локаль, которая форматирует ровно так. */
function dayIn(tz, ts = Date.now()) {
  if (!dayFmt.has(tz)) dayFmt.set(tz, new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  return dayFmt.get(tz).format(ts);
}

/* ---------- разбор того, что прислал клиент ---------- */

const str = (v, max = NAME_MAX) => {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s && s.length <= max ? s : null;
};
const num = (v, { min = 0, max = 1e6 } = {}) => {
  // Пустая строка — это «не указано», а не ноль: Number("") === 0, и без
  // этой строчки пустое поле в форме правки обнуляло бы остаток.
  if (v === "" || v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : v;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const intOrNull = (v, max = 3650) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isInteger(n) && n > 0 && n <= max ? n : null;
};
const okRid = rid => rid === undefined || rid === null
  || (typeof rid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(rid));

/* ---------- хранилище ---------- */

module.exports = function createStore({ dataDir, bank, leaflets }) {
  // Справочник по GTIN: часть образа, не данные (bank/gtin.json). Пустой
  // справочник ничего не ломает: незнакомый код просто спросит название
  // один раз, и дальше дом помнит его сам.
  const BANK = bank && typeof bank === "object" ? bank : {};

  /* Что вычитано из официальных инструкций (bank/leaflets.json): индекс по
     названию. Совпадение ТОЧНОЕ, с точностью до регистра, ® и пробелов:
     «Нурофен» и «Нурофен Форте» — разные препараты, и подставить одному
     срок после вскрытия от другого хуже, чем не подставить ничего. */
  const nameKey = s => String(s || "").toLowerCase().replace(/[®™]/g, "").replace(/\s+/g, " ").trim();
  const LEAFLETS = new Map();
  for (const [reg, v] of Object.entries(leaflets && typeof leaflets === "object" ? leaflets : {})) {
    if (v && v.name) LEAFLETS.set(nameKey(v.name), { ...v, regNumber: v.regNumber || reg });
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "zapas.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id        TEXT PRIMARY KEY,
      tz             TEXT NOT NULL,
      active_hh      TEXT,
      guest_imported INTEGER NOT NULL DEFAULT 0,
      -- Когда напоминать, по местному времени. Одно время в сутки, а не
      -- уведомление на каждую упаковку: см. «Напоминания» в ARCHITECTURE.md.
      remind_at      TEXT NOT NULL DEFAULT '10:00',
      notify_json    TEXT,          -- какие поводы включены
      notified_day   TEXT,          -- 'YYYY-MM-DD' последней рассылки
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    -- Дом: кому принадлежит аптечка. Участники приглашаются из списка
    -- друзей Auth — своего списка контактов сервис не заводит.
    CREATE TABLE IF NOT EXISTS households (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS household_members (
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL,
      role         TEXT NOT NULL,            -- 'owner' | 'member'
      -- Снимок имени: показать «добавил Аня» надо и тогда, когда Аня сейчас
      -- не онлайн. Освежается при каждом её собственном запросе — как и
      -- велит Auth/INTEGRATION.md про изменчивость имени.
      display_name TEXT,
      joined_at    INTEGER NOT NULL,
      PRIMARY KEY (household_id, user_id)
    );
    -- Приглашения в дом. Зовут только друзей из Auth (проверяет server.js),
    -- поэтому отдельного «поиска людей» здесь нет и быть не должно.
    CREATE TABLE IF NOT EXISTS invites (
      id           TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      from_user    TEXT NOT NULL,
      from_name    TEXT,
      to_user      TEXT NOT NULL,
      status       TEXT NOT NULL,            -- pending | accepted | declined | cancelled
      created_at   INTEGER NOT NULL,
      decided_at   INTEGER
    );
    -- Подписки на уведомления устройства. Одна строка — один браузер.
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint   TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- Что мы про эту упаковку уже сказали. Без этого человек получал бы одно
    -- и то же «истекает» каждый день до самого конца срока и выключил бы
    -- уведомления на второй день.
    CREATE TABLE IF NOT EXISTS notified (
      user_id TEXT NOT NULL,
      pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
      kind    TEXT NOT NULL,
      at      INTEGER NOT NULL,
      PRIMARY KEY (user_id, pack_id, kind)
    );
    -- Где лежит. Дерево: «Аптечка → верхний ящик», «Дача», «Рюкзак».
    CREATE TABLE IF NOT EXISTS places (
      id           TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      parent_id    TEXT REFERENCES places(id) ON DELETE SET NULL,
      name         TEXT NOT NULL,
      sort         INTEGER NOT NULL DEFAULT 0
    );
    -- ЧТО это: каталог дома, одна строка на препарат/средство.
    CREATE TABLE IF NOT EXISTS items (
      id              TEXT PRIMARY KEY,
      household_id    TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      gtin            TEXT,                  -- этап 2: код с упаковки
      name            TEXT NOT NULL,
      -- name в нижнем регистре средствами JS. COLLATE NOCASE и lower() в
      -- SQLite работают только для латиницы, то есть «Ибупрофен» и
      -- «ибупрофен» стали бы двумя позициями — ровно тем, чего каталог
      -- должен избегать.
      name_key        TEXT NOT NULL,
      mnn             TEXT,                  -- действующее вещество
      form            TEXT,
      dose            TEXT,
      pack_qty        REAL,
      unit            TEXT,
      after_open_days INTEGER,               -- годен N дней после вскрытия
      storage_max_c   INTEGER,
      rx              INTEGER,
      leaflet_url     TEXT,
      low_at          REAL,                  -- «мало» — порог остатка
      source          TEXT NOT NULL,         -- 'manual' | 'leaflet' | 'off'
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    -- ЧТО лежит: одна строка — одна физическая упаковка.
    CREATE TABLE IF NOT EXISTS packs (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      -- Дом продублирован сюда намеренно, хотя его видно через items. Иначе
      -- уникальность серийного номера была бы ГЛОБАЛЬНОЙ: добавление коробки
      -- в одном доме падало бы из-за чужого дома, а дедуп возвращал бы
      -- человеку чужую упаковку. Область уникальности — дом, и выразить это
      -- в SQLite можно только колонкой здесь.
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      place_id   TEXT REFERENCES places(id) ON DELETE SET NULL,
      expires_on TEXT,                       -- 'YYYY-MM'
      opened_on  TEXT,                       -- 'YYYY-MM-DD'
      qty        REAL NOT NULL,
      serial     TEXT,                       -- (21) из DataMatrix — тождество коробки
      status     TEXT NOT NULL,              -- 'have' | 'used' | 'discarded'
      note       TEXT,
      rid        TEXT,
      added_by   TEXT NOT NULL,
      added_at   INTEGER NOT NULL
    );
    -- Журнал: для отмены, истории и списка докупить.
    CREATE TABLE IF NOT EXISTS events (
      id      TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
      -- Дом здесь по той же причине, что и у packs: rid придумывает клиент,
      -- и уникальным он может быть только внутри дома.
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      kind    TEXT NOT NULL,                 -- add|take|open|move|discard|restore|edit
      qty     REAL,
      before  TEXT,                          -- что было, JSON — для отмены
      at      INTEGER NOT NULL,
      rid     TEXT
    );
    -- ОБЩИЙ каталог: то, что подтвердил один дом, доступно всем. Иначе
    -- справочник пришлось бы наполнять вручную и заранее, а препаратов
    -- слишком много, чтобы угадать нужные.
    --
    -- Здесь намеренно НЕТ user_id и household_id: вклад анонимен. По
    -- каталогу не должно читаться, кто чем лечится.
    CREATE TABLE IF NOT EXISTS catalog (
      id              TEXT PRIMARY KEY,
      name_key        TEXT NOT NULL,
      dose_key        TEXT NOT NULL DEFAULT '',
      gtin            TEXT,
      name            TEXT NOT NULL,
      mnn             TEXT,
      form            TEXT,
      dose            TEXT,
      pack_qty        REAL,
      unit            TEXT,
      after_open_days INTEGER,
      storage_max_c   INTEGER,
      rx              INTEGER,
      quotes          TEXT,            -- JSON: поле -> цитата из инструкции
      source          TEXT NOT NULL,   -- leaflet | photo | user
      confirmations   INTEGER NOT NULL DEFAULT 1,
      updated_at      INTEGER NOT NULL
    );
    -- Чего каталог ещё не знает. Нужен, чтобы собирать инструкции по тому,
    -- что у людей реально лежит, а не по догадкам.
    CREATE TABLE IF NOT EXISTS wanted (
      name_key TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      gtin     TEXT,
      asked    INTEGER NOT NULL DEFAULT 1,
      last_at  INTEGER NOT NULL
    );
    -- Аккаунт исчез из Auth: ждём сутки, прежде чем стереть данные.
    CREATE TABLE IF NOT EXISTS purge_pending (
      user_id TEXT PRIMARY KEY,
      since   INTEGER NOT NULL
    );
  `);

  /* Миграции. CREATE TABLE IF NOT EXISTS молча пропускает уже существующую
     таблицу, поэтому новая колонка на старой базе сама не появится — её
     нужно досоздать здесь, ДО индексов, которые на неё ссылаются.
     Порядок в этом файле поэтому такой: таблицы → миграции → индексы. */
  const columns = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));

  // Этап 2: дом переехал в сами packs/events. Зачем — в комментарии к схеме:
  // уникальность серийного номера и rid должна быть внутри дома, а не на весь
  // сервис. Старым строкам дом проставляем из их же позиции.
  if (!columns("packs").has("household_id")) {
    db.exec(`
      ALTER TABLE packs ADD COLUMN household_id TEXT;
      UPDATE packs SET household_id = (SELECT i.household_id FROM items i WHERE i.id = packs.item_id);
      DROP INDEX IF EXISTS packs_serial;
      DROP INDEX IF EXISTS packs_rid;
    `);
  }
  // Этап 4: настройки напоминаний и снимок имени участника.
  for (const [table, col, decl] of [
    ["profiles", "remind_at", "TEXT NOT NULL DEFAULT '10:00'"],
    ["profiles", "notify_json", "TEXT"],
    ["profiles", "notified_day", "TEXT"],
    ["household_members", "display_name", "TEXT"],
  ]) if (!columns(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);

  if (!columns("events").has("household_id")) {
    db.exec(`
      ALTER TABLE events ADD COLUMN household_id TEXT;
      UPDATE events SET household_id = (SELECT p.household_id FROM packs p WHERE p.id = events.pack_id);
      DROP INDEX IF EXISTS events_rid;
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS items_hh ON items(household_id);
    CREATE UNIQUE INDEX IF NOT EXISTS items_gtin ON items(household_id, gtin) WHERE gtin IS NOT NULL;
    CREATE INDEX IF NOT EXISTS packs_item ON packs(item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS packs_serial ON packs(household_id, serial) WHERE serial IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS packs_rid ON packs(household_id, rid) WHERE rid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS events_pack ON events(pack_id, at);
    CREATE UNIQUE INDEX IF NOT EXISTS events_rid ON events(household_id, rid) WHERE rid IS NOT NULL;
    -- Одно открытое приглашение на пару «дом + человек»: повторное «пригласить»
    -- не плодит заявки, а возвращает ту же.
    CREATE UNIQUE INDEX IF NOT EXISTS catalog_key ON catalog(name_key, dose_key);
    CREATE UNIQUE INDEX IF NOT EXISTS catalog_gtin ON catalog(gtin) WHERE gtin IS NOT NULL;
    CREATE INDEX IF NOT EXISTS wanted_last ON wanted(last_at);
    CREATE UNIQUE INDEX IF NOT EXISTS invites_open ON invites(household_id, to_user) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS invites_to ON invites(to_user, status);
    CREATE INDEX IF NOT EXISTS push_user ON push_subs(user_id);
  `);

  const st = {
    profile: db.prepare("SELECT * FROM profiles WHERE user_id = ?"),
    profileIns: db.prepare("INSERT INTO profiles (user_id, tz, created_at, updated_at) VALUES (?, ?, ?, ?)"),
    profileTz: db.prepare("UPDATE profiles SET tz = ?, updated_at = ? WHERE user_id = ?"),
    profileHh: db.prepare("UPDATE profiles SET active_hh = ?, updated_at = ? WHERE user_id = ?"),
    profileImported: db.prepare("UPDATE profiles SET guest_imported = 1, updated_at = ? WHERE user_id = ?"),

    hhIns: db.prepare("INSERT INTO households (id, name, created_by, created_at) VALUES (?, ?, ?, ?)"),
    hhGet: db.prepare("SELECT * FROM households WHERE id = ?"),
    hhOf: db.prepare(`SELECT h.id, h.name, m.role FROM households h
                      JOIN household_members m ON m.household_id = h.id
                      WHERE m.user_id = ? ORDER BY m.joined_at`),
    memberIns: db.prepare("INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"),
    member: db.prepare("SELECT role FROM household_members WHERE household_id = ? AND user_id = ?"),
    membersOf: db.prepare("SELECT user_id FROM household_members WHERE household_id = ?"),
    memberDel: db.prepare("DELETE FROM household_members WHERE user_id = ?"),

    placeIns: db.prepare("INSERT INTO places (id, household_id, parent_id, name, sort) VALUES (?, ?, ?, ?, ?)"),
    placeList: db.prepare("SELECT id, parent_id, name, sort FROM places WHERE household_id = ? ORDER BY sort, name"),
    placeGet: db.prepare("SELECT * FROM places WHERE id = ? AND household_id = ?"),
    placeRename: db.prepare("UPDATE places SET name = ? WHERE id = ? AND household_id = ?"),
    placeDel: db.prepare("DELETE FROM places WHERE id = ? AND household_id = ?"),
    placeMaxSort: db.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM places WHERE household_id = ?"),

    itemIns: db.prepare(`INSERT INTO items (id, household_id, kind, gtin, name, name_key, mnn, form, dose, pack_qty, unit,
                          after_open_days, storage_max_c, rx, leaflet_url, low_at, source, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    itemList: db.prepare("SELECT * FROM items WHERE household_id = ? ORDER BY name_key"),
    itemGet: db.prepare("SELECT * FROM items WHERE id = ? AND household_id = ?"),
    itemByName: db.prepare("SELECT * FROM items WHERE household_id = ? AND name_key = ? AND COALESCE(dose,'') = COALESCE(?,'')"),
    itemDel: db.prepare("DELETE FROM items WHERE id = ? AND household_id = ?"),
    itemHasPacks: db.prepare("SELECT COUNT(*) AS n FROM packs WHERE item_id = ?"),

    packIns: db.prepare(`INSERT INTO packs (id, item_id, household_id, place_id, expires_on, opened_on, qty, serial, status, note, rid, added_by, added_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    packBySerial: db.prepare("SELECT id FROM packs WHERE household_id = ? AND serial = ?"),
    itemByGtin: db.prepare("SELECT * FROM items WHERE household_id = ? AND gtin = ?"),
    packList: db.prepare(`SELECT p.*, i.household_id FROM packs p JOIN items i ON i.id = p.item_id
                          WHERE i.household_id = ?`),
    packGet: db.prepare(`SELECT p.*, i.household_id FROM packs p JOIN items i ON i.id = p.item_id
                         WHERE p.id = ? AND i.household_id = ?`),
    packByRid: db.prepare("SELECT id FROM packs WHERE household_id = ? AND rid = ?"),
    packCount: db.prepare("SELECT COUNT(*) AS n FROM packs p JOIN items i ON i.id = p.item_id WHERE i.household_id = ?"),
    packUpd: db.prepare("UPDATE packs SET place_id = ?, expires_on = ?, opened_on = ?, qty = ?, status = ?, note = ? WHERE id = ?"),
    packDel: db.prepare("DELETE FROM packs WHERE id = ?"),

    evIns: db.prepare("INSERT INTO events (id, pack_id, household_id, user_id, kind, qty, before, at, rid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    evByRid: db.prepare("SELECT id FROM events WHERE household_id = ? AND rid = ?"),
    // before IS NOT NULL — у «добавил» снимка прежнего состояния нет, и
    // отменять его нечем; иначе последнее добавление намертво блокировало бы
    // отмену предыдущего действия.
    evLast: db.prepare(`SELECT * FROM events WHERE household_id = ? AND kind != 'undone' AND before IS NOT NULL
                        ORDER BY at DESC, rowid DESC LIMIT 1`),
    evKind: db.prepare("UPDATE events SET kind = 'undone' WHERE id = ?"),
    evOfPack: db.prepare("SELECT kind, qty, at, user_id FROM events WHERE pack_id = ? ORDER BY at DESC, rowid DESC LIMIT 50"),

    purgeGet: db.prepare("SELECT user_id, since FROM purge_pending"),
    purgeIns: db.prepare("INSERT OR IGNORE INTO purge_pending (user_id, since) VALUES (?, ?)"),
    purgeDel: db.prepare("DELETE FROM purge_pending WHERE user_id = ?"),

    /* ---------- этап 4: дом, приглашения, напоминания ---------- */
    memberList: db.prepare("SELECT user_id, role, display_name, joined_at FROM household_members WHERE household_id = ? ORDER BY joined_at"),
    memberName: db.prepare("UPDATE household_members SET display_name = ? WHERE household_id = ? AND user_id = ?"),
    memberDelOne: db.prepare("DELETE FROM household_members WHERE household_id = ? AND user_id = ?"),
    memberRole: db.prepare("UPDATE household_members SET role = ? WHERE household_id = ? AND user_id = ?"),
    hhRename: db.prepare("UPDATE households SET name = ? WHERE id = ?"),
    hhDel: db.prepare("DELETE FROM households WHERE id = ?"),

    invIns: db.prepare("INSERT INTO invites (id, household_id, from_user, from_name, to_user, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"),
    invGet: db.prepare("SELECT * FROM invites WHERE id = ?"),
    invOpen: db.prepare("SELECT * FROM invites WHERE household_id = ? AND to_user = ? AND status = 'pending'"),
    invIncoming: db.prepare(`SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id
                             WHERE i.to_user = ? AND i.status = 'pending' ORDER BY i.created_at`),
    invOutgoing: db.prepare("SELECT * FROM invites WHERE household_id = ? AND status = 'pending' ORDER BY created_at"),
    invDecide: db.prepare("UPDATE invites SET status = ?, decided_at = ? WHERE id = ?"),

    subIns: db.prepare("INSERT OR REPLACE INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)"),
    subDel: db.prepare("DELETE FROM push_subs WHERE endpoint = ?"),
    subsFor: db.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?"),

    allProfiles: db.prepare("SELECT * FROM profiles"),
    notifiedHas: db.prepare("SELECT 1 AS yes FROM notified WHERE user_id = ? AND pack_id = ? AND kind = ?"),
    notifiedIns: db.prepare("INSERT OR IGNORE INTO notified (user_id, pack_id, kind, at) VALUES (?, ?, ?, ?)"),
    notifiedDay: db.prepare("UPDATE profiles SET notified_day = ?, updated_at = ? WHERE user_id = ?"),
    setRemind: db.prepare("UPDATE profiles SET remind_at = ?, notify_json = ?, updated_at = ? WHERE user_id = ?"),

    /* ---------- общий каталог ---------- */
    catByKey: db.prepare("SELECT * FROM catalog WHERE name_key = ? AND dose_key = ?"),
    catByGtin: db.prepare("SELECT * FROM catalog WHERE gtin = ?"),
    catIns: db.prepare(`INSERT INTO catalog (id, name_key, dose_key, gtin, name, mnn, form, dose, pack_qty, unit,
                          after_open_days, storage_max_c, rx, quotes, source, confirmations, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`),
    catUpd: db.prepare(`UPDATE catalog SET gtin = ?, name = ?, mnn = ?, form = ?, dose = ?, pack_qty = ?, unit = ?,
                          after_open_days = ?, storage_max_c = ?, rx = ?, quotes = ?, source = ?,
                          confirmations = confirmations + ?, updated_at = ? WHERE id = ?`),
    catCount: db.prepare("SELECT COUNT(*) AS n FROM catalog"),

    wantIns: db.prepare("INSERT INTO wanted (name_key, name, gtin, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(name_key) DO UPDATE SET asked = asked + 1, last_at = excluded.last_at, gtin = COALESCE(wanted.gtin, excluded.gtin)"),
    wantDel: db.prepare("DELETE FROM wanted WHERE name_key = ?"),
    wantList: db.prepare("SELECT name, gtin, asked, last_at FROM wanted ORDER BY asked DESC, last_at DESC LIMIT ?"),
  };

  /* Транзакция, переносящая вложенность. Перенос гостевой аптечки — это одна
     внешняя транзакция, внутри которой addPack открывает свою на каждую
     упаковку; без счётчика SQLite падает на втором BEGIN. */
  let txDepth = 0;
  function tx(fn) {
    if (txDepth++) { try { return fn(); } finally { txDepth--; } }
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
    finally { txDepth--; }
  }

  /* ---------- профиль и дом ---------- */

  function profile(userId, tz) {
    let p = st.profile.get(userId);
    const now = Date.now();
    if (!p) {
      st.profileIns.run(userId, validTz(tz) || DEFAULT_TZ, now, now);
      p = st.profile.get(userId);
    } else if (validTz(tz) && tz !== p.tz) {
      // Пояс освежаем на каждом заходе: человек переехал или улетел, и
      // «сегодня» должно считаться там, где он сейчас.
      st.profileTz.run(tz, now, userId);
      p.tz = tz;
    }
    return p;
  }

  /** Дом создаётся сам при первом заходе — вместе с «Аптечкой». */
  function ensureHousehold(userId, tz) {
    const p = profile(userId, tz);
    let list = st.hhOf.all(userId);
    if (!list.length) {
      const now = Date.now();
      const hid = ID();
      st.hhIns.run(hid, "Мой дом", userId, now);
      st.memberIns.run(hid, userId, "owner", now);
      // Одно место по умолчанию, а не пять: лишние пустые полки человек не
      // удаляет, он просто перестаёт ими пользоваться, и список мусорится.
      st.placeIns.run(ID(), hid, null, "Аптечка", 1);
      st.profileHh.run(hid, now, userId);
      list = st.hhOf.all(userId);
    }
    const active = list.find(h => h.id === p.active_hh) || list[0];
    if (active.id !== p.active_hh) st.profileHh.run(active.id, Date.now(), userId);
    return { profile: p, household: active, households: list };
  }

  /** Проверка доступа: без неё любой id упаковки открывал бы чужой дом. */
  function assertMember(userId, hid) {
    if (!hid || !st.member.get(hid, userId)) {
      throw Object.assign(new Error("not a member"), { status: 403, code: "not_member" });
    }
  }

  function me(userId, tz, name) {
    const { profile: p, household, households } = ensureHousehold(userId, tz);
    touchMember(userId, household.id, name);
    return {
      tz: p.tz,
      household: { id: household.id, name: household.name, role: household.role },
      households: households.map(h => ({ id: h.id, name: h.name, role: h.role })),
      places: places(userId, household.id),
      summary: summary(userId, household.id),
      members: members(userId, household.id),
      // Приглашения показываются на любом экране: пропустить приглашение в
      // общую аптечку обиднее, чем лишний раз его увидеть.
      invites: incomingInvites(userId),
      notify: notifySettings(p),
    };
  }

  /* ---------- места ---------- */

  function places(userId, hid) {
    assertMember(userId, hid);
    const counts = new Map();
    for (const p of st.packList.all(hid)) {
      if (p.status !== "have") continue;
      counts.set(p.place_id, (counts.get(p.place_id) || 0) + 1);
    }
    return st.placeList.all(hid).map(p => ({
      id: p.id, parentId: p.parent_id, name: p.name, sort: p.sort, packs: counts.get(p.id) || 0,
    }));
  }

  function addPlace(userId, hid, { name, parentId }) {
    assertMember(userId, hid);
    const n = str(name, 80);
    if (!n) return null;
    if (parentId && !st.placeGet.get(parentId, hid)) return null;
    const id = ID();
    st.placeIns.run(id, hid, parentId || null, n, st.placeMaxSort.get(hid).m + 1);
    return { id, parentId: parentId || null, name: n, packs: 0 };
  }

  function renamePlace(userId, hid, id, name) {
    assertMember(userId, hid);
    const n = str(name, 80);
    if (!n || !st.placeGet.get(id, hid)) return null;
    st.placeRename.run(n, id, hid);
    return { id, name: n };
  }

  /** Место удаляется, упаковки остаются — просто без места (ON DELETE SET NULL). */
  function deletePlace(userId, hid, id) {
    assertMember(userId, hid);
    if (!st.placeGet.get(id, hid)) return null;
    st.placeDel.run(id, hid);
    return { deleted: true };
  }

  /* ---------- позиции ---------- */

  const pubItem = i => ({
    id: i.id, kind: i.kind, gtin: i.gtin, name: i.name, mnn: i.mnn, form: i.form, dose: i.dose,
    packQty: i.pack_qty, unit: i.unit, afterOpenDays: i.after_open_days, storageMaxC: i.storage_max_c,
    rx: i.rx === null ? null : !!i.rx, leafletUrl: i.leaflet_url, lowAt: i.low_at, source: i.source,
  });

  function readItemFields(b) {
    const name = str(b?.name);
    if (!name) return null;
    return {
      name,
      kind: KINDS.includes(b?.kind) ? b.kind : "drug",
      mnn: str(b?.mnn), form: str(b?.form, 120), dose: str(b?.dose, 60),
      packQty: num(b?.packQty, { min: 0.01, max: 100000 }),
      unit: UNITS.includes(b?.unit) ? b.unit : str(b?.unit, 16),
      afterOpenDays: intOrNull(b?.afterOpenDays),
      storageMaxC: b?.storageMaxC === null || b?.storageMaxC === undefined || b?.storageMaxC === ""
        ? null : (Number.isFinite(Number(b.storageMaxC)) ? Math.round(Number(b.storageMaxC)) : null),
      rx: b?.rx === null || b?.rx === undefined ? null : (b.rx ? 1 : 0),
      leafletUrl: /^https:\/\/[^\s"']{3,300}$/.test(b?.leafletUrl || "") ? b.leafletUrl : null,
      lowAt: num(b?.lowAt, { min: 0, max: 100000 }),
      gtin: /^\d{8,14}$/.test(b?.gtin || "") ? b.gtin : null,
    };
  }

  function items(userId, hid) {
    assertMember(userId, hid);
    return st.itemList.all(hid).map(pubItem);
  }

  function addItem(userId, hid, body) {
    assertMember(userId, hid);
    const f = readItemFields(body);
    if (!f) return null;
    /* Подсказка из инструкции: то, чего человек не вписал, но что известно
       про этот препарат из официальной бумаги. Введённое руками важнее —
       человек смотрит на свою упаковку, а она могла быть другой серии. */
    const leaf = known({ name: f.name, dose: f.dose, gtin: f.gtin });
    if (!leaf) wantedAdd(f.name, f.gtin);
    if (leaf) {
      if (f.afterOpenDays === null) f.afterOpenDays = intOrNull(leaf.afterOpenDays);
      if (f.storageMaxC === null && Number.isFinite(Number(leaf.storageMaxC))) f.storageMaxC = Math.round(Number(leaf.storageMaxC));
      if (f.rx === null && typeof leaf.rx === "boolean") f.rx = leaf.rx ? 1 : 0;
      if (!f.form && leaf.form) f.form = str(leaf.form, 120);
      if (!f.mnn && leaf.mnn) f.mnn = str(leaf.mnn);
    }
    // Одно и то же название с той же дозировкой — та же позиция. Иначе через
    // месяц в каталоге три «Ибупрофен 200 мг», и группировка теряет смысл.
    const have = st.itemByName.get(hid, f.name.toLowerCase(), f.dose);
    if (have) return pubItem(have);
    const now = Date.now(), id = ID();
    st.itemIns.run(id, hid, f.kind, f.gtin, f.name, f.name.toLowerCase(), f.mnn, f.form, f.dose, f.packQty, f.unit,
      f.afterOpenDays, f.storageMaxC, f.rx, f.leafletUrl, f.lowAt,
      body?.source === "leaflet" || leaf ? "leaflet" : "manual", now, now);
    return pubItem(st.itemGet.get(id, hid));
  }

  function updateItem(userId, hid, id, body) {
    assertMember(userId, hid);
    const cur = st.itemGet.get(id, hid);
    if (!cur) return null;
    const f = readItemFields({ ...pubItem(cur), ...body });
    if (!f) return null;
    db.prepare(`UPDATE items SET kind=?, gtin=?, name=?, name_key=?, mnn=?, form=?, dose=?, pack_qty=?, unit=?,
                after_open_days=?, storage_max_c=?, rx=?, leaflet_url=?, low_at=?, updated_at=? WHERE id=? AND household_id=?`)
      .run(f.kind, f.gtin, f.name, f.name.toLowerCase(), f.mnn, f.form, f.dose, f.packQty, f.unit, f.afterOpenDays,
        f.storageMaxC, f.rx, f.leafletUrl, f.lowAt, Date.now(), id, hid);
    return pubItem(st.itemGet.get(id, hid));
  }

  /* ---------- упаковки ---------- */

  function pubPack(p, item, today) {
    const eff = X.effective({ expiresOn: p.expires_on, openedOn: p.opened_on }, item, today);
    return {
      id: p.id, itemId: p.item_id, placeId: p.place_id, expiresOn: p.expires_on, openedOn: p.opened_on,
      qty: p.qty, status: p.status, note: p.note, addedBy: p.added_by, addedAt: p.added_at,
      item, expiry: eff,
      low: item.lowAt !== null && item.lowAt !== undefined && p.qty <= item.lowAt,
    };
  }

  function packs(userId, hid, { placeId, status = "have", kind } = {}) {
    assertMember(userId, hid);
    const today = dayIn(st.profile.get(userId)?.tz || DEFAULT_TZ);
    const byId = new Map(st.itemList.all(hid).map(i => [i.id, pubItem(i)]));
    const out = [];
    for (const p of st.packList.all(hid)) {
      if (status !== "all" && p.status !== status) continue;
      if (placeId && p.place_id !== placeId) continue;
      const item = byId.get(p.item_id);
      if (!item || (kind && item.kind !== kind)) continue;
      out.push(pubPack(p, item, today));
    }
    out.sort((a, b) => X.compare(a.expiry, b.expiry) || a.item.name.localeCompare(b.item.name, "ru"));
    return out;
  }

  /** Сводка для главной: сколько истекло, сколько горит, сколько всего. */
  function summary(userId, hid) {
    assertMember(userId, hid);
    const today = dayIn(st.profile.get(userId)?.tz || DEFAULT_TZ);
    const byId = new Map(st.itemList.all(hid).map(i => [i.id, pubItem(i)]));
    const s = { total: 0, expired: 0, urgent: 0, soon: 0, ok: 0, unknown: 0, low: 0, opened: 0 };
    for (const p of st.packList.all(hid)) {
      if (p.status !== "have") continue;
      const item = byId.get(p.item_id);
      if (!item) continue;
      const v = pubPack(p, item, today);
      s.total++;
      s[v.expiry.status]++;
      if (v.low) s.low++;
      if (p.opened_on) s.opened++;
    }
    return s;
  }

  /** Отдать упаковку по id так же, как её отдаёт addPack. */
  function packOut(id, hid, userId, extra = {}) {
    const p = st.packGet.get(id, hid);
    if (!p) return null;
    const item = pubItem(st.itemGet.get(p.item_id, hid));
    return { ...pubPack(p, item, dayIn(st.profile.get(userId)?.tz || DEFAULT_TZ)), ...extra };
  }

  /**
   * Что сервис знает про отсканированный код. Один запрос на весь сценарий
   * сканирования: что это за препарат, и не добавляли ли мы ЭТУ коробку.
   *
   * source: 'household' — позиция уже в каталоге дома (обычный случай, дома
   * покупают одно и то же); 'bank' — в справочнике сервиса; null — код
   * незнакомый, название придётся спросить один раз.
   */
  function lookup(userId, hid, { gtin, serial } = {}) {
    assertMember(userId, hid);
    const g = typeof gtin === "string" && /^\d{8,14}$/.test(gtin) ? gtin.padStart(14, "0") : null;
    const known = g ? st.itemByGtin.get(hid, g) : null;
    const fromBank = !known && g && BANK[g] ? { ...BANK[g], gtin: g, source: "leaflet" } : null;
    const dup = serial ? st.packBySerial.get(hid, String(serial)) : null;
    return {
      gtin: g,
      item: known ? pubItem(known) : fromBank,
      source: known ? "household" : fromBank ? "bank" : null,
      existingPack: dup ? packOut(dup.id, hid, userId) : null,
    };
  }

  function addPack(userId, hid, body) {
    assertMember(userId, hid);
    if (!okRid(body?.rid)) return null;
    // Повтор из офлайн-очереди: та же упаковка, а не вторая такая же.
    if (body?.rid) {
      const have = st.packByRid.get(hid, body.rid);
      if (have) return packOut(have.id, hid, userId, { repeated: true });
    }
    // Серийный номер — тождество физической коробки. Поднесли её второй раз
    // (переставили, передумали, просто забыли) — открываем ту же запись, а не
    // заводим вторую. Это и есть главный выигрыш от DataMatrix.
    const serial = /^[\x20-\x7e]{4,60}$/.test(body?.serial || "") ? body.serial : null;
    if (serial) {
      const dup = st.packBySerial.get(hid, serial);
      if (dup) return packOut(dup.id, hid, userId, { duplicate: true });
    }
    if (st.packCount.get(hid).n >= PACKS_MAX) {
      throw Object.assign(new Error("too many packs"), { status: 409, code: "too_many" });
    }

    const expiresOn = X.isMonth(body?.expiresOn) ? body.expiresOn : null;
    const openedOn = X.isDay(body?.openedOn) ? body.openedOn : null;
    const placeId = body?.placeId && st.placeGet.get(body.placeId, hid) ? body.placeId : null;
    const gtin = typeof body?.gtin === "string" && /^\d{8,14}$/.test(body.gtin) ? body.gtin.padStart(14, "0") : null;

    return tx(() => {
      let item = body?.itemId ? st.itemGet.get(body.itemId, hid) : null;
      // Код уже знаком — название спрашивать незачем, это и есть «два тапа».
      if (!item && gtin) item = st.itemByGtin.get(hid, gtin);
      if (!item) {
        // Незнакомый код: берём, что знает справочник, и дополняем тем, что
        // прислал клиент. Нет ни того ни другого — вернём null, и интерфейс
        // спросит название.
        const base = gtin && BANK[gtin] ? { ...BANK[gtin], source: "leaflet" } : {};
        const created = addItem(userId, hid, { ...base, ...clean(body?.item || body), gtin });
        if (!created) return null;
        item = st.itemGet.get(created.id, hid);
      }
      const qty = num(body?.qty, { min: 0, max: 100000 });
      const id = ID(), now = Date.now();
      st.packIns.run(id, item.id, hid, placeId, expiresOn, openedOn,
        qty === null ? (item.pack_qty ?? 1) : qty,
        serial, "have", str(body?.note, 300), body?.rid || null, userId, now);
      st.evIns.run(ID(), id, hid, userId, "add", qty, null, now, body?.rid ? body.rid + ":add" : null);
      return packOut(id, hid, userId);
    });
  }

  /** Убирает пустые поля, чтобы они не затирали данные справочника. */
  const clean = o => Object.fromEntries(Object.entries(o || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== ""));

  /**
   * Одно действие над упаковкой. Всё пишется в журнал вместе со снимком
   * «что было» — чтобы отмена не угадывала прежнее состояние, а знала его.
   */
  function patchPack(userId, hid, id, body) {
    assertMember(userId, hid);
    if (!okRid(body?.rid)) return null;
    if (body?.rid && st.evByRid.get(hid, body.rid)) return packOut(id, hid, userId, { repeated: true });
    const p = st.packGet.get(id, hid);
    if (!p) return null;
    const item = st.itemGet.get(p.item_id, hid);
    const tz = st.profile.get(userId)?.tz || DEFAULT_TZ;
    const today = dayIn(tz);
    const before = JSON.stringify({ placeId: p.place_id, expiresOn: p.expires_on, openedOn: p.opened_on, qty: p.qty, status: p.status, note: p.note });

    let { place_id: placeId, expires_on: expiresOn, opened_on: openedOn, qty, status, note } = p;
    const action = body?.action;

    if (action === "take") {
      const n = num(body?.qty, { min: 0.01, max: 100000 }) ?? 1;
      qty = Math.max(0, Math.round((qty - n) * 1000) / 1000);
      // Вскрытие отмечается само: взять из запечатанной упаковки нельзя.
      if (!openedOn) openedOn = today;
      // Закончилась — не удаляем: позиция нужна списку докупить, а журнал
      // должен помнить, когда и кто её добил.
      if (qty <= 0) status = "used";
    } else if (action === "open") {
      openedOn = openedOn || today;
    } else if (action === "unopen") {
      openedOn = null;                       // отметили вскрытие по ошибке
    } else if (action === "move") {
      placeId = body?.placeId && st.placeGet.get(body.placeId, hid) ? body.placeId : null;
    } else if (action === "discard") {
      status = "discarded";
    } else if (action === "restore") {
      status = "have";
      if (qty <= 0) qty = item.pack_qty ?? 1;
    } else if (action === "edit") {
      if (body?.expiresOn !== undefined) expiresOn = X.isMonth(body.expiresOn) ? body.expiresOn : null;
      if (body?.openedOn !== undefined) openedOn = X.isDay(body.openedOn) ? body.openedOn : null;
      if (body?.qty !== undefined) {
        const n = num(body.qty, { min: 0, max: 100000 });
        if (n !== null) { qty = n; status = n > 0 && status === "used" ? "have" : status; }
      }
      if (body?.note !== undefined) note = str(body.note, 300);
      if (body?.placeId !== undefined) placeId = body.placeId && st.placeGet.get(body.placeId, hid) ? body.placeId : null;
    } else return null;

    return tx(() => {
      st.packUpd.run(placeId, expiresOn, openedOn, qty, status, note, id);
      st.evIns.run(ID(), id, hid, userId, action === "unopen" ? "edit" : action,
        action === "take" ? (num(body?.qty, { min: 0.01, max: 100000 }) ?? 1) : null,
        before, Date.now(), body?.rid || null);
      return pubPack(st.packGet.get(id, hid), pubItem(item), today);
    });
  }

  /** Удалить совсем — только то, что добавили по ошибке. Позиция остаётся. */
  function deletePack(userId, hid, id) {
    assertMember(userId, hid);
    if (!st.packGet.get(id, hid)) return null;
    st.packDel.run(id);
    return { deleted: true };
  }

  /**
   * Отмена последнего действия в доме. Возвращает состояние из снимка
   * `before`: так отмена работает и для «выбросил», и для «взял три».
   */
  function undoLast(userId, hid) {
    assertMember(userId, hid);
    const e = st.evLast.get(hid);
    if (!e || !e.before) return null;
    const p = st.packGet.get(e.pack_id, hid);
    if (!p) return null;
    const b = JSON.parse(e.before);
    return tx(() => {
      st.packUpd.run(b.placeId, b.expiresOn, b.openedOn, b.qty, b.status, b.note, p.id);
      st.evKind.run(e.id);
      const item = pubItem(st.itemGet.get(p.item_id, hid));
      return { undone: e.kind, pack: pubPack(st.packGet.get(p.id, hid), item, dayIn(st.profile.get(userId)?.tz || DEFAULT_TZ)) };
    });
  }

  function history(userId, hid, packId) {
    assertMember(userId, hid);
    if (!st.packGet.get(packId, hid)) return null;
    return st.evOfPack.all(packId).map(e => ({ kind: e.kind, qty: e.qty, at: e.at, by: e.user_id }));
  }

  /**
   * Что докупить. Три причины, и каждая — отдельная: «кончилось» и «скоро
   * истечёт» требуют разной срочности, а валить их в один список значит
   * получить список, который не читают.
   */
  function shopping(userId, hid) {
    assertMember(userId, hid);
    const today = dayIn(st.profile.get(userId)?.tz || DEFAULT_TZ);
    const byId = new Map(st.itemList.all(hid).map(i => [i.id, pubItem(i)]));
    const live = new Map();   // item_id -> { have, usable, low }
    for (const p of st.packList.all(hid)) {
      const item = byId.get(p.item_id);
      if (!item) continue;
      const rec = live.get(p.item_id) || { have: 0, usable: 0, low: true, qty: 0 };
      if (p.status === "have") {
        rec.have++;
        rec.qty += p.qty;
        const eff = X.effective({ expiresOn: p.expires_on, openedOn: p.opened_on }, item, today);
        if (eff.status !== "expired") rec.usable++;
      }
      live.set(p.item_id, rec);
    }
    const out = [];
    for (const [itemId, rec] of live) {
      const item = byId.get(itemId);
      if (!rec.have) out.push({ item, reason: "out" });
      else if (!rec.usable) out.push({ item, reason: "expired" });
      else if (item.lowAt !== null && item.lowAt !== undefined && rec.qty <= item.lowAt) out.push({ item, reason: "low", qty: rec.qty });
    }
    out.sort((a, b) => ["out", "expired", "low"].indexOf(a.reason) - ["out", "expired", "low"].indexOf(b.reason)
      || a.item.name.localeCompare(b.item.name, "ru"));
    return out;
  }

  /* ---------- перенос гостевой аптечки ---------- */

  /**
   * Первый вход: то, что человек успел завести без входа, уезжает в дом.
   * Повторный импорт запрещён (guest_imported) — иначе «войти-выйти-войти»
   * размножает аптечку.
   */
  function importGuest(userId, data, tz) {
    const { household } = ensureHousehold(userId, tz);
    const p = st.profile.get(userId);
    if (p.guest_imported) return { imported: false, reason: "already" };
    if (!data || typeof data !== "object") return { imported: false, reason: "empty" };

    const hid = household.id;
    return tx(() => {
      const placeMap = new Map();
      for (const pl of Array.isArray(data.places) ? data.places.slice(0, 50) : []) {
        const created = addPlace(userId, hid, { name: pl?.name });
        if (created) placeMap.set(pl.id, created.id);
      }
      const itemMap = new Map();
      for (const it of Array.isArray(data.items) ? data.items.slice(0, 1000) : []) {
        const created = addItem(userId, hid, it);
        if (created) itemMap.set(it.id, created.id);
      }
      let packs = 0;
      for (const pk of Array.isArray(data.packs) ? data.packs.slice(0, PACKS_MAX) : []) {
        const itemId = itemMap.get(pk?.itemId);
        if (!itemId) continue;
        const r = addPack(userId, hid, {
          itemId, placeId: placeMap.get(pk?.placeId) || null,
          expiresOn: pk?.expiresOn, openedOn: pk?.openedOn, qty: pk?.qty, note: pk?.note,
        });
        if (r) packs++;
      }
      st.profileImported.run(Date.now(), userId);
      return { imported: true, places: placeMap.size, items: itemMap.size, packs };
    });
  }

  /* ---------- удаление данных ---------- */

  /**
   * «Удалить мои данные». Дом, в котором человек один, уезжает целиком
   * (каскадом — места, позиции, упаковки). Из общего дома человек просто
   * выходит: стирать общую аптечку, уходя, он не вправе.
   */
  function deleteUserData(userId) {
    return tx(() => {
      let households = 0;
      for (const h of st.hhOf.all(userId)) {
        const members = st.membersOf.all(h.id);
        if (members.length === 1) { db.prepare("DELETE FROM households WHERE id = ?").run(h.id); households++; }
      }
      for (const t of USER_TABLES) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
      st.purgeDel.run(userId);
      return { deleted: true, households };
    });
  }

  /** Аккаунт пропал из Auth: сутки ждём (вдруг сбой), потом стираем. */
  function purgeMissing(aliveIds) {
    const now = Date.now();
    let purged = 0;
    const seen = new Set();
    for (const row of db.prepare("SELECT user_id FROM profiles").all()) {
      if (aliveIds.has(row.user_id)) { st.purgeDel.run(row.user_id); continue; }
      seen.add(row.user_id);
      st.purgeIns.run(row.user_id, now);
    }
    for (const row of st.purgeGet.all()) {
      if (!seen.has(row.user_id)) { st.purgeDel.run(row.user_id); continue; }
      if (now - row.since < PURGE_GRACE_MS) continue;
      deleteUserData(row.user_id);
      purged++;
    }
    return { purged };
  }

  function stats() {
    const one = q => db.prepare(q).get().n;
    return {
      households: one("SELECT COUNT(*) AS n FROM households"),
      users: one("SELECT COUNT(*) AS n FROM profiles"),
      items: one("SELECT COUNT(*) AS n FROM items"),
      packs: one("SELECT COUNT(*) AS n FROM packs WHERE status = 'have'"),
    };
  }

  /* ---------- общий каталог ---------- */

  /** Насколько источнику можно верить. Инструкция важнее снимка, снимок — слов. */
  const TRUST = { leaflet: 3, photo: 2, user: 1 };
  const CAT_FIELDS = ["mnn", "form", "dose", "packQty", "unit", "afterOpenDays", "storageMaxC", "rx"];
  const doseKey = d => String(d || "").toLowerCase().replace(/\s+/g, " ").trim();

  const pubCatalog = c => c && {
    id: c.id, gtin: c.gtin, name: c.name, mnn: c.mnn, form: c.form, dose: c.dose,
    packQty: c.pack_qty, unit: c.unit, afterOpenDays: c.after_open_days,
    storageMaxC: c.storage_max_c, rx: c.rx === null ? null : !!c.rx,
    quotes: c.quotes ? JSON.parse(c.quotes) : {}, source: c.source,
    confirmations: c.confirmations, updatedAt: c.updated_at,
  };

  /**
   * Что сервис знает о препарате — из инструкций (bank) или из общего
   * каталога. Порядок важен: выверенная инструкция главнее того, что
   * прислали из дома.
   */
  function known({ name, dose, gtin } = {}) {
    const leaf = name ? LEAFLETS.get(nameKey(name)) : null;
    if (leaf) return { ...leaf, source: "leaflet", quotes: leaf.quotes || {}, confirmations: null };
    const g = typeof gtin === "string" && /^\d{8,14}$/.test(gtin) ? gtin.padStart(14, "0") : null;
    const row = (g && st.catByGtin.get(g)) || (name && st.catByKey.get(nameKey(name), doseKey(dose)));
    return pubCatalog(row) || null;
  }

  /**
   * Записать в общий каталог. Правила слияния:
   *  - источник не хуже прежнего — его значения перекрывают старые;
   *  - источник хуже — заполняет только пустые поля;
   *  - значения совпали — считаем это подтверждением, их видно в карточке.
   */
  function catalogPut(body, source = "user") {
    const name = str(body?.name);
    if (!name || !TRUST[source]) return null;
    const f = readItemFields(body);
    if (!f) return null;
    const key = nameKey(name), dkey = doseKey(f.dose);
    // Один и тот же товар не должен лежать под «4601234567893» и
    // «04601234567893»: в каталоге код всегда GTIN-14 (assets/gs1.js).
    const g = f.gtin ? f.gtin.padStart(14, "0") : null;
    const now = Date.now();
    const quotes = body?.quotes && typeof body.quotes === "object" ? body.quotes : {};
    const have = (g && st.catByGtin.get(g)) || st.catByKey.get(key, dkey);

    if (!have) {
      const id = ID();
      st.catIns.run(id, key, dkey, g, name, f.mnn, f.form, f.dose, f.packQty, f.unit,
        f.afterOpenDays, f.storageMaxC, f.rx, JSON.stringify(quotes), source, now);
      st.wantDel.run(key);
      return pubCatalog(st.catByKey.get(key, dkey));
    }

    const better = TRUST[source] >= TRUST[have.source];
    const pick = (incoming, old) => (incoming === null || incoming === undefined ? old : better ? incoming : (old ?? incoming));
    const same = CAT_FIELDS.every(k => {
      const col = { packQty: "pack_qty", afterOpenDays: "after_open_days", storageMaxC: "storage_max_c" }[k] || k;
      const inc = f[k];
      return inc === null || inc === undefined || String(inc) === String(have[col] ?? "");
    });
    st.catUpd.run(
      pick(g, have.gtin), better ? name : have.name,
      pick(f.mnn, have.mnn), pick(f.form, have.form), pick(f.dose, have.dose),
      pick(f.packQty, have.pack_qty), pick(f.unit, have.unit),
      pick(f.afterOpenDays, have.after_open_days), pick(f.storageMaxC, have.storage_max_c),
      pick(f.rx, have.rx),
      JSON.stringify(better ? { ...JSON.parse(have.quotes || "{}"), ...quotes } : { ...quotes, ...JSON.parse(have.quotes || "{}") }),
      better ? source : have.source,
      same ? 1 : 0, now, have.id);
    st.wantDel.run(key);
    return pubCatalog(st.catByKey.get(key, dkey) || st.catByGtin.get(g));
  }

  /** Каталог не знает — запомним, чтобы было понятно, какие инструкции собирать. */
  function wantedAdd(name, gtin) {
    const n = str(name);
    if (!n) return null;
    st.wantIns.run(nameKey(n), n, typeof gtin === "string" && /^\d{8,14}$/.test(gtin) ? gtin.padStart(14, "0") : null, Date.now());
    return { noted: true };
  }
  const wantedList = (limit = 100) => st.wantList.all(Math.min(500, Math.max(1, limit)))
    .map(w => ({ name: w.name, gtin: w.gtin, asked: w.asked, lastAt: w.last_at }));

  /* ---------- дом: участники и приглашения ---------- */

  /** Время 'HH:MM' в поясе tz — для «пора ли напоминать». */
  const timeFmt = new Map();
  function timeIn(tz, ts = Date.now()) {
    if (!timeFmt.has(tz)) timeFmt.set(tz, new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }));
    return timeFmt.get(tz).format(ts).replace(".", ":");
  }

  /** Имя участника живёт в Auth и может меняться — освежаем при его заходе. */
  function touchMember(userId, hid, name) {
    if (name && st.member.get(hid, userId)) st.memberName.run(String(name).slice(0, 120), hid, userId);
  }

  function members(userId, hid) {
    assertMember(userId, hid);
    return st.memberList.all(hid).map(m => ({
      userId: m.user_id, role: m.role, name: m.display_name || null,
      joinedAt: m.joined_at, isMe: m.user_id === userId,
    }));
  }

  function renameHousehold(userId, hid, name) {
    assertMember(userId, hid);
    const n = str(name, 80);
    if (!n) return null;
    st.hhRename.run(n, hid);
    return { id: hid, name: n };
  }

  function createHousehold(userId, name, tz) {
    profile(userId, tz);
    const n = str(name, 80) || "Новый дом";
    const id = ID(), now = Date.now();
    return tx(() => {
      st.hhIns.run(id, n, userId, now);
      st.memberIns.run(id, userId, "owner", now);
      st.placeIns.run(ID(), id, null, "Аптечка", 1);
      st.profileHh.run(id, now, userId);
      return { id, name: n, role: "owner" };
    });
  }

  function switchHousehold(userId, hid) {
    assertMember(userId, hid);
    st.profileHh.run(hid, Date.now(), userId);
    return { id: hid };
  }

  /**
   * Приглашение. Звать можно только друга из Auth — это проверяет server.js
   * перед вызовом: у сервиса нет и не должно быть поиска людей.
   */
  function invite(userId, hid, { toUser, fromName }) {
    assertMember(userId, hid);
    if (!toUser || typeof toUser !== "string" || toUser === userId) return null;
    if (st.member.get(hid, toUser)) return { already: true };
    const open = st.invOpen.get(hid, toUser);
    if (open) return { id: open.id, repeated: true };
    const id = ID();
    st.invIns.run(id, hid, userId, str(fromName, 120), toUser, Date.now());
    return { id };
  }

  const pubInvite = i => ({
    id: i.id, householdId: i.household_id, householdName: i.household_name || null,
    fromUser: i.from_user, fromName: i.from_name || null, toUser: i.to_user,
    status: i.status, createdAt: i.created_at,
  });

  /** Приглашения, пришедшие человеку: показываются на любом экране. */
  const incomingInvites = userId => st.invIncoming.all(userId).map(pubInvite);
  function outgoingInvites(userId, hid) {
    assertMember(userId, hid);
    return st.invOutgoing.all(hid).map(pubInvite);
  }

  function acceptInvite(userId, inviteId, name) {
    const inv = st.invGet.get(inviteId);
    if (!inv || inv.to_user !== userId || inv.status !== "pending") return null;
    return tx(() => {
      const now = Date.now();
      st.invDecide.run("accepted", now, inviteId);
      if (!st.member.get(inv.household_id, userId)) st.memberIns.run(inv.household_id, userId, "member", now);
      touchMember(userId, inv.household_id, name);
      // Сразу переключаем: человек принял приглашение, чтобы увидеть ту самую
      // общую аптечку, а не свою.
      st.profileHh.run(inv.household_id, now, userId);
      const hh = st.hhGet.get(inv.household_id);
      return { joined: { id: hh.id, name: hh.name }, invitedBy: inv.from_user };
    });
  }

  function declineInvite(userId, inviteId) {
    const inv = st.invGet.get(inviteId);
    if (!inv || inv.to_user !== userId || inv.status !== "pending") return null;
    st.invDecide.run("declined", Date.now(), inviteId);
    return { declined: true };
  }

  function cancelInvite(userId, hid, inviteId) {
    assertMember(userId, hid);
    const inv = st.invGet.get(inviteId);
    if (!inv || inv.household_id !== hid || inv.status !== "pending") return null;
    st.invDecide.run("cancelled", Date.now(), inviteId);
    return { cancelled: true };
  }

  /**
   * Выход из дома. Последний участник выйти не может: дом с данными остался
   * бы ничьим, а «выйти» молча стёрло бы общую аптечку. Хочешь стереть —
   * есть «удалить мои данные», там это названо своим именем.
   */
  function leaveHousehold(userId, hid) {
    assertMember(userId, hid);
    const list = st.memberList.all(hid);
    if (list.length <= 1) return { error: "last_member" };
    return tx(() => {
      const me = list.find(m => m.user_id === userId);
      st.memberDelOne.run(hid, userId);
      // Ушёл владелец — дом переходит к тому, кто здесь дольше всех.
      if (me.role === "owner") {
        const next = st.memberList.all(hid)[0];
        if (next) st.memberRole.run("owner", hid, next.user_id);
      }
      const rest = st.hhOf.all(userId);
      st.profileHh.run(rest.length ? rest[0].id : null, Date.now(), userId);
      return { left: true, movedTo: rest.length ? rest[0].id : null };
    });
  }

  /** Убрать участника может только владелец и только не себя. */
  function removeMember(userId, hid, targetId) {
    assertMember(userId, hid);
    const mine = st.member.get(hid, userId);
    if (mine.role !== "owner") return { error: "not_owner" };
    if (targetId === userId) return { error: "self" };
    if (!st.member.get(hid, targetId)) return null;
    st.memberDelOne.run(hid, targetId);
    const other = st.hhOf.all(targetId);
    st.profileHh.run(other.length ? other[0].id : null, Date.now(), targetId);
    return { removed: true };
  }

  /* ---------- напоминания ---------- */

  /** Поводы напомнить. Все включены по умолчанию: выключать — осознанный шаг. */
  const NOTIFY_KINDS = ["expiring", "expired", "openExpiring", "low"];
  const DEFAULT_NOTIFY = Object.fromEntries(NOTIFY_KINDS.map(k => [k, true]));
  const EXPIRING_DAYS = 30;   // «истекает» — за месяц
  const OPEN_DAYS = 3;        // вскрытое — за три дня: тут счёт идёт на дни

  function notifySettings(p) {
    let kinds = DEFAULT_NOTIFY;
    try { if (p.notify_json) kinds = { ...DEFAULT_NOTIFY, ...JSON.parse(p.notify_json) }; } catch { /* битый json — значения по умолчанию */ }
    return { remindAt: p.remind_at || "10:00", kinds };
  }

  function setNotify(userId, body, tz) {
    const p = profile(userId, tz);
    const at = /^([01]\d|2[0-3]):([0-5]\d)$/.test(body?.remindAt || "") ? body.remindAt : (p.remind_at || "10:00");
    const cur = notifySettings(p).kinds;
    const kinds = { ...cur };
    for (const k of NOTIFY_KINDS) if (body?.kinds && typeof body.kinds[k] === "boolean") kinds[k] = body.kinds[k];
    st.setRemind.run(at, JSON.stringify(kinds), Date.now(), userId);
    return { remindAt: at, kinds };
  }

  function addPushSub(userId, sub) {
    const endpoint = typeof sub?.endpoint === "string" && /^https:\/\/.{10,500}$/.test(sub.endpoint) ? sub.endpoint : null;
    const p256dh = str(sub?.keys?.p256dh, 200), auth = str(sub?.keys?.auth, 200);
    if (!endpoint || !p256dh || !auth) return null;
    st.subIns.run(endpoint, userId, p256dh, auth, Date.now());
    return { subscribed: true };
  }
  const dropPushSub = endpoint => { st.subDel.run(String(endpoint || "")); return { dropped: true }; };
  const pushSubs = userId => st.subsFor.all(userId).map(r => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));

  /**
   * Кому пора напомнить и о чём. Вызывается планировщиком раз в пять минут.
   *
   * Два решения:
   *  - один раз в сутки, пачкой. Уведомление на каждую упаковку человек
   *    выключит после первой же ревизии аптечки;
   *  - «пора» = местное время перевалило за выбранное И сегодня ещё не
   *    рассылали. Не окно в пять минут: перезапуск контейнера в это окно
   *    не должен съедать напоминание за день.
   */
  function dueReminders(now = Date.now()) {
    const out = [];
    for (const p of st.allProfiles.all()) {
      const tz = validTz(p.tz) || DEFAULT_TZ;
      const day = dayIn(tz, now);
      if (p.notified_day === day) continue;
      const { remindAt, kinds } = notifySettings(p);
      if (timeIn(tz, now) < remindAt) continue;

      const items = { expired: [], expiring: [], openExpiring: [], low: [] };
      for (const hh of st.hhOf.all(p.user_id)) {
        const byId = new Map(st.itemList.all(hh.id).map(i => [i.id, pubItem(i)]));
        for (const pack of st.packList.all(hh.id)) {
          if (pack.status !== "have") continue;
          const item = byId.get(pack.item_id);
          if (!item) continue;
          const eff = X.effective({ expiresOn: pack.expires_on, openedOn: pack.opened_on }, item, day);
          const one = { packId: pack.id, name: item.name, dose: item.dose, on: eff.on, daysLeft: eff.daysLeft };
          let kind = null;
          if (eff.status === "expired") kind = "expired";
          else if (eff.source === "opened" && eff.daysLeft !== null && eff.daysLeft <= OPEN_DAYS) kind = "openExpiring";
          else if (eff.daysLeft !== null && eff.daysLeft <= EXPIRING_DAYS) kind = "expiring";
          if (kind && kinds[kind] && !st.notifiedHas.get(p.user_id, pack.id, kind)) items[kind].push(one);
          if (kinds.low && item.lowAt !== null && item.lowAt !== undefined && pack.qty <= item.lowAt
              && !st.notifiedHas.get(p.user_id, pack.id, "low")) items.low.push(one);
        }
      }
      const total = Object.values(items).reduce((n, a) => n + a.length, 0);
      out.push({ userId: p.user_id, tz, day, items, total });
    }
    return out;
  }

  /** Отметить, что об этих упаковках человеку уже сказали. */
  function markNotified(userId, day, items) {
    const now = Date.now();
    tx(() => {
      for (const [kind, list] of Object.entries(items || {})) {
        for (const x of list) st.notifiedIns.run(userId, x.packId, kind, now);
      }
      st.notifiedDay.run(day, now, userId);
    });
    return { marked: true };
  }

  return {
    db, KINDS, UNITS, dayIn, validTz, DEFAULT_TZ,
    me, ensureHousehold, assertMember,
    places, addPlace, renamePlace, deletePlace,
    items, addItem, updateItem, lookup, leafletFor: name => known({ name }),
    known, catalogPut, wantedAdd, wantedList, catalogSize: () => st.catCount.get().n,
    packs, summary, addPack, patchPack, deletePack, undoLast, history, shopping,
    importGuest, deleteUserData, purgeMissing, stats,
    // этап 4: дом и напоминания
    members, touchMember, renameHousehold, createHousehold, switchHousehold,
    invite, incomingInvites, outgoingInvites, acceptInvite, declineInvite, cancelInvite,
    leaveHousehold, removeMember,
    notifySettings, setNotify, settingsOf: userId => notifySettings(profile(userId)),
    addPushSub, dropPushSub, pushSubs, dueReminders, markNotified,
    NOTIFY_KINDS, EXPIRING_DAYS, OPEN_DAYS, timeIn,
  };
};
