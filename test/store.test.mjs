// Хранилище: дом, места, позиции, упаковки, журнал, отмена, перенос гостя.
// Без сети и без auth — store.js напрямую на временной базе.
//                                                  node test/store.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const createStore = require("../lib/store.js");
const X = require("../assets/expiry.js");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};
const throws = (name, fn, code) => {
  try { fn(); fails++; console.log(`FAIL ${name}: не бросило`); }
  catch (e) { eq(name, e.code, code); }
};

const TZ = "Europe/Moscow";
const fresh = () => createStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "zapas-")) });
/** Дом человека u: создаётся сам при первом обращении. */
const home = (s, u = "u") => s.ensureHousehold(u, TZ).household.id;
const today = () => new Date().toLocaleDateString("sv-SE");
/** Месяц, до конца которого n месяцев: удобнее, чем вычислять даты в каждом тесте. */
function monthIn(n) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}
/** Месяц, который сегодня попадает в нужное состояние. Прямо брать monthIn(2)
 *  нельзя: в начале месяца конец «через два месяца» уезжает за 90 дней, и тест
 *  разваливался бы раз в месяц по календарю, а не по коду. */
function monthWithStatus(want) {
  for (let n = -2; n <= 36; n++) {
    const m = monthIn(n);
    if (X.statusOf(X.diffDays(today(), X.endOfMonth(m))) === want) return m;
  }
  throw new Error("не нашёл месяц для состояния " + want);
}

{ // первый заход
  const s = fresh();
  const me = s.me("u", TZ);
  eq("дом создаётся сам", me.household.name, "Мой дом");
  eq("роль владельца", me.household.role, "owner");
  eq("одно место по умолчанию", me.places.map(p => p.name), ["Аптечка"]);
  eq("сводка пуста", [me.summary.total, me.summary.expired], [0, 0]);
  eq("пояс запомнили", me.tz, TZ);
}

{ // чужой дом недоступен
  const s = fresh();
  const hid = home(s, "u");
  throws("чужой дом — 403", () => s.packs("другой", hid), "not_member");
  throws("несуществующий дом — 403", () => s.places("u", "нет-такого"), "not_member");
}

{ // добавление: позиция и упаковка
  const s = fresh(), hid = home(s);
  const p = s.addPack("u", hid, { name: "Ибупрофен", dose: "200 мг", unit: "таб", qty: 20, expiresOn: monthIn(6) });
  eq("упаковка добавлена", [p.item.name, p.qty, p.status], ["Ибупрофен", 20, "have"]);
  eq("позиция создана заодно", s.items("u", hid).length, 1);
  eq("состояние — в запасе", p.expiry.status, "ok");

  s.addPack("u", hid, { name: "ибупрофен", dose: "200 мг", qty: 10 });
  eq("то же название в другом регистре — та же позиция", s.items("u", hid).length, 1);
  s.addPack("u", hid, { name: "Ибупрофен", dose: "400 мг", qty: 10 });
  eq("другая дозировка — другая позиция", s.items("u", hid).length, 2);
  eq("упаковок три", s.packs("u", hid).length, 3);
  eq("без названия не добавляется", s.addPack("u", hid, { qty: 1 }), null);
}

{ // rid: повтор из очереди не плодит упаковки
  const s = fresh(), hid = home(s);
  const a = s.addPack("u", hid, { name: "Парацетамол", qty: 10, rid: "abcd1234efgh" });
  const b = s.addPack("u", hid, { name: "Парацетамол", qty: 10, rid: "abcd1234efgh" });
  eq("повтор вернул ту же упаковку", a.id, b.id);
  eq("упаковка одна", s.packs("u", hid).length, 1);
}

{ // срок и вскрытие
  const s = fresh(), hid = home(s);
  const p = s.addPack("u", hid, { name: "Отипакс", unit: "мл", qty: 16, expiresOn: monthIn(24), afterOpenDays: 28 });
  eq("пока не вскрыто — далёкий срок", p.expiry.status, "ok");
  const opened = s.patchPack("u", hid, p.id, { action: "open" });
  eq("вскрытие пересчитало срок", [opened.expiry.source, opened.expiry.status], ["opened", "urgent"]);
  eq("дата вскрытия — сегодня", opened.openedOn, today());
  eq("ожидаемая дата", opened.expiry.on, X.addDays(today(), 28));
  const back = s.patchPack("u", hid, p.id, { action: "unopen" });
  eq("вскрытие по ошибке снимается", [back.openedOn, back.expiry.source], [null, "printed"]);
}

