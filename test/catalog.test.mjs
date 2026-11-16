// Общий каталог: что подтвердил один дом, достаётся остальным. Плюс
// доверие к источникам и очередь «чего не хватает».
//                                                node test/catalog.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const createStore = require("../lib/store.js");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};
const TZ = "Europe/Moscow";
const fresh = opts => createStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "zapas-")), ...opts });
const home = (s, u) => s.ensureHousehold(u, TZ).household.id;

{ // ради чего всё: один дом подтвердил — другой получил даром
  const s = fresh();
  const a = home(s, "аня"), b = home(s, "боря");

  const first = s.addPack("аня", a, { name: "Нурофен", dose: "200 мг", unit: "таб", qty: 20 });
  eq("первый дом ничего не знает", first.item.afterOpenDays, null);
  eq("и препарат попал в очередь «чего не хватает»", s.wantedList().map(w => w.name), ["Нурофен"]);

  // Аня сфотографировала вкладыш и подтвердила поля.
  s.catalogPut({ name: "Нурофен", dose: "200 мг", afterOpenDays: 28, storageMaxC: 25, rx: false,
    quotes: { afterOpenDays: "После вскрытия: не более 28 дней" } }, "photo");
  eq("из очереди убрался", s.wantedList().length, 0);

  const second = s.addPack("боря", b, { name: "нурофен", dose: "200 мг", unit: "таб", qty: 20 });
  eq("второй дом получил всё сам", [second.item.afterOpenDays, second.item.storageMaxC, second.item.rx], [28, 25, false]);
  eq("и ничего не просил добавить", s.wantedList().length, 0);
}

{ // каталог общий, но аптечки — нет
  const s = fresh();
  const a = home(s, "аня"), b = home(s, "боря");
  s.catalogPut({ name: "Нурофен", afterOpenDays: 28 }, "photo");
  s.addPack("аня", a, { name: "Нурофен", qty: 20 });
  eq("у бори пусто, хотя препарат знаком", s.packs("боря", b).length, 0);
  eq("а у ани одна упаковка", s.packs("аня", a).length, 1);
}

{ // вклад анонимен: в каталоге нет ни человека, ни дома
  const s = fresh();
  home(s, "аня");
  s.catalogPut({ name: "Нурофен", afterOpenDays: 28 }, "photo");
  const cols = s.db.prepare("PRAGMA table_info(catalog)").all().map(c => c.name);
  eq("нет колонки про пользователя", cols.some(c => /user|household|author|by/.test(c)), false);
  const wcols = s.db.prepare("PRAGMA table_info(wanted)").all().map(c => c.name);
  eq("и в очереди тоже", wcols.some(c => /user|household/.test(c)), false);
}

{ // доверие к источникам
  const leaflets = { "П N 1": { name: "Синупрет", afterOpenDays: 180, storageMaxC: 25, quotes: { afterOpenDays: "не более 6 месяцев" } } };
  const s = fresh({ leaflets });
  const h = home(s, "аня");

  eq("инструкция — главный источник", s.known({ name: "синупрет" }).source, "leaflet");
  s.catalogPut({ name: "Синупрет", afterOpenDays: 7 }, "photo");
  eq("снимок не перебивает инструкцию", s.known({ name: "Синупрет" }).afterOpenDays, 180);

  s.catalogPut({ name: "Отипакс", afterOpenDays: 28, storageMaxC: 25 }, "photo");
  s.catalogPut({ name: "Отипакс", afterOpenDays: 999 }, "user");
  eq("слова не перебивают снимок", s.known({ name: "Отипакс" }).afterOpenDays, 28);
  s.catalogPut({ name: "Отипакс", afterOpenDays: 60 }, "photo");
  eq("а снимок снимок — перебивает", s.known({ name: "Отипакс" }).afterOpenDays, 60);

  s.catalogPut({ name: "Пустой", storageMaxC: 25 }, "user");
  s.catalogPut({ name: "Пустой", afterOpenDays: 14 }, "user");
  eq("пустое поле дозаполняется", [s.known({ name: "Пустой" }).storageMaxC, s.known({ name: "Пустой" }).afterOpenDays], [25, 14]);
}

