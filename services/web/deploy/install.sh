#!/usr/bin/env bash
# Установка новой версии сайта на сервере. Запускается от пользователя finmodel
# (без root) workflow'ом web-deploy.yml. Меняет только ~/web и
# ~/.config/systemd/user; nginx, сертификаты и другие сайты не трогает.
# Аргумент — имя версии (коммит). Сборка уже распакована в ~/web/releases/<версия>.
set -euo pipefail
W="$HOME/web"
REL="$1"
mkdir -p "$W/releases" "$W/deploy" "$HOME/.config/systemd/user"

# Node.js — своя копия в ~/web/node; системный Node других сайтов не трогаем.
if [ -s "$W/incoming/node.tar.xz" ]; then
  rm -rf "$W/node.new" && mkdir -p "$W/node.new"
  tar -xJf "$W/incoming/node.tar.xz" -C "$W/node.new" --strip-components=1
  cp "$W/incoming/node.version" "$W/node.new/VERSION"
  rm -rf "$W/node.old"; [ -d "$W/node" ] && mv "$W/node" "$W/node.old"
  mv "$W/node.new" "$W/node"; rm -rf "$W/node.old"
fi
echo "Node.js: $("$W/node/bin/node" -v)"

# Настройки сайта: ~/web/.env, доступ только у finmodel, в журнал не выводится.
umask 077
touch "$W/.env"; chmod 600 "$W/.env"
if [ -s "$W/incoming/data_mos_api_key" ]; then
  grep -v '^DATA_MOS_API_KEY=' "$W/.env" > "$W/.env.new" || true
  printf 'DATA_MOS_API_KEY=%s\n' "$(tr -d '\r\n' < "$W/incoming/data_mos_api_key")" >> "$W/.env.new"
  mv "$W/.env.new" "$W/.env"
  echo "Ключ портала открытых данных Москвы записан в ~/web/.env"
fi
grep -q '^DATA_MOS_API_KEY=.' "$W/.env" && echo "Ключ портала Москвы: есть" || echo "Ключ портала Москвы: нет (добавьте секрет DATA_MOS_API_KEY в GitHub)"
rm -rf "$W/incoming"
umask 022

cp "$W/releases/$REL/deploy/"* "$W/deploy/"
cp "$W/deploy/finmodel-web.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable finmodel-web.service >/dev/null 2>&1 || true

PREV="$(readlink "$W/current" 2>/dev/null || true)"
ln -sfn "$W/releases/$REL" "$W/current"
systemctl --user restart finmodel-web.service

ok=""
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3400/; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "ОШИБКА: новая версия $REL не отвечает."
  journalctl --user -u finmodel-web.service --no-pager -n 30 || true
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    ln -sfn "$PREV" "$W/current"
    systemctl --user restart finmodel-web.service
    echo "Возвращена предыдущая версия: $(basename "$PREV")"
  fi
  exit 1
fi

# Храним три последние версии для отката.
# grep без совпадений завершается с кодом 1 — при pipefail это не ошибка.
ls -1dt "$W/releases"/*/ | tail -n +4 | { grep -vxF "$(readlink -f "$W/current")/" || true; } | xargs -r rm -rf

echo "Версия $REL работает на 127.0.0.1:3400"
for p in / /reference/sources; do
  echo "$p: HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:3400$p")"
done
pid="$(systemctl --user show -p MainPID --value finmodel-web.service)"
echo "Память сайта: $(( $(ps -o rss= -p "$pid") / 1024 )) МБ (предел 512 МБ)"
echo "Свободно памяти на сервере: $(free -m | awk '/^Mem:/{print $7}') МБ"
echo "Автозапуск после перезагрузки (Linger): $(loginctl show-user "$(whoami)" -p Linger --value 2>/dev/null)"
# Другие сайты сервера отвечают как раньше (только чтение).
for port in 3000 3100 3200 3300; do
  echo "Порт $port: HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/" || echo нет ответа)"
done
