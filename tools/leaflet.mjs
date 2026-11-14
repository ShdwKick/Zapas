#!/usr/bin/env node
/**
 * Справочник из официальных инструкций.
 *
 *   GIGACHAT_AUTH_KEY=... node tools/leaflet.mjs ./pdf [--out bank/leaflets.json]
 *
 * Что делает: берёт папку с PDF инструкций по медицинскому применению,
 * вытаскивает текст (tools/pdftext.mjs), просит GigaChat извлечь поля —
 * и **сверяет каждую цитату с текстом документа**. Поле, цитата которого в
 * документе не нашлась, в справочник не попадает.
 *
 * Почему извлечение, а не «краткая инструкция»: пересказ — текст, в котором
 * ошибка неотличима от правды. Извлечение проверяемо: поле, значение и
 * дословная цитата, которую можно найти в бумаге. Подробнее и с цифрами
 * проверки — ARCHITECTURE.md, «Инструкции».
 *
 * Запускается НА МАШИНЕ РАЗРАБОТЧИКА, не в проде: результат — часть образа,
 * в рантайме ни сети, ни ключа GigaChat не нужно.
 *
 * Сертификат. GigaChat подписан корнем Минцифры, которого нет в системных
 * хранилищах, поэтому нужен он сам:
 *
 *   curl -o /tmp/ru.crt https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
 *   curl -o /tmp/sub.crt https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt
 *   cat /tmp/ru.crt /tmp/sub.crt > /tmp/ru-bundle.pem
 *   GIGACHAT_CA=/tmp/ru-bundle.pem GIGACHAT_AUTH_KEY=... node tools/leaflet.mjs ./pdf
 *
 * Проверку сертификата инструмент не отключает и отключать не предлагает.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { pdfText, quoteFound } from "./pdftext.mjs";

const OAUTH = { host: "ngw.devices.sberbank.ru", port: 9443, path: "/api/v2/oauth" };
const API = { host: "gigachat.devices.sberbank.ru", port: 443 };

/** Поля, которые забираем из инструкции. Больше — сознательно не берём. */
export const FIELDS = {
  name: "торговое наименование",
  regNumber: "регистрационный номер",
  mnn: "МНН или действующее вещество; у растительных сборов его нет",
  form: "лекарственная форма",
  afterOpenDays: "срок годности ПОСЛЕ вскрытия упаковки, в днях (число)",
  storageMaxC: "верхняя граница температуры хранения, °C (число)",
  rx: "отпускается ли по рецепту (true/false)",
};
/* Показаний, дозировок и способа применения здесь нет и не будет: сервис
   ведёт учёт, а не лечит (ARCHITECTURE.md, «Граница»). Нет поля — нечего
   однажды вывести на экран «просто чтобы было удобнее». */

const PROMPT = `Ты извлекаешь факты из официальной инструкции по медицинскому применению.
Отвечай ТОЛЬКО JSON, без markdown и пояснений.

Нужны поля:
${Object.entries(FIELDS).map(([k, v]) => `  ${k} — ${v}`).join("\n")}

Для КАЖДОГО заполненного поля добавь поле <имя>Quote — дословную цитату из
документа, в которой это значение написано. Цитата копируется посимвольно,
без исправлений и сокращений, 3-25 слов.

Если значения в документе нет — ставь null и не придумывай цитату.
Ничего не добавляй от себя и не пересказывай.`;

function post({ host, port, path: p, headers, body, ca }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path: p, method: "POST", headers, ca, timeout: 120000 }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("timeout", () => req.destroy(new Error("таймаут")));
    req.on("error", reject);
    req.end(body);
  });
}