{ // взять
  const s = fresh(), hid = home(s);
  const p = s.addPack("u", hid, { name: "Аспирин", unit: "таб", qty: 10, expiresOn: monthIn(12) });
  const a = s.patchPack("u", hid, p.id, { action: "take", qty: 2 });
  eq("остаток уменьшился", a.qty, 8);
  eq("взяли — значит вскрыли", a.openedOn, today());
  const b = s.patchPack("u", hid, p.id, { action: "take", qty: 8 });
  eq("добрали до нуля — закончилось", [b.qty, b.status], [0, "used"]);
  eq("в списке «что есть» её больше нет", s.packs("u", hid).length, 0);
  eq("в полном списке — есть", s.packs("u", hid, { status: "all" }).length, 1);
  const c = s.patchPack("u", hid, p.id, { action: "restore" });
  eq("вернули в запас — остаток восстановлен из размера упаковки", [c.status, c.qty > 0], ["have", true]);
}

{ // половина таблетки
  const s = fresh(), hid = home(s);
  const p = s.addPack("u", hid, { name: "Эутирокс", unit: "таб", qty: 1 });
  eq("дробный остаток", s.patchPack("u", hid, p.id, { action: "take", qty: 0.5 }).qty, 0.5);
}

{ // отмена
  const s = fresh(), hid = home(s);
  const p = s.addPack("u", hid, { name: "Нурофен", unit: "мл", qty: 100 });
  s.patchPack("u", hid, p.id, { action: "take", qty: 30 });
  const u1 = s.undoLast("u", hid);
  eq("отмена вернула остаток", [u1.undone, u1.pack.qty], ["take", 100]);
  s.patchPack("u", hid, p.id, { action: "discard" });
  const u2 = s.undoLast("u", hid);
  eq("отмена выбрасывания", [u2.undone, u2.pack.status], ["discard", "have"]);
  eq("отменять больше нечего", s.undoLast("u", hid), null);
}

{ // места
  const s = fresh(), hid = home(s);
  const bag = s.addPlace("u", hid, { name: "Дорожная сумка" });
  eq("место добавлено", bag.name, "Дорожная сумка");
  eq("пустое название не проходит", s.addPlace("u", hid, { name: "   " }), null);
  const p = s.addPack("u", hid, { name: "Пластырь", qty: 10, placeId: bag.id });
  eq("упаковка легла в место", p.placeId, bag.id);
  eq("счётчик места", s.places("u", hid).find(x => x.id === bag.id).packs, 1);
  eq("фильтр по месту", s.packs("u", hid, { placeId: bag.id }).length, 1);
  s.renamePlace("u", hid, bag.id, "Рюкзак");
  eq("переименование", s.places("u", hid).find(x => x.id === bag.id).name, "Рюкзак");
  s.deletePlace("u", hid, bag.id);
  eq("место удалено", s.places("u", hid).length, 1);
  eq("упаковка осталась, но без места", s.packs("u", hid).map(x => x.placeId), [null]);
}

{ // сводка и подсветка
  const s = fresh(), hid = home(s);
  s.addPack("u", hid, { name: "Просрочка", qty: 1, expiresOn: monthIn(-2) });
  s.addPack("u", hid, { name: "Горит", qty: 1, expiresOn: monthWithStatus("urgent") });
  s.addPack("u", hid, { name: "Скоро", qty: 1, expiresOn: monthWithStatus("soon") });
  s.addPack("u", hid, { name: "Запас", qty: 1, expiresOn: monthIn(24) });
  s.addPack("u", hid, { name: "Без срока", qty: 1 });
  const sum = s.summary("u", hid);
  eq("сводка по состояниям", [sum.total, sum.expired, sum.urgent, sum.unknown], [5, 1, 1, 1]);
  eq("истёкшее — первым в списке", s.packs("u", hid)[0].item.name, "Просрочка");
}

