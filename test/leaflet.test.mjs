// Главное свойство этапа 3: в справочник попадает только то, чью цитату
// удалось найти в самом документе. Без сети и без GigaChat.
//                                                  node test/leaflet.test.mjs
import { normalize, quoteFound, pdfText } from "../tools/pdftext.mjs";
import { verify } from "../tools/leaflet.mjs";

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};

// Кусок настоящей инструкции — с переносом внутри слова, как в PDF.
const DOC = `Регистрационный номер: П N 014247/01 Торговое наименование: Синупрет ®
Лекарственная форма: капли для приема внутрь
Условия хранения Хранить в оригинальной упаковке (флакон темного стекла,
пачка картонная), при темпе - ратуре не выше 25 °С. Хранить в недоступном
для детей месте! Срок годности 3 года. После вскрытия флакона: не более 6
месяцев. Условия отпуска Отпускают без рецепта.`;

{ // поиск цитаты
  eq("цитата как есть", quoteFound("После вскрытия флакона: не более 6 месяцев.", DOC), true);
  eq("другие пробелы и переводы строк", quoteFound("Срок   годности\n3 года", DOC), true);
  eq("перенос внутри слова склеен", quoteFound("при температуре не выше 25 °С", DOC), true);
  eq("мягкий перенос не мешает", quoteFound("при темпе­ратуре не выше 25", DOC), true);
  eq("другой регистр", quoteFound("ОТПУСКАЮТ БЕЗ РЕЦЕПТА", DOC), true);
  eq("выдуманная цитата", quoteFound("После вскрытия флакона: не более 3 месяцев.", DOC), false);
  eq("слишком короткая, чтобы что-то доказывать", quoteFound("3 года", DOC), false);
  eq("пусто", [quoteFound("", DOC), quoteFound(null, DOC)], [false, false]);
  eq("нормализация склеивает перенос", normalize("темпе - ратуре"), "температуре");
}

{ // отбор полей
  const ok = verify({
    name: "Синупрет", nameQuote: "Торговое наименование: Синупрет ®",
    regNumber: "П N 014247/01", regNumberQuote: "Регистрационный номер: П N 014247/01",
    form: "капли для приема внутрь", formQuote: "Лекарственная форма: капли для приема внутрь",
    afterOpenValue: 6, afterOpenValueQuote: "После вскрытия флакона: не более 6 месяцев.",
    afterOpenUnit: "месяцев", afterOpenUnitQuote: "После вскрытия флакона: не более 6 месяцев.",
    storageMaxC: 25, storageMaxCQuote: "при температуре не выше 25 °С",
    rx: false, rxQuote: "Отпускают без рецепта",
    mnn: null, mnnQuote: null,
  }, DOC);
  // Порядок ключей значения не имеет: afterOpenDays считается после разбора.
  const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  eq("всё подтверждённое прошло", sorted(ok.fields), sorted(
    { name: "Синупрет", regNumber: "П N 014247/01", form: "капли для приема внутрь", afterOpenDays: 180, storageMaxC: 25, rx: false }));
  eq("ничего не отброшено", ok.rejected.length, 0);
  eq("цитаты сохранены", Object.keys(ok.quotes).length, 6);
  eq("отсутствующее поле просто отсутствует", "mnn" in ok.fields, false);
}

{ // выдумка не проходит — это и есть весь смысл
  const bad = verify({
    name: "Синупрет", nameQuote: "Торговое наименование: Синупрет ®",
    afterOpenValue: 28, afterOpenValueQuote: "После вскрытия флакона: не более 28 дней.",
    afterOpenUnit: "дней", afterOpenUnitQuote: "После вскрытия флакона: не более 28 дней.",
    storageMaxC: 15, storageMaxCQuote: null,
    rx: true, rxQuote: "Отпускают по рецепту",
  }, DOC);
  eq("прошло только название", Object.keys(bad.fields), ["name"]);
  eq("выдуманный срок отброшен вместе с единицей", bad.rejected.map(r => [r.key, r.why]), [
    ["afterOpenValue", "цитаты нет в документе"],
    ["afterOpenUnit", "цитаты нет в документе"],
    ["storageMaxC", "цитата не приведена"],
    ["rx", "цитаты нет в документе"],
  ]);
}

{ // пересчёт единиц делает код, а не модель
  const good = verify({
    name: "Синупрет", nameQuote: "Торговое наименование: Синупрет ®",
    afterOpenValue: 6, afterOpenUnit: "месяцев", afterOpenValueQuote: "После вскрытия флакона: не более 6 месяцев.",
    afterOpenUnitQuote: "После вскрытия флакона: не более 6 месяцев.",
  }, DOC);
  eq("«6 месяцев» стало 180 днями", good.fields.afterOpenDays, 180);
  eq("сырые поля не утекли наружу", ["afterOpenValue" in good.fields, "afterOpenUnit" in good.fields], [false, false]);
  eq("цитата закреплена за итоговым полем", good.quotes.afterOpenDays, "После вскрытия флакона: не более 6 месяцев.");

  const noUnit = verify({
    afterOpenValue: 6, afterOpenValueQuote: "После вскрытия флакона: не более 6 месяцев.",
  }, DOC);
  eq("без единицы поля нет", noUnit.fields.afterOpenDays, undefined);
  eq("и это названо причиной", noUnit.rejected.map(r => r.why), ["не понял единицу срока"]);
}

{ // цитата верная, а значение — не число
  const odd = verify({ afterOpenValue: "полгода", afterOpenUnit: "месяцев",
    afterOpenValueQuote: "После вскрытия флакона: не более 6 месяцев.",
    afterOpenUnitQuote: "После вскрытия флакона: не более 6 месяцев." }, DOC);
  eq("нечисловой срок не проходит",
    [odd.fields.afterOpenDays, odd.rejected.find(r => r.key === "afterOpenDays").why],
    [undefined, "срок не число"]);
}

{ // скан: текста нет — сверять не с чем, значит ничего и не берём
  const scan = verify({ name: "Что-то", nameQuote: "Что-то" }, "");
  eq("из пустого документа не выходит ничего", scan.fields, {});
}

{ // извлекатель PDF: на не-PDF не падает
  eq("мусор вместо PDF", pdfText(Buffer.from("не pdf вовсе")), "");
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