async function getToken(authKey, ca) {
  const r = await post({
    ...OAUTH, ca,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      RqUID: crypto.randomUUID(),
      Authorization: "Basic " + authKey,
    },
    body: "scope=GIGACHAT_API_PERS",
  });
  if (r.status !== 200) throw new Error(`токен не получен: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body).access_token;
}

async function ask(token, ca, model, text) {
  const r = await post({
    ...API, path: "/api/v1/chat/completions", ca,
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      model,
      // Около нуля: один и тот же документ должен давать одно и то же поле.
      temperature: 0.01,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: text.slice(0, 60000) },
      ],
    }),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  const content = JSON.parse(r.body).choices?.[0]?.message?.content || "";
  const clean = content.replace(/^```(?:json)?|```$/gm, "").trim();
  try { return { data: JSON.parse(clean), usage: JSON.parse(r.body).usage }; }
  catch { throw new Error("ответ не JSON: " + clean.slice(0, 200)); }
}

const asInt = v => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Math.round(Number(v)) : null);

/** Оставляем только то, что подтверждено цитатой из самого документа. */
export function verify(data, text) {
  const out = {}, rejected = [], quotes = {};
  for (const key of Object.keys(FIELDS)) {
    const value = data[key];
    const quote = data[`${key}Quote`];
    if (value === null || value === undefined || value === "") continue;
    if (!quote || !quoteFound(quote, text)) {
      rejected.push({ key, value, quote: quote || null, why: quote ? "цитаты нет в документе" : "цитата не приведена" });
      continue;
    }
    out[key] = key === "afterOpenDays" || key === "storageMaxC" ? asInt(value)
      : key === "rx" ? !!value
        : String(value).trim();
    if (out[key] === null) { delete out[key]; rejected.push({ key, value, quote, why: "не число" }); continue; }
    quotes[key] = String(quote).trim();
  }
  return { fields: out, quotes, rejected };
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith("--"));
  const opt = k => { const i = args.indexOf(`--${k}`); return i === -1 ? null : args[i + 1]; };
  if (!dir) {
    console.error("Использование: GIGACHAT_AUTH_KEY=... node tools/leaflet.mjs <папка с PDF> [--out bank/leaflets.json] [--model GigaChat-2-Max] [--force]");
    process.exit(2);
  }
  const out = opt("out") || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bank", "leaflets.json");
  const model = opt("model") || "GigaChat-2-Max";
  const force = args.includes("--force");
  const authKey = process.env.GIGACHAT_AUTH_KEY;
  if (!authKey) { console.error("Нет GIGACHAT_AUTH_KEY."); process.exit(2); }
  const caPath = process.env.GIGACHAT_CA || opt("ca");
  const ca = caPath ? fs.readFileSync(caPath) : undefined;
  if (!ca && !process.env.NODE_EXTRA_CA_CERTS) {
    console.warn("! Ни GIGACHAT_CA, ни NODE_EXTRA_CA_CERTS не заданы — соединение, скорее всего, не установится (см. шапку файла).");
  }

  const bank = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".pdf")).sort();
  if (!files.length) { console.error("В папке нет PDF."); process.exit(1); }

  const token = await getToken(authKey, ca);
  let added = 0, skipped = 0, scans = 0, tokens = 0;

  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const sha = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
    const known = Object.entries(bank).find(([, v]) => v.sha === sha);
    if (known && !force) { console.log(`=  ${f} — не менялся, пропуск`); skipped++; continue; }

    const text = pdfText(buf);
    if (!text || text.length < 400) {
      // Текстового слоя нет: это скан. Оставляем человеку, а не выдумываем.
      console.log(`!  ${f} — текста нет, похоже на скан: пропуск`);
      scans++;
      continue;
    }
    let res;
    try { res = await ask(token, ca, model, text); }
    catch (e) { console.log(`!  ${f} — ${e.message}`); continue; }
    tokens += res.usage?.total_tokens || 0;

    const { fields, quotes, rejected } = verify(res.data, text);
    const key = fields.regNumber || `file:${f}`;
    if (!fields.name) { console.log(`!  ${f} — название не подтверждено цитатой, пропуск`); continue; }

    bank[key] = { ...fields, quotes, sha, source: f, updatedAt: new Date().toISOString().slice(0, 10) };
    added++;
    const got = Object.keys(fields).join(", ");
    console.log(`+  ${f} → ${key}\n   поля: ${got}`);
    for (const r of rejected) console.log(`   отброшено ${r.key}=${JSON.stringify(r.value)} — ${r.why}`);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(bank, null, 2) + "\n");
  console.log(`\nЗаписано в ${out}: ${Object.keys(bank).length} инструкций (добавлено ${added}, пропущено ${skipped}, сканов ${scans}), токенов ${tokens}.`);
}

// Запускаемся только как инструмент. Без этой проверки `import` из теста
// полез бы в сеть за токеном.
if (import.meta.filename === process.argv[1]) {
  main().catch(e => { console.error("Сорвалось:", e.message); process.exit(1); });
}