{ // что докупить
  const s = fresh(), hid = home(s);
  const out = s.addPack("u", hid, { name: "Кончилось", unit: "таб", qty: 2 });
  s.patchPack("u", hid, out.id, { action: "take", qty: 2 });
  s.addPack("u", hid, { name: "Просрочено", qty: 1, expiresOn: monthIn(-1) });
  s.addPack("u", hid, { name: "Мало", unit: "таб", qty: 3, lowAt: 4 });
  s.addPack("u", hid, { name: "Нормально", unit: "таб", qty: 30, expiresOn: monthIn(12) });
  const list = s.shopping("u", hid);
  eq("три причины, в порядке срочности", list.map(x => [x.item.name, x.reason]),
    [["Кончилось", "out"], ["Просрочено", "expired"], ["Мало", "low"]]);
}

{ // журнал
  const s = fresh(), hid = home(s);
  const p = s.addPack("u", hid, { name: "Левомеколь", unit: "г", qty: 40 });
  s.patchPack("u", hid, p.id, { action: "take", qty: 5 });
  s.patchPack("u", hid, p.id, { action: "discard" });
  eq("журнал в обратном порядке", s.history("u", hid, p.id).map(e => e.kind), ["discard", "take", "add"]);
  eq("сколько взяли — записано", s.history("u", hid, p.id)[1].qty, 5);
}

{ // перенос гостевой аптечки
  const s = fresh();
  const guest = {
    places: [{ id: "g1", name: "Шкафчик" }],
    items: [{ id: "i1", name: "Цитрамон", dose: "500 мг", unit: "таб" }],
    packs: [{ itemId: "i1", placeId: "g1", qty: 6, expiresOn: monthIn(8) }],
  };
  const r = s.importGuest("u", guest, TZ);
  eq("перенос прошёл", [r.imported, r.places, r.items, r.packs], [true, 1, 1, 1]);
  const hid = home(s);
  eq("места на месте", s.places("u", hid).map(p => p.name), ["Аптечка", "Шкафчик"]);
  eq("упаковка на месте", s.packs("u", hid).map(p => [p.item.name, p.qty]), [["Цитрамон", 6]]);
  eq("второй раз не переносим", s.importGuest("u", guest, TZ).reason, "already");
  eq("аптечка не удвоилась", s.packs("u", hid).length, 1);
}

{ // сканирование: поиск по коду
  const s = fresh(), hid = home(s);
  eq("незнакомый код", (() => { const r = s.lookup("u", hid, { gtin: "04601234567893" });
    return [r.gtin, r.item, r.source]; })(), ["04601234567893", null, null]);

  s.addPack("u", hid, { name: "Ибупрофен", dose: "200 мг", unit: "таб", qty: 20, gtin: "4601234567893" });
  const known = s.lookup("u", hid, { gtin: "4601234567893" });
  eq("EAN-13 и GTIN-14 — один и тот же товар", [known.source, known.item.name], ["household", "Ибупрофен"]);
  eq("код записан в позицию нормализованным", known.item.gtin, "04601234567893");
  eq("второй скан того же кода не плодит позицию",
    (s.addPack("u", hid, { gtin: "04601234567893", qty: 10 }), s.items("u", hid).length), 1);
  eq("а упаковок стало две", s.packs("u", hid).length, 2);
  eq("без названия и без знакомого кода не добавляем", s.addPack("u", hid, { gtin: "00000000000000", qty: 1 }), null);
}

{ // сканирование: справочник сервиса
  const bank = { "04601234567893": { name: "Синупрет", form: "капли для приема внутрь", afterOpenDays: 180, storageMaxC: 25 } };
  const s = createStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "zapas-")), bank });
  const hid = home(s);
  const look = s.lookup("u", hid, { gtin: "04601234567893" });
  eq("код нашёлся в справочнике", [look.source, look.item.name, look.item.afterOpenDays], ["bank", "Синупрет", 180]);
  const p = s.addPack("u", hid, { gtin: "04601234567893", qty: 100, expiresOn: monthIn(24) });
  eq("позиция создана по справочнику", [p.item.name, p.item.afterOpenDays, p.item.storageMaxC], ["Синупрет", 180, 25]);
  eq("источник отмечен", p.item.source, "leaflet");
  const opened = s.patchPack("u", hid, p.id, { action: "open" });
  eq("срок после вскрытия приехал из справочника", opened.expiry.source, "opened");
}

