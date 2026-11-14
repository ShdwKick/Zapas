"use strict";
/**
 * Разбор того, что вернула камера. Общий файл сервера и браузера — как
 * expiry.js: нормализовать код в двух местах по-разному значит однажды
 * получить две разные упаковки из одной коробки.
 *
 * Что реально напечатано на российской упаковке лекарства (ARCHITECTURE.md,
 * «Сканирование») — DataMatrix МДЛП:
 *
 *     01 <GTIN-14> 21 <серийный> 91 <ключ> 92 <подпись>
 *
 * Ни названия, ни срока годности там нет. Поэтому от разбора нужно ровно
 * три вещи: GTIN (тождество препарата), серийный номер (тождество ЭТОЙ
 * коробки, чтобы не добавить её дважды) и срок — если он вдруг есть, а он
 * бывает на импорте и на непрепаратах.
 *
 * Обычный EAN-13 с гигиены и бытовой химии — тоже сюда: он просто
 * дополняется нулями слева до GTIN-14, и дальше всё одинаково.
 */
(function (root) {
  /** Разделитель переменных полей (FNC1). Сканеры отдают его как \x1d. */
  const GS = "\x1d";

  /**
   * Длины полей фиксированной длины — без двух цифр самого AI.
   * Только то, что встречается на упаковках; остальное уйдёт в «хвост».
   */
  const FIXED = {
    "00": 18, "01": 14, "02": 14,
    11: 6, 12: 6, 13: 6, 15: 6, 16: 6, 17: 6,
    20: 2,
  };
  /** Переменные поля и их потолок по стандарту. */
  const VAR_MAX = { 10: 20, 21: 20, 22: 20, 30: 8, 37: 8, 90: 30, 91: 90, 92: 90, 93: 90, 94: 90, 95: 90, 96: 90, 97: 90, 98: 90, 99: 90 };

  /** Длина серийного номера в коде МДЛП — нужна для кодов без разделителя. */
  const MDLP_SERIAL = 13;

  const digits = s => /^\d+$/.test(s);

  /** Контрольная цифра GTIN/EAN (mod 10). Для 8, 12, 13 и 14 знаков. */
  function checkDigitOk(code) {
    if (!digits(code) || ![8, 12, 13, 14].includes(code.length)) return false;
    const body = code.slice(0, -1), want = Number(code.slice(-1));
    let sum = 0;
    // Вес чередуется с конца тела: 3, 1, 3, 1…
    for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
    return (10 - (sum % 10)) % 10 === want;
  }

  /** EAN-8/UPC-A/EAN-13 → GTIN-14: слева нулями. Сравнивать можно только так. */
  function toGtin14(code) {
    if (!digits(code) || code.length > 14) return null;
    return code.padStart(14, "0");
  }

  /** '251231' → '2025-12'. День игнорируем: храним месяц (см. expiry.js). */
  function ymFrom6(s) {
    if (!digits(s) || s.length !== 6) return null;
    const yy = Number(s.slice(0, 2)), mm = Number(s.slice(2, 4));
    if (mm < 1 || mm > 12) return null;
    // GS1: двузначный год читается в окне ±50 лет от текущего. До 2050-го
    // это просто 20YY, и писать сложнее, чем есть, смысла нет.
    return `20${String(yy).padStart(2, "0")}-${String(mm).padStart(2, "0")}`;
  }

  /**
   * Разбирает то, что отдал детектор.
   * raw   — строка из BarcodeDetector.rawValue
   * format — 'data_matrix' | 'ean_13' | … (как его называет BarcodeDetector)
   *
   * Возвращает { gtin, serial, expiresOn, batch, ok, reason, extra } —
   * gtin всегда в виде GTIN-14 или null.
   */
  function parse(raw, format) {
    if (typeof raw !== "string" || !raw) return fail("empty");
    // Некоторые сканеры добавляют префикс символики: ]d2 — DataMatrix,
    // ]E0 — EAN-13. Для нас это шум.
    let s = raw.replace(/^\][A-Za-z]\d/, "");
    // Разделитель приходит и как настоящий \x1d, и как печатные «{GS}»/«<GS>»
    // в тех сканерах, что не умеют отдавать управляющий символ.
    s = s.replace(/\{GS\}|<GS>/gi, GS);

    // Линейный штрихкод — это сразу GTIN, никаких AI в нём нет.
    const linear = ["ean_13", "ean_8", "upc_a", "upc_e", "itf", "code_128"].includes(format);
    if (linear || (!s.startsWith("01") && digits(s) && [8, 12, 13, 14].includes(s.length))) {
      if (!digits(s)) return fail("not_digits");
      const gtin = toGtin14(s);
      return { ok: true, gtin, serial: null, expiresOn: null, batch: null, extra: {}, reason: null, checkDigit: checkDigitOk(s) };
    }

    // Навели камеру на QR с ссылкой или на чужую наклейку: это не «непонятный
    // формат», а просто не штрихкод товара — и сказать надо именно так, иначе
    // человек будет думать, что сервис сломался.
    if (!digits(s.slice(0, 2))) return fail("not_digits");

    const out = { ok: true, gtin: null, serial: null, expiresOn: null, batch: null, extra: {}, reason: null, checkDigit: null };
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const ai = s.slice(i, i + 2);
      if (!digits(ai)) return fail("bad_ai", out);
      i += 2;
      let value;
      if (FIXED[ai] !== undefined) {
        value = s.slice(i, i + FIXED[ai]);
        if (value.length < FIXED[ai]) return fail("truncated", out);
        i += FIXED[ai];
      } else {
        const gs = s.indexOf(GS, i);
        let end = gs === -1 ? s.length : gs;
        // Код без разделителей: после серийного сразу идёт крипто-хвост
        // (91/92/93). В МДЛП серийный ровно 13 знаков — этим и режем.
        // Без этой ветки серийник съедал бы весь хвост целиком, и дедуп
        // упаковки ломался бы на всех сканерах, которые теряют \x1d.
        if (ai === "21" && gs === -1 && s.length - i > MDLP_SERIAL) {
          const after = s.slice(i + MDLP_SERIAL, i + MDLP_SERIAL + 2);
          if (["91", "92", "93"].includes(after)) end = i + MDLP_SERIAL;
        }
        const max = VAR_MAX[ai] ?? 90;
        if (end - i > max) end = i + max;
        value = s.slice(i, end);
        i = end;
      }
      if (ai === "01") out.gtin = toGtin14(value);
      else if (ai === "21") out.serial = value || null;
      else if (ai === "17") out.expiresOn = ymFrom6(value);
      else if (ai === "10") out.batch = value || null;
      else out.extra[ai] = value;
    }
    if (!out.gtin) return fail("no_gtin", out);
    out.checkDigit = checkDigitOk(out.gtin.replace(/^0+(?=\d{8})/, ""));
    return out;
  }

  function fail(reason, partial) {
    return { ok: false, reason, gtin: null, serial: null, expiresOn: null, batch: null, extra: {}, checkDigit: null, ...(partial ? { partial } : {}) };
  }

  /** Человеческое объяснение, почему код не пригодился. */
  const WHY = {
    empty: "пустой код",
    not_digits: "это не штрихкод товара",
    bad_ai: "непонятный формат кода",
    truncated: "код прочитан не целиком",
    no_gtin: "в коде нет номера товара",
  };

  const G = { GS, parse, toGtin14, checkDigitOk, ymFrom6, WHY, MDLP_SERIAL };
  if (typeof module === "object" && module.exports) module.exports = G;
  else root.ZapasGs1 = G;
})(typeof globalThis !== "undefined" ? globalThis : this);
