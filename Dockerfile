FROM node:24-alpine

WORKDIR /app

# Зависимостей нет, как и у остальных сервисов BurningHouse: сервер на
# встроенных http и node:sqlite.
COPY server.js auth-client.js admin-internal.js ./
COPY lib/ ./lib/
COPY index.html sw.js manifest.webmanifest ./
COPY bank/ ./bank/
COPY assets/ ./assets/

# data/ — SQLite дома: места, позиции, упаковки, журнал. Volume.
RUN mkdir -p /app/data && chown -R node:node /app

# Образ без одного файла — это 500 на первом же запросе; дешевле поймать
# здесь. assets/expiry.js в списке не случайно: его требует lib/store.js,
# и забыть его в COPY легче всего — он выглядит как файл фронта.
RUN set -e; \
    for f in server.js auth-client.js admin-internal.js lib/store.js lib/webpush.js index.html sw.js \
             manifest.webmanifest assets/app.js assets/local.js assets/expiry.js \
             assets/styles.css assets/brand.css assets/brand.js assets/auth-client.js \
             assets/gs1.js assets/scan.js bank/gtin.json bank/leaflets.json \
             assets/favicon.svg assets/icons/icon-512.png \
             assets/icons/icon-maskable-512.png assets/icons/apple-touch-icon-180.png; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    node --check server.js && node --check auth-client.js && node --check admin-internal.js \
      && node --check lib/store.js && node --check lib/webpush.js \
      && node --check assets/expiry.js && node --check assets/gs1.js

USER node

ENV HOST=0.0.0.0
ENV PORT=8799
ENV DATA_DIR=/app/data

EXPOSE 8799
VOLUME ["/app/data"]

CMD ["node", "server.js"]