{ // сканирование: дедуп по серийному номеру
  const s = fresh(), hid = home(s);
  const ser = "ABC1234567890";
  const a = s.addPack("u", hid, { name: "Отипакс", unit: "мл", qty: 16, gtin: "4601234567893", serial: ser });
  const b = s.addPack("u", hid, { name: "Отипакс", unit: "мл", qty: 16, gtin: "4601234567893", serial: ser });
  eq("та же коробка — та же запись", [a.id === b.id, b.duplicate], [true, true]);
  eq("упаковка одна", s.packs("u", hid).length, 1);
  const c = s.addPack("u", hid, { name: "Отипакс", unit: "мл", qty: 16, gtin: "4601234567893", serial: "ZZZ9999999999" });
  eq("другая коробка того же препарата — вторая запись", [c.id !== a.id, s.packs("u", hid).length], [true, 2]);
  eq("позиция по-прежнему одна", s.items("u", hid).length, 1);
  const found = s.lookup("u", hid, { gtin: "4601234567893", serial: ser });
  eq("поиск по серийному находит коробку", found.existingPack.id, a.id);
}

{ // серийные номера разных домов не мешают друг другу
  const s = fresh();
  const h1 = home(s, "аня"), h2 = home(s, "боря");
  const ser = "SAME000000001";
  const a = s.addPack("аня", h1, { name: "Аспирин", qty: 10, serial: ser });
  const b = s.addPack("боря", h2, { name: "Аспирин", qty: 10, serial: ser });
  eq("одинаковый серийный в двух домах — две разные упаковки", a.id !== b.id, true);
  eq("чужую упаковку поиск не отдаёт", s.lookup("боря", h2, { serial: ser }).existingPack.id, b.id);
  eq("у каждого дома своя", [s.packs("аня", h1).length, s.packs("боря", h2).length], [1, 1]);
}

{ // подсказка из официальной инструкции (bank/leaflets.json)
  const leaflets = {
    "П N 014247/01": { name: "Синупрет", form: "капли для приема внутрь", afterOpenDays: 180, storageMaxC: 25, rx: false,
      quotes: { afterOpenDays: "После вскрытия флакона: не более 6 месяцев." } },
  };
  const s = createStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "zapas-")), leaflets });
  const hid = home(s);

  const p = s.addPack("u", hid, { name: "синупрет", unit: "мл", qty: 100, expiresOn: monthIn(24) });
  eq("срок после вскрытия подставился из инструкции", p.item.afterOpenDays, 180);
  eq("условия хранения и рецептурность тоже", [p.item.storageMaxC, p.item.rx], [25, false]);
  eq("источник отмечен", p.item.source, "leaflet");
  const opened = s.patchPack("u", hid, p.id, { action: "open" });
  eq("и срок сразу пересчитался по вскрытию", opened.expiry.source, "opened");

  // Введённое руками важнее: человек смотрит на свою упаковку.
  const own = s.addPack("u", hid, { name: "Синупрет", dose: "другая серия", qty: 50, afterOpenDays: 30 });
  eq("своё значение не затирается справочником", own.item.afterOpenDays, 30);

  // Похожее название — не то же самое лекарство.
  const other = s.addPack("u", hid, { name: "Синупрет Форте", qty: 20 });
  eq("нестрогого совпадения нет", other.item.afterOpenDays, null);
  eq("поиск по названию", [s.leafletFor("СИНУПРЕТ®").afterOpenDays, s.leafletFor("Нурофен")], [180, null]);
}

{ // удаление данных
  const s = fresh();
  const hid = home(s, "u");
  s.addPack("u", hid, { name: "Что-то", qty: 1 });
  const r = s.deleteUserData("u");
  eq("дом из одного удаляется целиком", [r.deleted, r.households], [true, 1]);
  eq("данных не осталось", s.stats().packs, 0);
  eq("после удаления заходим как новый", s.me("u", TZ).places.map(p => p.name), ["Аптечка"]);
}