{ // совпавшие значения — это подтверждение
  const s = fresh();
  home(s, "аня");
  s.catalogPut({ name: "Аспирин", afterOpenDays: 30 }, "photo");
  eq("первое подтверждение", s.known({ name: "Аспирин" }).confirmations, 1);
  s.catalogPut({ name: "Аспирин", afterOpenDays: 30 }, "photo");
  eq("второй дом подтвердил то же самое", s.known({ name: "Аспирин" }).confirmations, 2);
  s.catalogPut({ name: "Аспирин", afterOpenDays: 45 }, "photo");
  eq("расхождение подтверждением не считается", s.known({ name: "Аспирин" }).confirmations, 2);
  eq("но значение обновилось", s.known({ name: "Аспирин" }).afterOpenDays, 45);
}

{ // дозировка различает препараты, код — находит
  const s = fresh();
  home(s, "аня");
  s.catalogPut({ name: "Нурофен", dose: "200 мг", afterOpenDays: 28, gtin: "4601234567893" }, "photo");
  s.catalogPut({ name: "Нурофен", dose: "400 мг", afterOpenDays: 60 }, "photo");
  eq("разные дозировки — разные записи", [s.known({ name: "Нурофен", dose: "200 мг" }).afterOpenDays,
    s.known({ name: "Нурофен", dose: "400 мг" }).afterOpenDays], [28, 60]);
  eq("по коду находится без названия", s.known({ gtin: "4601234567893" }).afterOpenDays, 28);
  eq("EAN-13 приводится к GTIN-14", s.known({ gtin: "04601234567893" }).afterOpenDays, 28);
}

{ // цитаты доезжают до карточки
  const s = fresh();
  home(s, "аня");
  s.catalogPut({ name: "Отипакс", afterOpenDays: 28, quotes: { afterOpenDays: "После вскрытия флакона: 28 дней" } }, "photo");
  eq("цитата сохранена", s.known({ name: "Отипакс" }).quotes.afterOpenDays, "После вскрытия флакона: 28 дней");
  eq("источник виден", s.known({ name: "Отипакс" }).source, "photo");
}

{ // очередь «чего не хватает»
  const s = fresh();
  const a = home(s, "аня"), b = home(s, "боря");
  s.addPack("аня", a, { name: "Редкий препарат", qty: 1 });
  s.addPack("боря", b, { name: "редкий препарат", qty: 1 });
  const list = s.wantedList();
  eq("один препарат, спрошен дважды", [list.length, list[0].asked], [1, 2]);
  eq("название сохранено как ввели первым", list[0].name, "Редкий препарат");
  s.catalogPut({ name: "Редкий препарат", afterOpenDays: 10 }, "photo");
  eq("после пополнения каталога очередь пуста", s.wantedList().length, 0);
}

{ // мусор в каталог не попадает
  const s = fresh();
  home(s, "аня");
  eq("без названия", s.catalogPut({ afterOpenDays: 10 }, "photo"), null);
  eq("неизвестный источник", s.catalogPut({ name: "Х", afterOpenDays: 10 }, "откуда-то"), null);
  eq("каталог пуст", s.catalogSize(), 0);
}

{ /* Ярлыки НЕ уезжают в общий каталог. Это и подсказка, которую сервис не
     вправе давать («от головы» от сервиса — уже показание к применению), и
     утечка: по «от давления» и «для Маши» читается слишком много. */
  const s = fresh();
  home(s, "аня");
  s.catalogPut({ name: "Цитрамон", afterOpenDays: 28, tags: ["от головы", "для Маши"] }, "photo");
  const cols = s.db.prepare("PRAGMA table_info(catalog)").all().map(c => c.name);
  eq("в каталоге нет колонки ярлыков", cols.includes("tags"), false);
  eq("и в ответе справочника их нет", s.known({ name: "Цитрамон" }).tags, undefined);
  eq("и в сохранённом JSON их не найти",
    /от головы|для Маши/.test(JSON.stringify(s.db.prepare("SELECT * FROM catalog").all())), false);

  // Инструкция ярлыков тоже не подставляет — их там и не бывает.
  const s2 = fresh({ leaflets: { "П N 1": { name: "Цитрамон", afterOpenDays: 28 } } });
  const hid = home(s2, "u");
  const p = s2.addPack("u", hid, { name: "Цитрамон", qty: 1 });
  eq("из инструкции приехал срок после вскрытия", p.item.afterOpenDays, 28);
  eq("а ярлыков нет", p.item.tags, []);

  // И из общего каталога тоже: пришло из него только то, что мы туда писали.
  const s3 = fresh();
  home(s3, "аня");
  s3.catalogPut({ name: "Цитрамон", afterOpenDays: 28, tags: ["от головы"] }, "photo");
  const hid3 = home(s3, "боря");
  eq("другому дому ярлыки не достались", s3.addPack("боря", hid3, { name: "Цитрамон", qty: 1 }).item.tags, []);
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
