// Разбор кода с упаковки: DataMatrix МДЛП, EAN-13, контрольная цифра.
// Без базы и без камеры — чистые функции.            node test/gs1.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const G = require("../assets/gs1.js");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};
const GS = G.GS;
/** Контрольная цифра у него настоящая, проверено отдельным тестом ниже. */
const EAN = "4601234567893";
const GTIN = "04601234567893";
const SER = "ABC1234567890";          // 13 знаков, как в МДЛП
const CRYPTO = `91EE10${GS}92dGVzdF9zaWduYXR1cmU=`;
const short = r => [r.ok, r.gtin, r.serial, r.expiresOn];

{ // контрольная цифра
  eq("EAN-13 с верной цифрой", G.checkDigitOk(EAN), true);
  eq("известный пример GS1", G.checkDigitOk("5901234123457"), true);
  eq("испорченная цифра", G.checkDigitOk("4601234567894"), false);
  eq("GTIN-14", G.checkDigitOk(GTIN), true);
  eq("EAN-8", G.checkDigitOk("96385074"), true);
  eq("не та длина", G.checkDigitOk("460123456789"), false);
  eq("буквы", G.checkDigitOk("46012345678AB"), false);
}

{ // приведение к GTIN-14 — иначе одна коробка даст две позиции
  eq("EAN-13 → GTIN-14", G.toGtin14(EAN), GTIN);
  eq("EAN-8 → GTIN-14", G.toGtin14("96385074"), "00000096385074");
  eq("уже GTIN-14", G.toGtin14(GTIN), GTIN);
  eq("слишком длинный", G.toGtin14("123456789012345"), null);
}

{ // линейный штрихкод с гигиены
  eq("EAN-13 как есть", short(G.parse(EAN, "ean_13")), [true, GTIN, null, null]);
  eq("формат не передали — узнаём по длине", short(G.parse(EAN)), [true, GTIN, null, null]);
  eq("контрольная цифра посчитана", G.parse(EAN, "ean_13").checkDigit, true);
}

{ // DataMatrix МДЛП — то, что на коробке лекарства
  const code = `01${GTIN}21${SER}${GS}${CRYPTO}`;
  eq("разделители на месте", short(G.parse(code, "data_matrix")), [true, GTIN, SER, null]);
  eq("крипто-хвост не мешает", G.parse(code, "data_matrix").extra["91"], "EE10");

  // Сканеры, теряющие \x1d, — обычное дело. Серийный в МДЛП ровно 13 знаков.
  const noGs = `01${GTIN}21${SER}91EE10`;
  eq("без разделителя режем по длине серийного", short(G.parse(noGs, "data_matrix")), [true, GTIN, SER, null]);

  eq("префикс символики ]d2 снят", short(G.parse(`]d2${code}`, "data_matrix")), [true, GTIN, SER, null]);
  eq("разделитель в виде {GS}", short(G.parse(`01${GTIN}21${SER}{GS}91EE10`, "data_matrix")), [true, GTIN, SER, null]);
  eq("серийный до конца строки", short(G.parse(`01${GTIN}21${SER}`, "data_matrix")), [true, GTIN, SER, null]);
}

{ // срок, если он всё-таки есть (импорт, непрепараты)
  eq("17 → месяц", short(G.parse(`01${GTIN}17251231`, "data_matrix")), [true, GTIN, null, "2025-12"]);
  eq("день «00» — конец месяца", G.parse(`01${GTIN}17260100`, "data_matrix").expiresOn, "2026-01");
  eq("13-й месяц — не срок", G.parse(`01${GTIN}17251331`, "data_matrix").expiresOn, null);
  eq("срок и серийный вместе",
    short(G.parse(`01${GTIN}17270630${GS}21${SER}`, "data_matrix")), [true, GTIN, SER, "2027-06"]);
  eq("номер партии", G.parse(`01${GTIN}10LOT42${GS}21${SER}`, "data_matrix").batch, "LOT42");
}

{ // что считается непригодным
  eq("пусто", [G.parse("", "data_matrix").ok, G.parse("").reason], [false, "empty"]);
  eq("ссылка вместо кода", G.parse("https://example.com/x", "qr_code").reason, "not_digits");
  eq("без GTIN", G.parse(`21${SER}${GS}91EE10`, "data_matrix").reason, "no_gtin");
  eq("обрезанный код", G.parse("010460123", "data_matrix").reason, "truncated");
  eq("у каждой причины есть объяснение",
    ["empty", "not_digits", "bad_ai", "truncated", "no_gtin"].every(r => typeof G.WHY[r] === "string"), true);
}

{ // подделанная контрольная цифра — код читаем, но товар подозрительный
  const bad = `0104601234567894` + `21${SER}`;
  const r = G.parse(bad, "data_matrix");
  eq("GTIN разобран, но цифра не сошлась", [r.ok, r.checkDigit], [true, false]);
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