{ // уборка аккаунтов, удалённых в Auth
  const s = fresh();
  home(s, "жив");
  home(s, "удалён");
  eq("живых не трогаем", s.purgeMissing(new Set(["жив", "удалён"])).purged, 0);
  eq("первый проход только помечает", s.purgeMissing(new Set(["жив"])).purged, 0);
  eq("оба профиля на месте", s.stats().users, 2);
  // Отсрочка в сутки — чтобы сбой Auth не стирал данные; подменяем время.
  s.db.prepare("UPDATE purge_pending SET since = ?").run(Date.now() - 48 * 3600 * 1000);
  eq("через сутки стираем", s.purgeMissing(new Set(["жив"])).purged, 1);
  eq("остался один", s.stats().users, 1);
}

{ // ярлыки: пометки человека на препарате
  const s = fresh();
  const hid = home(s);
  const p = s.addPack("u", hid, { name: "Цитрамон", qty: 10, tags: ["От головы", "от головы", "детское"] });
  eq("ярлыки сохранились без дублей", p.item.tags, ["От головы", "детское"]);
  eq("ярлык — свойство позиции, а не упаковки", s.items("u", hid)[0].tags, ["От головы", "детское"]);

  // Фильтр: вот зачем всё это и заводилось.
  eq("фильтр по ярлыку", s.packs("u", hid, { tag: "от головы" }).length, 1);
  eq("регистр в фильтре не важен", s.packs("u", hid, { tag: "ОТ ГОЛОВЫ" }).length, 1);
  eq("чужой ярлык ничего не находит", s.packs("u", hid, { tag: "от живота" }).length, 0);
  eq("без фильтра всё на месте", s.packs("u", hid).length, 1);

  /* Вторая коробка того же препарата с новым ярлыком. Позиция та же, но
     вписанное сейчас терять нельзя — человек дописывает ярлык ровно в тот
     момент, когда об этом подумал. */
  const p2 = s.addPack("u", hid, { name: "Цитрамон", qty: 10, tags: ["от температуры"] });
  eq("ярлыки дописались, а не заменились", p2.item.tags, ["От головы", "детское", "от температуры"]);
  eq("позиция всё ещё одна", s.items("u", hid).length, 1);
  eq("старый ярлык работает", s.packs("u", hid, { tag: "детское" }).length, 2);

  // Убрать ярлык можно только явно — правкой позиции.
  const id = s.items("u", hid)[0].id;
  eq("правка убирает ярлык", s.updateItem("u", hid, id, { tags: ["детское"] }).tags, ["детское"]);
  eq("и фильтр это видит", s.packs("u", hid, { tag: "от головы" }).length, 0);
  eq("все ярлыки убрать тоже можно", s.updateItem("u", hid, id, { tags: [] }).tags, []);

  eq("мусор вместо списка — просто нет ярлыков",
    s.addPack("u", hid, { name: "Левомеколь", qty: 1, tags: { ой: 1 } }).item.tags, []);
  eq("битый JSON в базе не роняет список", (() => {
    s.db.prepare("UPDATE items SET tags = '{не json' WHERE id = ?").run(id);
    return s.items("u", hid).find(i => i.id === id).tags;
  })(), []);
}

{ // перенос гостевой аптечки: ярлыки переезжают вместе с позицией
  const s = fresh();
  const r = s.importGuest("u", {
    places: [{ id: "g1", name: "Сумка" }],
    items: [{ id: "i1", name: "Цитрамон", tags: ["от головы", "ОТ ГОЛОВЫ"] }],
    packs: [{ itemId: "i1", placeId: "g1", qty: 10 }],
  }, TZ);
  eq("перенос прошёл", [r.imported, r.packs], [true, 1]);
  const hid = home(s, "u");
  eq("ярлыки на месте и без дублей", s.items("u", hid)[0].tags, ["от головы"]);
  eq("фильтр работает сразу после переноса", s.packs("u", hid, { tag: "от головы" }).length, 1);
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
