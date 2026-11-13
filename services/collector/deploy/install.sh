#!/usr/bin/env bash
# Установка и перезапуск сборщика на сервере. Запускается от пользователя finmodel
# (без root) workflow'ом collector-deploy.yml. Меняет только ~/collector и
# ~/.config/systemd/user; общие настройки сервера не трогает.
set -euo pipefail
D="$HOME/collector"
mkdir -p "$D/certs" "$HOME/.config/systemd/user"
# Файлы сборщика уже распакованы в ~/collector (workflow collector-deploy.yml).

# Токен доступа: создаётся один раз на сервере и в журнал не выводится.
if [ ! -s "$D/.env" ]; then
  umask 077
  printf 'COLLECTOR_TOKEN=%s\n' "$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')" > "$D/.env"
  echo "Создан новый токен доступа (в ~/collector/.env)"
fi
chmod 600 "$D/.env"

# Российский корневой сертификат (Минцифры, Госуслуги) — только в папку сборщика.
CA="$D/certs/russian_trusted_root_ca.pem"
if [ ! -s "$CA" ]; then
  curl -fsS --max-time 30 -o "$CA.tmp" https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
  openssl x509 -in "$CA.tmp" -noout >/dev/null   # это действительно сертификат
  mv "$CA.tmp" "$CA"
fi
echo "Сертификат: $(openssl x509 -in "$CA" -noout -subject -enddate | tr '\n' ' ')"
echo "Отпечаток SHA-256: $(openssl x509 -in "$CA" -noout -fingerprint -sha256 | cut -d= -f2)"

cp "$D/deploy/finmodel-collector.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable finmodel-collector.service >/dev/null 2>&1 || true
systemctl --user restart finmodel-collector.service
sleep 2
systemctl --user --no-pager --lines=5 status finmodel-collector.service | sed -n '1,12p' || true
echo "Автозапуск после перезагрузки (Linger): $(loginctl show-user "$(whoami)" -p Linger --value 2>/dev/null)"

# Проверка: сборщик отвечает и ходит в источники.
curl -fsS http://127.0.0.1:3300/health; echo
TOK="$(sed -n 's/^COLLECTOR_TOKEN=//p' "$D/.env")"
for q in "v1/geocode?address=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0%2C%20%D0%9B%D1%8F%D0%BB%D0%B8%D0%BD%20%D0%BF%D0%B5%D1%80%D0%B5%D1%83%D0%BB%D0%BE%D0%BA%2C%2021" \
         "v1/nspd/search?query=77%3A01%3A0001028%3A2999"; do
  code=$(curl -s -o /tmp/finmodel-collector-check.json -w '%{http_code}' -H "X-Collector-Token: $TOK" "http://127.0.0.1:3300/$q")
  echo "/${q%%\?*}: HTTP $code, $(head -c 300 /tmp/finmodel-collector-check.json)"
done
rm -f /tmp/finmodel-collector-check.json
