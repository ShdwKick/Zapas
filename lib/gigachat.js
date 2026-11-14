"use strict";
/**
 * Чтение фотографии вкладыша через GigaChat. Без зависимостей.
 *
 * Зачем это в рантайме, хотя справочник инструкций собирается офлайн:
 * предугадать, какие препараты лежат у людей, нельзя — их слишком много.
 * Человек же держит коробку в руках ровно в тот момент, когда заводит
 * упаковку, и может сфотографировать вкладыш.
 *
 * Два правила, которые здесь не обсуждаются, потому что проверены
 * на живой инструкции (ARCHITECTURE.md, «Фотография вкладыша»):
 *
 *   1. У модели спрашивают ТОЛЬКО то, что напечатано: число и единицу
 *      отдельно. Пересчёт делает код (assets/expiry.js). На плохом снимке
 *      модель читала «не более 6 месяцев» верно, а в поле «дней» клала 6 —
 *      и сверка цитат такую ошибку не ловит, цитата-то настоящая.
 *   2. Каждое поле приходит с цитатой, и цитата должна найтись в тексте,
 *      который распознала сама модель. Это ловит выдуманные факты, но НЕ
 *      ловит неверно прочитанную цифру — поэтому экран подтверждения с
 *      показанной цитатой обязателен, и это сказано в интерфейсе.
 *
 * Сертификат: GigaChat подписан корнем Минцифры, которого нет ни в
 * системных хранилищах, ни в alpine. Поэтому он лежит рядом файлом и
 * подкладывается только в эти запросы — глобально доверие не меняем.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const X = require("../assets/expiry.js");
const { quoteFound } = require("../assets/quotes.js");

const OAUTH = { host: "ngw.devices.sberbank.ru", port: 9443, path: "/api/v2/oauth" };
const API = { host: "gigachat.devices.sberbank.ru", port: 443 };
const CA_FILE = path.join(__dirname, "gigachat-ca.pem");
/** Снимок страницы инструкции — это сотни килобайт, не мегабайты. */
const MAX_PHOTO = 6 * 1024 * 1024;
const TOKEN_SAFETY_MS = 60 * 1000;

const PROMPT = `На фотографии — страница инструкции по медицинскому применению лекарства.
Верни ТОЛЬКО JSON без markdown и пояснений:
{"text": "<весь распознанный текст страницы целиком>",
 "name": <торговое наименование или null>, "nameQuote": <цитата>,
 "mnn": <действующее вещество или null>, "mnnQuote": <цитата>,
 "form": <лекарственная форма или null>, "formQuote": <цитата>,
 "afterOpenValue": <число срока ПОСЛЕ вскрытия, КАК НАПИСАНО, без пересчёта, или null>,
 "afterOpenUnit": <единица как написана: дней/недель/месяцев/лет, или null>,
 "afterOpenQuote": <цитата про срок после вскрытия>,
 "storageMaxC": <верхняя граница температуры хранения, число, или null>, "storageQuote": <цитата>,
 "rx": <true если по рецепту, false если без рецепта, иначе null>, "rxQuote": <цитата>}

Цитаты копируй дословно с изображения, 3-25 слов. Ничего не пересчитывай и
не переводи в другие единицы. Не видно или не уверен — ставь null.`;

