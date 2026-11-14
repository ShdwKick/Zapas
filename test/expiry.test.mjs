// Правила сроков: конец месяца, вскрытие, пороги подсветки, порядок.
// Без базы и без сети — чистые функции.          node test/expiry.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const X = require("../assets/expiry.js");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};

const TODAY = "2026-11-13";
const eff = (pack, item = {}) => X.effective(pack, item, TODAY);

{ // конец месяца
  eq("конец месяца: 30 дней", X.endOfMonth("2026-11"), "2026-11-30");
  eq("конец месяца: 31 день", X.endOfMonth("2026-12"), "2026-12-31");
  eq("конец месяца: февраль високосного", X.endOfMonth("2028-02"), "2028-02-29");
  eq("конец месяца: мусор", X.endOfMonth("2026-13"), null);
  eq("конец месяца: день вместо месяца", X.endOfMonth("2026-11-13"), null);
}

{ // печатный срок
  const r = eff({ expiresOn: "2026-11" });
  eq("годно до конца месяца, а не до первого числа", [r.on, r.source], ["2026-11-30", "printed"]);
  eq("17 дней до конца ноября — «вот-вот»", [r.daysLeft, r.status], [17, "urgent"]);
  eq("истёкший месяц", eff({ expiresOn: "2026-10" }).status, "expired");
  eq("срока нет вовсе", eff({ expiresOn: null }), { on: null, source: null, daysLeft: null, status: "unknown" });
}

{ // вскрытие
  const item = { afterOpenDays: 28 };
  const r = eff({ expiresOn: "2028-06", openedOn: "2026-11-01" }, item);
  eq("вскрытие укорачивает срок", [r.on, r.source, r.status], ["2026-11-29", "opened", "urgent"]);

  const late = eff({ expiresOn: "2026-11", openedOn: "2026-11-10" }, { afterOpenDays: 365 });
  eq("вскрытие не удлиняет срок", [late.on, late.source], ["2026-11-30", "printed"]);

  const noPrinted = eff({ expiresOn: null, openedOn: "2026-11-01" }, item);
  eq("без печатного срока считаем от вскрытия", [noPrinted.on, noPrinted.source], ["2026-11-29", "opened"]);

  eq("вскрытие без afterOpenDays ничего не меняет",
    eff({ expiresOn: "2027-05", openedOn: "2026-01-01" }, {}).on, "2027-05-31");
  eq("afterOpenDays есть, а вскрытия нет",
    eff({ expiresOn: "2027-05" }, item).source, "printed");
}

{ // пороги
  eq("истекает сегодня — ещё годно", X.statusOf(0), "urgent");
  eq("вчера — истекло", X.statusOf(-1), "expired");
  eq("30 дней — вот-вот", X.statusOf(30), "urgent");
  eq("31 день — скоро", X.statusOf(31), "soon");
  eq("90 дней — скоро", X.statusOf(90), "soon");
  eq("91 день — в запасе", X.statusOf(91), "ok");
  eq("срок не указан", X.statusOf(null), "unknown");
}

{ // порядок: сначала то, с чем надо что-то делать
  const list = [
    { status: "ok", on: "2030-01-31" },
    { status: "unknown", on: null },
    { status: "expired", on: "2026-09-30" },
    { status: "urgent", on: "2026-11-30" },
    { status: "expired", on: "2026-01-31" },
    { status: "soon", on: "2027-01-31" },
  ];
  eq("порядок групп и дат внутри", [...list].sort(X.compare).map(x => `${x.status}:${x.on}`), [
    "expired:2026-01-31", "expired:2026-09-30", "urgent:2026-11-30",
    "soon:2027-01-31", "ok:2030-01-31", "unknown:null",
  ]);
}

{ // подписи
  eq("человеческий срок", X.human(eff({ expiresOn: "2027-03" })), "до конца марта 2027");
  eq("после вскрытия — с точным днём",
    X.human(eff({ expiresOn: "2028-06", openedOn: "2026-11-01" }, { afterOpenDays: 28 })), "до 29 ноября 2026");
  eq("без срока", X.human(eff({ expiresOn: null })), "срок не указан");
  eq("осталось дней", X.label(eff({ expiresOn: "2026-11" })), "осталось 17 дней");
  eq("истекло", X.label({ status: "expired", daysLeft: -3 }), "истекло 3 дня назад");
  eq("сегодня", X.label({ status: "urgent", daysLeft: 0 }), "истекает сегодня");
  eq("скоро — в неделях", X.label({ status: "soon", daysLeft: 60 }), "осталось 9 недель");
  eq("в запасе — без подписи", X.label({ status: "ok", daysLeft: 400 }), "");
  eq("склонение: 1 день", X.plural(1, "день", "дня", "дней"), "1 день");
  eq("склонение: 11 дней", X.plural(11, "день", "дня", "дней"), "11 дней");
  eq("склонение: 22 дня", X.plural(22, "день", "дня", "дней"), "22 дня");
}

{ // пересчёт единиц: главный вывод проверки на фотографиях инструкции
  eq("6 месяцев", X.afterOpenDaysFrom(6, "месяцев"), 180);
  eq("число строкой, как приходит от модели", X.afterOpenDaysFrom("6", "месяцев"), 180);
  eq("28 дней", X.afterOpenDaysFrom(28, "дней"), 28);
  eq("4 недели", X.afterOpenDaysFrom(4, "недели"), 28);
  eq("2 года", X.afterOpenDaysFrom(2, "года"), 730);
  eq("запятая в числе", X.afterOpenDaysFrom("1,5", "месяца"), 45);
  eq("единица не указана — не угадываем", X.afterOpenDaysFrom(6, ""), null);
  eq("непонятная единица", X.afterOpenDaysFrom(6, "флаконов"), null);
  eq("ноль и отрицательное", [X.afterOpenDaysFrom(0, "дней"), X.afterOpenDaysFrom(-5, "дней")], [null, null]);
  eq("неправдоподобно много — ошибка распознавания", X.afterOpenDaysFrom(99, "лет"), null);
  eq("не число", X.afterOpenDaysFrom("шесть", "месяцев"), null);
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
