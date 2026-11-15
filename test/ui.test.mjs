// Статические проверки разметки и стилей — то, что не ловится ни одним
// тестом логики, но ломает весь интерфейс.          node test/ui.test.mjs
import fs from "node:fs";

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};
const read = f => fs.readFileSync(new URL(f, import.meta.url), "utf8");
const css = read("../assets/styles.css");
const html = read("../index.html");
const app = read("../assets/app.js");

{ /* Главный урок этого интерфейса.
     Браузерное правило [hidden]{display:none} слабее любого нашего display.
     Пока его не перебили явно, .sheet-host с display:flex оставался на
     экране невидимым слоем во весь экран с z-index:20 — и съедал ВСЕ клики.
     Выглядело так, будто сломался JavaScript: кнопки просто не нажимались. */
  const rule = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css);
  eq("[hidden] перебит явно и с !important", rule, true);

  // Элементы, которые прячут атрибутом: каждому нужен тот самый перебитый [hidden].
  const hiddenInHtml = [...html.matchAll(/<(\w+)[^>]*\sid="(\w+)"[^>]*\shidden/g)].map(m => m[2]);
  eq("в разметке прячутся атрибутом", hiddenInHtml.sort(), ["scanBtn", "sheetHost"]);
  eq("и оба правда получают display из CSS", [/\.sheet-host\s*\{[^}]*display/.test(css), /\.fab\s*\{[^}]*display/.test(css)], [true, true]);
}

{ // Скрипты подключены в том порядке, в каком друг друга ждут.
  const pos = s => html.indexOf(s);
  eq("expiry.js раньше модуля", pos("/assets/expiry.js") < pos("/assets/app.js"), true);
  eq("gs1.js раньше модуля", pos("/assets/gs1.js") < pos("/assets/app.js"), true);
  eq("app.js подключён модулем", /<script type="module" src="\/assets\/app\.js"/.test(html), true);
}

{ // Глобали, которые фронт берёт у общих файлов, там и объявлены.
  for (const [global, file] of [["ZapasExpiry", "../assets/expiry.js"], ["ZapasGs1", "../assets/gs1.js"]]) {
    eq(`${global} объявлен в ${file.split("/").pop()}`, read(file).includes(`root.${global} =`), true);
    eq(`${global} используется фронтом`, app.includes(`globalThis.${global}`), true);
  }
}

{ // Вкладки совпадают с маршрутами, которые знает роутер.
  const tabs = [...html.matchAll(/data-tab="(\w*)"/g)].map(m => m[1]);
  eq("вкладки на месте", tabs, ["", "mesta", "dokupit", "dom"]);
  for (const t of tabs.filter(Boolean)) {
    eq(`роутер знает /${t}`, app.includes(`r === "${t}"`), true);
  }
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
