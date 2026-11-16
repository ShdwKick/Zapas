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
  eq("tags.js раньше модуля", pos("/assets/tags.js") < pos("/assets/app.js"), true);
  eq("app.js подключён модулем", /<script type="module" src="\/assets\/app\.js"/.test(html), true);
}

{ /* Каждый глобал, которым пользуется фронт, должен быть ПОДКЛЮЧЁН страницей.
     Файл может лежать в assets/ и при этом нигде не загружаться: так
     кнопка «Войти» рисовалась, а createAuthClient не существовал — вызывать
     ей было нечего, и выглядело это как мёртвая кнопка. */
  for (const [global, file] of [
    ["createAuthClient", "/assets/auth-client.js"],
    ["ZapasExpiry", "/assets/expiry.js"],
    ["ZapasGs1", "/assets/gs1.js"],
    ["ZapasTags", "/assets/tags.js"],
  ]) {
    if (!app.includes(global)) continue;
    eq(`${file} подключён страницей`, html.includes(`src="${file}"`), true);
  }
}

{ // Глобали, которые фронт берёт у общих файлов, там и объявлены.
  for (const [global, file] of [["ZapasExpiry", "../assets/expiry.js"], ["ZapasGs1", "../assets/gs1.js"], ["ZapasTags", "../assets/tags.js"]]) {
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

{ /* Ревью по Web Interface Guidelines — сторожа на то, что уже чинили. */
  eq("нажимаемое без задержки двойного тапа", /touch-action\s*:\s*manipulation/.test(css), true);
  eq("лист не утягивает страницу", (css.match(/overscroll-behavior\s*:\s*contain/g) || []).length >= 2, true);
  eq("есть видимый фокус у всего нажимаемого", /button:focus-visible/.test(css), true);
  eq("есть состояния наведения", /@media \(hover: hover\)/.test(css), true);
  eq("длинные названия переносятся", /overflow-wrap\s*:\s*anywhere/.test(css), true);

  // Системные окна: на телефоне это чужая клавиатура и чужой вид.
  // Комментарии вырезаем — в них эти слова упоминаются как раз потому,
  // что объясняют, почему их больше нет.
  const code = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const calls = n => new RegExp(`(^|[^.\\w])${n}\\s*\\(`, "g");
  eq("prompt() не вызывается", (code.match(calls("prompt")) || []).length, 0);
  eq("confirm() не вызывается", (code.match(calls("confirm")) || []).length, 0);

  // Кнопка без слов обязана называться для чтения с экрана, иначе список
  // превращается в «кнопка, кнопка, кнопка».
  const iconBtns = [...app.matchAll(/<button class="icon-btn[^"]*"([^>]*)>/g)].map(m => m[1]);
  eq("иконочные кнопки есть", iconBtns.length > 0, true);
  eq("и у каждой есть aria-label", iconBtns.every(a => /aria-label="/.test(a)), true);

  eq("дата показывается через Intl", /Intl\.DateTimeFormat\("ru-RU"/.test(app), true);

  /* Ярлыки. Строка фильтра — группа с названием: иначе это просто набор
     кнопок без объяснения, что они делают вместе. А чипы выбора в форме
     должны ПЕРЕНОСИТЬСЯ: готовых подсказок дюжина, и в горизонтальной
     прокрутке человек увидел бы две из них. */
  eq("строка ярлыков названа", /id="tagChips"[^>]*aria-label="/.test(app), true);
  eq("чипы выбора отвечают, нажаты ли они", /data-tag="\$\{esc\(t\)\}" aria-pressed=/.test(app), true);
  eq("в форме чипы переносятся", /\.tagpick \.chips\{[^}]*flex-wrap\s*:\s*wrap/.test(css), true);
  eq("Enter в поле ярлыка не отправляет форму", /add\.onkeydown[\s\S]{0,200}preventDefault/.test(app), true);
  eq("на экране списка есть заголовок", /<h1 class="sr-only">/.test(app), true);
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
