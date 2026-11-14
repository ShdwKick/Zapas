# zxing-wasm — чужой код, лежит копией

Читает DataMatrix и EAN там, где браузер не умеет сам. Нужен из-за одного
факта: **в Safari на iOS `BarcodeDetector` нет** и по умолчанию выключен
вплоть до 26/27, а половина домашних телефонов — айфоны.

| Что | Значение |
|---|---|
| Пакет | `zxing-wasm@3.1.6` (npm) |
| Файлы | `zxing-reader.js` (IIFE-сборка, 38 КБ), `zxing_reader.wasm` (925 КБ) |
| Глобальная переменная | `ZXingWASM` |
| Лицензии | zxing-wasm — MIT, собран из zxing-cpp — Apache 2.0 |
| SHA-256 wasm | `5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e` |

Контрольная сумма не выдумана: её публикует сам пакет константой
`ZXING_WASM_SHA256` внутри `zxing-reader.js`. Это и есть способ проверить,
что js и wasm — из одной сборки:

```bash
shasum -a 256 assets/vendor/zxing/zxing_reader.wasm
grep -o 'ZXING_WASM_SHA256=`[0-9a-f]*`' assets/vendor/zxing/zxing-reader.js
```

## Почему копией, а не с CDN

По той же причине, по которой во всех этих проектах нет `node_modules`, а
`brand.css` лежит копией в каждом сервисе: сервис должен работать сам по
себе. Сканер, который перестаёт читать коды, когда недоступен чужой CDN, —
это сканер, который сломается ровно тогда, когда он нужен. Плюс PWA: файл
из кэша service worker'а работает без сети, файл с CDN — нет.

Цена честная: **925 КБ бинарника в репозитории** (по сети уходит около 400 КБ
— wasm хорошо жмётся gzip'ом, nginx его сжимает). Грузится он лениво, только
когда человек нажал «Сканировать», и только там, где нет своего
`BarcodeDetector`: на Android Chrome этот файл не скачивается вовсе.

## Обновление

Обновлять незачем, пока он читает коды. Если всё же надо:

```bash
curl -sSL -o assets/vendor/zxing/zxing-reader.js https://cdn.jsdelivr.net/npm/zxing-wasm@ВЕРСИЯ/dist/iife/reader/index.js
curl -sSL -o assets/vendor/zxing/zxing_reader.wasm https://cdn.jsdelivr.net/npm/zxing-wasm@ВЕРСИЯ/dist/reader/zxing_reader.wasm
```

После обновления обязательно сверить sha256 с константой в новом js — иначе
легко получить js одной версии и wasm другой, и это проявится не сразу, а
странными ошибками распознавания.

**`locateFile` переопределяется у нас** (`assets/scan.js`): по умолчанию
пакет тянет wasm с jsdelivr, и без этой правки весь смысл копии теряется.
