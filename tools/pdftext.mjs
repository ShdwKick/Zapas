#!/usr/bin/env node
/**
 * Текст из PDF без зависимостей.      node tools/pdftext.mjs файл.pdf
 *
 * Нужен для tools/leaflet.mjs: прежде чем просить модель извлечь поля из
 * инструкции, надо иметь её текст у себя — иначе сверять цитаты будет не с
 * чем, и всё построение на «поле без подтверждённой цитаты не попадает в
 * справочник» (ARCHITECTURE.md, «Инструкции») рассыпается.
 *
 * Как устроено: находим объекты PDF, распаковываем потоки (FlateDecode),
 * читаем карты ToUnicode у шрифтов и переводим коды глифов из операторов
 * Tj/TJ в символы. Ширина кода берётся из самой карты: в одних файлах
 * глифы однобайтовые, в других двухбайтовые, и угадывать нельзя.
 *
 * Чего он НЕ умеет и не должен: сканы. В них нет текстового слоя, значит
 * нет и операторов Tj — такая инструкция просто вернёт пустую строку, и
 * leaflet.mjs честно оставит поля незаполненными. Пустое поле лучше
 * придуманного.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";

/** Распаковать поток объекта; не сжат — вернуть как есть. */
function streamOf(body) {
  const start = body.indexOf("stream");
  if (start === -1) return null;
  let i = start + 6;
  if (body[i] === "\r") i++;
  if (body[i] === "\n") i++;
  const end = body.indexOf("endstream", i);
  if (end === -1) return null;
  const raw = Buffer.from(body.slice(i, end), "latin1");
  try { return zlib.inflateSync(raw); } catch { return raw; }
}

/** Карта ToUnicode: код глифа → символ, плюс ширина кода в байтах. */
function parseCMap(data) {
  const text = data.toString("latin1");
  const table = new Map();
  let width = 1;
  const hex4 = s => {
    let out = "";
    for (let i = 0; i + 3 < s.length + 1; i += 4) out += String.fromCharCode(parseInt(s.slice(i, i + 4), 16));
    return out;
  };
  for (const blk of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      width = Math.max(width, m[1].length / 2);
      table.set(parseInt(m[1], 16), hex4(m[2]));
    }
  }
  for (const blk of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      width = Math.max(width, m[1].length / 2);
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), base = parseInt(m[3], 16);
      for (let k = 0; k <= hi - lo; k++) table.set(lo + k, String.fromCharCode(base + k));
    }
  }
  return table.size ? { table, width } : null;
}

export function pdfText(buf) {
  const src = buf.toString("latin1");
  const objects = new Map();
  for (const m of src.matchAll(/(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g)) objects.set(Number(m[1]), m[2]);

  // 1. карты ToUnicode по номеру объекта
  const cmaps = new Map();
  for (const [num, body] of objects) {
    const data = streamOf(body);
    if (!data) continue;
    const s = data.toString("latin1");
    if (!s.includes("beginbfchar") && !s.includes("beginbfrange")) continue;
    const cm = parseCMap(data);
    if (cm) cmaps.set(num, cm);
  }
  // 2. имя ресурса (/F1) → карта
  const byName = new Map();
  const fontObj = new Map();
  for (const [num, body] of objects) {
    const m = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body);
    if (m && cmaps.has(Number(m[1]))) fontObj.set(num, cmaps.get(Number(m[1])));
  }
  for (const body of objects.values()) {
    for (const m of body.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      const cm = fontObj.get(Number(m[2]));
      if (cm) byName.set(m[1], cm);
    }
  }

  // 3. содержимое страниц
  const out = [];
  let cur = null;
  const TOK = /\/(\w+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>|\((?:\\.|[^\\()])*\)|TD|Td|T\*|ET/g;
  for (const body of objects.values()) {
    const data = streamOf(body);
    if (!data) continue;
    const s = data.toString("latin1");
    if (!s.includes("Tj") && !s.includes("TJ")) continue;
    for (const m of s.matchAll(TOK)) {
      const tok = m[0];
      if (tok.endsWith("Tf")) cur = byName.get(m[1]) || null;
      else if (tok[0] === "<" && cur) {
        const h = m[2], step = cur.width * 2;
        let piece = "";
        for (let i = 0; i + step <= h.length; i += step) piece += cur.table.get(parseInt(h.slice(i, i + step), 16)) ?? "";
        out.push(piece);
      } else if (tok[0] === "(") {
        out.push(tok.slice(1, -1).replace(/\\([()\\])/g, "$1"));
      } else out.push(" ");
    }
  }
  return out.join("").replace(/[  ]+/g, " ").trim();
}

// Сверка цитат переехала в assets/quotes.js: тем же правилам подчиняется
// сервер, когда читает фотографию вкладыша. Здесь реэкспорт, чтобы
// инструмент и его тесты брали правила из одного места.
export const { normalize, quoteFound } = createRequire(import.meta.url)("../assets/quotes.js");

if (import.meta.filename === process.argv[1]) {
  const file = process.argv[2];
  if (!file) { console.error("нужен путь к PDF"); process.exit(2); }
  const text = pdfText(fs.readFileSync(file));
  if (!text) { console.error("текстового слоя нет — похоже, это скан"); process.exit(1); }
  process.stdout.write(text + "\n");
}
