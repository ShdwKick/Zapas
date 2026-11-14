"use strict";
/**
 * Сроки годности — общая логика сервера и браузера.
 *
 * Лежит в assets/, потому что нужна фронту; сервер подключает отсюда же
 * (`require("../assets/expiry.js")`), как PDD подключает motivation.js. Две
 * копии этих правил разъехались бы в первый же месяц: у гостя срок считается
 * в браузере, у вошедшего — на сервере, и подсветка обязана совпадать.
 *
 * Главные решения — ARCHITECTURE.md, «Срок годности»:
 *
 *   - Печатный срок хранится как 'YYYY-MM': на упаковках печатают месяц, и
 *     выдуманный день создаёт ложную точность. Годно до КОНЦА месяца.
 *   - Фактический срок = min(конец месяца, вскрытие + after_open_days).
 *     Это и есть смысл сервиса: на флаконе стоит 2028 год, а после вскрытия
 *     он живёт четыре недели, и этого никто не помнит.
 *   - «Сегодня» приходит снаружи строкой 'YYYY-MM-DD' по часовому поясу
 *     пользователя. Ни сервер, ни браузер не берут дату «у себя»: у человека
 *     во Владивостоке иначе всё истекает в обед.
 */
(function (root) {
  /** Пороги в днях. Внутри — включительно, считаем от «сегодня». */
  const SOON = 90;   // 90…31 — «скоро», жёлтая метка
  const URGENT = 30; // 30…1  — «вот-вот», оранжевая, наверх списка

  const isMonth = s => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  const isDay = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

  /** Последний день месяца 'YYYY-MM' → 'YYYY-MM-DD'. */
  function endOfMonth(ym) {
    if (!isMonth(ym)) return null;
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }

  function addDays(day, n) {
    if (!isDay(day)) return null;
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  /** Сколько дней от from до to (отрицательное — to уже в прошлом). */
  function diffDays(from, to) {
    if (!isDay(from) || !isDay(to)) return null;
    const ts = k => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((ts(to) - ts(from)) / 86400000);
  }

  /**
   * Фактический срок упаковки.
   * pack: { expiresOn: 'YYYY-MM'|null, openedOn: 'YYYY-MM-DD'|null }
   * item: { afterOpenDays: number|null }
   * today: 'YYYY-MM-DD' по поясу пользователя.
   *
   * Возвращает { on, source, daysLeft, status } — on может быть null, если
   * срок не указан вовсе (бывает у гигиены и у того, что пересыпали в банку).
   */
  function effective(pack, item, today) {
    const printed = endOfMonth(pack && pack.expiresOn);
    const afterOpen = item && Number.isFinite(item.afterOpenDays) && item.afterOpenDays > 0 && isDay(pack && pack.openedOn)
      ? addDays(pack.openedOn, item.afterOpenDays)
      : null;

    let on = printed, source = "printed";
    // Вскрытие укорачивает срок, но никогда не удлиняет его: лекарство не
    // становится годнее оттого, что его открыли позже напечатанного срока.
    if (afterOpen && (!printed || afterOpen < printed)) { on = afterOpen; source = "opened"; }
    if (!on) return { on: null, source: null, daysLeft: null, status: "unknown" };

    const daysLeft = diffDays(today, on);
    return { on, source, daysLeft, status: statusOf(daysLeft) };
  }

  /**
   * «6 месяцев» → 180 дней. Пересчёт делает КОД, а не модель.
   *
   * Это не придирка к стилю, а результат проверки: на плохом снимке
   * инструкции GigaChat прочитал текст верно («не более 6 месяцев»), а в
   * поле «дней» положил 6. Цитата при этом настоящая, то есть сверка цитат
   * такую ошибку не ловит в принципе. Поэтому у модели спрашивают только то,
   * что напечатано — число и единицу, — а арифметику делаем здесь.
   *
   * Месяц считаем за 30 дней, год за 365: на упаковках пишут «6 месяцев»,
   * а не «с 13 ноября по 13 мая», и точность до дня тут мнимая.
   */
  const UNITS = [
    [/^дн|^день|^сут/i, 1],
    [/^недел/i, 7],
    [/^мес/i, 30],
    [/^год|^лет|^года/i, 365],
  ];
  function afterOpenDaysFrom(value, unit) {
    const n = typeof value === "string" ? Number(value.replace(",", ".")) : value;
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = String(unit || "").trim();
    const found = UNITS.find(([re]) => re.test(u));
    if (!found) return null;
    const days = Math.round(n * found[1]);
    // Больше пяти лет — это не «после вскрытия», а ошибка распознавания.
    return days >= 1 && days <= 1825 ? days : null;
  }

  /** Состояние по остатку дней. daysLeft === 0 — истекает сегодня, ещё годно. */
  function statusOf(daysLeft) {
    if (daysLeft === null || daysLeft === undefined) return "unknown";
    if (daysLeft < 0) return "expired";
    if (daysLeft <= URGENT) return "urgent";
    if (daysLeft <= SOON) return "soon";
    return "ok";
  }

  /** Порядок в списке: сначала то, с чем надо что-то делать. */
  const ORDER = { expired: 0, urgent: 1, soon: 2, ok: 3, unknown: 4 };

  /** Сравнение для сортировки: по состоянию, внутри — по сроку. */
  function compare(a, b) {
    const d = ORDER[a.status] - ORDER[b.status];
    if (d) return d;
    if (a.on && b.on && a.on !== b.on) return a.on < b.on ? -1 : 1;
    if (a.on !== b.on) return a.on ? -1 : 1;
    return 0;
  }

  /** Именительный — для барабана выбора месяца, родительный — для «до …». */
  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  /** «до конца марта 2027», а если срок укоротило вскрытие — «до 14 марта 2027». */
  function human(eff) {
    if (!eff.on) return "срок не указан";
    const [y, m, d] = eff.on.split("-").map(Number);
    return eff.source === "opened"
      ? `до ${d} ${MONTHS_GEN[m - 1]} ${y}`
      : `до конца ${MONTHS_GEN[m - 1]} ${y}`;
  }

  /** Короткая подпись состояния: то, что человек видит на карточке. */
  function label(eff) {
    const n = eff.daysLeft;
    if (eff.status === "unknown") return "срок не указан";
    if (n < 0) return `истекло ${plural(-n, "день", "дня", "дней")} назад`;
    if (n === 0) return "истекает сегодня";
    if (n <= URGENT) return `осталось ${plural(n, "день", "дня", "дней")}`;
    if (n <= SOON) return `осталось ${plural(Math.round(n / 7), "неделя", "недели", "недель")}`;
    return "";
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    const word = m100 >= 11 && m100 <= 14 ? many : m10 === 1 ? one : m10 >= 2 && m10 <= 4 ? few : many;
    return `${n} ${word}`;
  }

  const E = { SOON, URGENT, isMonth, isDay, endOfMonth, addDays, diffDays, effective, statusOf, compare, human, label, plural, afterOpenDaysFrom, ORDER, MONTHS, MONTHS_GEN };
  if (typeof module === "object" && module.exports) module.exports = E;
  else root.ZapasExpiry = E;
})(typeof globalThis !== "undefined" ? globalThis : this);