function request({ host, port, path: p, method = "POST", headers, body, ca }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path: p, method, headers, ca, timeout: 180000 }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("GigaChat не ответил вовремя")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = function createGigaChat({ authKey, model = "GigaChat-2-Max", caPath = CA_FILE } = {}) {
  const enabled = !!authKey;
  let ca = null;
  if (enabled) {
    try { ca = fs.readFileSync(caPath); }
    catch (e) { console.error("Сертификат для GigaChat не прочитан — чтение вкладышей выключено:", e.message); }
  }
  const ready = enabled && !!ca;

  let token = null, tokenUntil = 0;
  async function getToken() {
    if (token && Date.now() < tokenUntil - TOKEN_SAFETY_MS) return token;
    const r = await request({
      ...OAUTH, ca, body: "scope=GIGACHAT_API_PERS",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        RqUID: crypto.randomUUID(),
        Authorization: "Basic " + authKey,
      },
    });
    if (r.status !== 200) throw new Error(`токен не получен: HTTP ${r.status}`);
    const d = JSON.parse(r.body);
    token = d.access_token;
    tokenUntil = Number(d.expires_at) || Date.now() + 25 * 60 * 1000;
    return token;
  }

  /** multipart/form-data руками — зависимостей нет. */
  async function upload(buf, filename, mime) {
    const b = "----zapas" + crypto.randomUUID().replace(/-/g, "");
    const head = Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ngeneral\r\n`
      + `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + `Content-Type: ${mime}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${b}--\r\n`);
    const r = await request({
      ...API, path: "/api/v1/files", ca, body: Buffer.concat([head, buf, tail]),
      headers: {
        Authorization: "Bearer " + (await getToken()),
        "Content-Type": "multipart/form-data; boundary=" + b,
        Accept: "application/json",
      },
    });
    if (r.status !== 200) throw new Error(`снимок не загрузился: HTTP ${r.status}`);
    return JSON.parse(r.body).id;
  }

  async function ask(fileId) {
    const r = await request({
      ...API, path: "/api/v1/chat/completions", ca,
      headers: {
        Authorization: "Bearer " + (await getToken()),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.01,
        messages: [{ role: "user", content: PROMPT, attachments: [fileId] }],
      }),
    });
    if (r.status !== 200) throw new Error(`GigaChat ответил HTTP ${r.status}`);
    const d = JSON.parse(r.body);
    const raw = (d.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("ответ не похож на JSON"); }
    return { parsed, usage: d.usage || null };
  }

  /** Отбор полей: наружу идёт только то, чья цитата нашлась в распознанном тексте. */
  function pick(parsed) {
    const text = String(parsed.text || "");
    const fields = {}, quotes = {}, rejected = [];
    let nameOnPhoto = null;
    const take = (key, value, quote, cast) => {
      if (value === null || value === undefined || value === "") return;
      if (!quote || !quoteFound(quote, text)) {
        rejected.push({ key, why: quote ? "цитаты нет в прочитанном тексте" : "цитата не приведена" });
        return;
      }
      const v = cast ? cast(value) : String(value).trim();
      if (v === null) { rejected.push({ key, why: "значение не разобрано" }); return; }
      fields[key] = v;
      quotes[key] = String(quote).trim();
    };
    // Название со снимка НЕ применяется: оно уже известно — его ввёл человек
    // или оно пришло с кода упаковки. Проверено на живом снимке: модель
    // прочитала «Синупрет» как «Синуфорте» — другой реальный препарат, и
    // сверка цитат этого не поймала, потому что цитата согласована с её же
    // ошибочным текстом. Название возвращаем отдельно, только чтобы
    // интерфейс мог спросить: «на снимке другое название, та ли это коробка?»
    if (parsed.name) nameOnPhoto = String(parsed.name).trim().slice(0, 200);
    take("mnn", parsed.mnn, parsed.mnnQuote);
    take("form", parsed.form, parsed.formQuote);
    take("storageMaxC", parsed.storageMaxC, parsed.storageQuote, v => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= -30 && n <= 60 ? n : null;
    });
    take("rx", parsed.rx, parsed.rxQuote, v => !!v);
    // Срок после вскрытия: число и единица пришли раздельно, считаем сами.
    if (parsed.afterOpenValue !== null && parsed.afterOpenValue !== undefined) {
      const days = X.afterOpenDaysFrom(parsed.afterOpenValue, parsed.afterOpenUnit);
      if (days === null) rejected.push({ key: "afterOpenDays", why: "не понял число или единицу срока" });
      else take("afterOpenDays", days, parsed.afterOpenQuote, v => v);
    }
    return { fields, quotes, rejected, text, nameOnPhoto };
  }

  return {
    ready,
    /** Прочитать снимок вкладыша. Ничего не сохраняет — это черновик для подтверждения. */
    async readLeaflet(buf, { filename = "leaflet.jpg", mime = "image/jpeg" } = {}) {
      if (!ready) throw Object.assign(new Error("чтение вкладышей не настроено"), { status: 503, code: "not_configured" });
      if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error("пустой снимок"), { status: 400 });
      if (buf.length > MAX_PHOTO) throw Object.assign(new Error("снимок слишком большой"), { status: 413 });
      const id = await upload(buf, filename, mime);
      const { parsed, usage } = await ask(id);
      return { ...pick(parsed), usage };
    },
  };
};
