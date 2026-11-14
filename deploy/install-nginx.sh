#!/usr/bin/env bash
# Ставит nginx-конфиг «Что у нас есть?» (zapas.burninghouse.ru -> 127.0.0.1:8799).
#
#   sudo bash install-nginx.sh
#
# Скрипт самодостаточный — конфиг внутри, репозиторий на сервере не нужен.
# Что делает:
#   1. находит ВСЕ старые конфиги с server_name zapas.burninghouse.ru
#      (sites-available, sites-enabled, conf.d), сохраняет копии в
#      /root/nginx-backup-zapas-<время>/ и удаляет их;
#   2. получает сертификат, если его ещё нет (certbot --nginx);
#   3. кладёт конфиг в sites-available/zapas и ссылку в sites-enabled;
#   4. nginx -t — если не прошло, возвращает всё как было;
#   5. reload и проверка: отвечает ли домен сервисом zapas, а не чем-то ещё.
#
# Отличие от соседних сервисов — gzip. В образе лежит распознаватель кодов
# (assets/vendor/zxing/zxing_reader.wasm, 925 КБ), и сам сервис его не жмёт:
# node отдаёт файл как есть. Без строчки про application/wasm ниже телефон
# будет тянуть почти мегабайт при первом открытии сканера вместо ~400 КБ.
set -euo pipefail

DOMAIN="zapas.burninghouse.ru"
PORT=8799
NAME="zapas"
AVAIL="/etc/nginx/sites-available/$NAME"
ENABLED="/etc/nginx/sites-enabled/$NAME"
BACKUP="/root/nginx-backup-$NAME-$(date +%Y%m%d-%H%M%S)"

[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo."; exit 1; }
command -v nginx >/dev/null || { echo "nginx не найден."; exit 1; }

# ---------- 1. старые конфиги ----------
mkdir -p "$BACKUP"
mapfile -t FOUND < <(grep -rlE "server_name[^;]*[[:space:]]${DOMAIN//./\\.}([[:space:];]|$)" \
  /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true)

declare -A REAL=()
for f in "${FOUND[@]}" "$AVAIL" "$ENABLED"; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  r="$(readlink -f "$f" || echo "$f")"
  # Файл, где кроме zapas описаны и другие домены, не трогаем — иначе сломаем
  # соседний сервис. Такое нужно разнести руками.
  if [ -f "$r" ] && grep -E "^[[:space:]]*server_name" "$r" | grep -vq "$DOMAIN"; then
    echo "СТОП: в $r кроме $DOMAIN есть другие server_name:"
    grep -nE "^[[:space:]]*server_name" "$r"
    echo "Уберите блоки $DOMAIN из этого файла вручную и запустите скрипт снова."
    exit 1
  fi
  REAL["$r"]=1
  [ -L "$f" ] && { echo "Удаляю ссылку $f"; rm -f "$f"; }
done
for r in "${!REAL[@]}"; do
  [ -f "$r" ] || continue
  cp -a "$r" "$BACKUP/"
  echo "Удаляю $r (копия в $BACKUP)"
  rm -f "$r"
done
# Висячие ссылки в sites-enabled на удалённые файлы
find /etc/nginx/sites-enabled -xtype l -print -delete 2>/dev/null | sed 's/^/Удалена битая ссылка /' || true

restore() {
  echo "Откатываю: возвращаю старые конфиги из $BACKUP"
  rm -f "$AVAIL" "$ENABLED"
  for b in "$BACKUP"/*; do
    [ -e "$b" ] || continue
    cp -a "$b" /etc/nginx/sites-available/
    base="$(basename "$b")"
    ln -sf "/etc/nginx/sites-available/$base" "/etc/nginx/sites-enabled/$base"
  done
  nginx -t && systemctl reload nginx || true
}

# ---------- 2. сертификат ----------
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ ! -f "$CERT" ]; then
  echo "Сертификата для $DOMAIN нет — получаю через certbot…"
  certbot certonly --nginx -d "$DOMAIN" || { echo "certbot не справился (DNS $DOMAIN указывает на этот сервер?)"; restore; exit 1; }
fi

# ---------- 3. новый конфиг ----------
cat > "$AVAIL" <<EOF
# «Что у нас есть?» на $DOMAIN. Ставится deploy/install-nginx.sh из репозитория Zapas.

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    # Загрузок нет — дефолтного client_max_body_size хватает с запасом.

    # Жмём то, что node отдаёт как есть. application/wasm тут главный: это
    # распознаватель кодов, 925 КБ, и грузится он на телефоне по мобильной
    # сети. gzip_proxied any обязателен — иначе ответы из proxy_pass
    # остаются несжатыми и вся строчка бесполезна.
    gzip on;
    gzip_proxied any;
    gzip_min_length 1024;
    gzip_comp_level 6;
    gzip_vary on;
    gzip_types application/wasm application/javascript text/javascript text/css
               application/json application/manifest+json image/svg+xml text/plain;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
EOF
ln -sf "$AVAIL" "$ENABLED"
echo "Записан $AVAIL, ссылка $ENABLED"

# ---------- 4. проверка и reload ----------
if ! nginx -t; then
  echo "nginx -t не прошёл."
  restore
  exit 1
fi
systemctl reload nginx
echo "nginx перезагружен."

# ---------- 5. проверка ответа ----------
sleep 1
if ! curl -fsS -m 5 "http://127.0.0.1:$PORT/robots.txt" >/dev/null 2>&1; then
  echo "ВНИМАНИЕ: на 127.0.0.1:$PORT никто не отвечает — контейнер zapas запущен?"
  echo "  docker compose -f docker-compose.prod.yml up -d   (в папке с compose zapas)"
  exit 1
fi
BODY="$(curl -sk -m 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)"
if grep -q "Что у нас есть" <<<"$BODY"; then
  echo "Готово: https://$DOMAIN отвечает сервисом zapas."
else
  echo "ВНИМАНИЕ: https://$DOMAIN отвечает не zapas. Кто перехватывает домен:"
  nginx -T 2>/dev/null | grep -nE "server_name|default_server" | head -40
  exit 1
fi

# ---------- 6. сжатие действительно работает ----------
WASM="$(curl -sk -m 5 -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: gzip' \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/assets/vendor/zxing/zxing_reader.wasm" || echo 0)"
if [ "$WASM" -gt 0 ] && [ "$WASM" -lt 600000 ]; then
  echo "Сжатие работает: распознаватель уезжает как $WASM байт вместо 946860."
else
  echo "ВНИМАНИЕ: распознаватель отдаётся несжатым ($WASM байт). Проверьте gzip_types и gzip_proxied."
fi
