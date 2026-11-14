"use strict";
/* Камера и распознавание кода с упаковки.
 *
 * Один вход наружу: openScanner({ onCode }) — показывает видоискатель,
 * зовёт onCode(raw, format) на первом удачном чтении и закрывается.
 * Разбор кода в это не входит: им занимается gs1.js, общий с сервером.
 *
 * Два движка, один интерфейс:
 *   - нативный BarcodeDetector — Chrome на Android (DataMatrix читается
 *     через ML Kit), быстрый и ничего не весит;
 *   - zxing-wasm копией в assets/vendor/ — Safari на iOS, где
 *     BarcodeDetector нет вовсе, и десктопные браузеры.
 *
 * Wasm грузится ЛЕНИВО, при первом открытии сканера и только там, где
 * нативного детектора нет: на Android эти 925 КБ не скачиваются никогда.
 */

/** Форматы, которые нас интересуют. qr_code — чтобы честно сказать «это не штрихкод товара». */
const FORMATS = ["data_matrix", "ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf", "qr_code"];
const VENDOR = "/assets/vendor/zxing/";

let detector = null;      // кэш движка между открытиями сканера
let zxingLoading = null;

/** Нативный детектор годится, только если умеет DataMatrix: на лекарствах он. */
async function nativeDetector() {
  if (!("BarcodeDetector" in globalThis)) return null;
  try {
    const supported = await globalThis.BarcodeDetector.getSupportedFormats();
    if (!supported.includes("data_matrix")) return null;
    const d = new globalThis.BarcodeDetector({ formats: FORMATS.filter(f => supported.includes(f)) });
    return {
      kind: "native",
      async detect(source) {
        const found = await d.detect(source);
        return found.length ? { raw: found[0].rawValue, format: found[0].format } : null;
      },
    };
  } catch { return null; }
}

/** Запасной движок: тот же интерфейс, но считает на wasm. */
async function zxingDetector() {
  if (!globalThis.ZXingWASM) {
    zxingLoading = zxingLoading || new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = VENDOR + "zxing-reader.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("не загрузился распознаватель"));
      document.head.append(s);
    });
    await zxingLoading;
  }
  const Z = globalThis.ZXingWASM;
  // Без этого пакет полезет за wasm на чужой CDN — и копия в репозитории
  // станет бессмысленной (assets/vendor/zxing/VENDOR.md).
  Z.setZXingModuleOverrides({ locateFile: (p, prefix) => (p.endsWith(".wasm") ? VENDOR + p : prefix + p) });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return {
    kind: "wasm",
    async detect(video) {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return null;
      // Считаем по уменьшенному кадру: распознавание — самая дорогая часть
      // цикла, а 640 пикселей по длинной стороне коду хватает с запасом.
      const scale = Math.min(1, 640 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = await Z.readBarcodesFromImageData(data, { formats: FORMATS, tryHarder: true });
      const hit = res && res.find(r => r.isValid !== false && r.text);
      return hit ? { raw: hit.text, format: String(hit.format || "").toLowerCase().replace(/\s|-/g, "_") } : null;
    },
  };
}

async function getDetector() {
  if (detector) return detector;
  detector = (await nativeDetector()) || (await zxingDetector());
  return detector;
}

/** Можно ли вообще предлагать сканирование на этом устройстве. */
export function canScan() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && isSecureContext;
}

/**
 * Видоискатель. Возвращает промис, который разрешается кодом или null,
 * если человек закрыл окно.
 */
export function openScanner(host) {
  return new Promise(resolve => {
    let stream = null, stopped = false, raf = null;

    host.hidden = false;
    host.innerHTML = `
      <div class="sheet-bg" data-close></div>
      <div class="scan" role="dialog" aria-modal="true" aria-label="Сканирование кода">
        <video id="scanVideo" playsinline muted autoplay></video>
        <div class="scan-frame" aria-hidden="true"></div>
        <p class="scan-hint" id="scanHint">Наведите на код с упаковки</p>
        <div class="scan-actions">
          <button class="btn ghost" type="button" id="scanTorch" hidden>Подсветка</button>
          <button class="btn ghost" type="button" data-close>Закрыть</button>
        </div>
      </div>`;
    document.body.classList.add("locked");

    const video = host.querySelector("#scanVideo");
    const hint = host.querySelector("#scanHint");
    const say = t => { hint.textContent = t; };

    function finish(result) {
      if (stopped) return;
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) for (const t of stream.getTracks()) t.stop();
      host.hidden = true;
      host.innerHTML = "";
      document.body.classList.remove("locked");
      resolve(result);
    }
    for (const el of host.querySelectorAll("[data-close]")) el.onclick = () => finish(null);

    (async () => {
      let det;
      try {
        det = await getDetector();
      } catch (e) {
        say("Распознаватель не загрузился. Можно ввести руками.");
        return;
      }
      if (det.kind === "wasm") say("Наведите на код с упаковки");
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        // Отказ в доступе — это решение человека, а не ошибка: так и пишем.
        say(e && e.name === "NotAllowedError"
          ? "Доступ к камере не разрешён. Можно ввести руками."
          : "Камера недоступна. Можно ввести руками.");
        return;
      }
      if (stopped) { for (const t of stream.getTracks()) t.stop(); return; }
      video.srcObject = stream;
      try { await video.play(); } catch { /* автозапуск мог не дать — кадры всё равно идут */ }

      // Подсветка: в шкафчике в ванной темно, а код мелкий.
      const track = stream.getVideoTracks()[0];
      if (track && track.getCapabilities && track.getCapabilities().torch) {
        const btn = host.querySelector("#scanTorch");
        let on = false;
        btn.hidden = false;
        btn.onclick = async () => {
          on = !on;
          try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.classList.toggle("on", on); }
          catch { btn.hidden = true; }
        };
      }

      let busy = false, last = 0;
      const tick = async now => {
        if (stopped) return;
        raf = requestAnimationFrame(tick);
        // Не чаще ~8 раз в секунду: чаще камера всё равно не отдаёт новый
        // кадр, а wasm успевает съесть батарею.
        if (busy || now - last < 120) return;
        busy = true; last = now;
        try {
          const hit = await det.detect(video);
          if (hit && hit.raw) {
            if (navigator.vibrate) navigator.vibrate(40);
            finish(hit);
            return;
          }
        } catch { /* один неудачный кадр — не повод останавливать цикл */ }
        finally { busy = false; }
      };
      raf = requestAnimationFrame(tick);
    })();
  });
}
