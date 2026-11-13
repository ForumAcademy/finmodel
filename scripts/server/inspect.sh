#!/usr/bin/env bash
# Осмотр сервера сборщика: только чтение. Ничего не устанавливает и не меняет.
# Запускается от пользователя finmodel (без root) через .github/workflows/server-inspect.yml.
set -u
h() { printf '\n### %s\n```\n' "$1"; }
e() { printf '```\n'; }

h "Система"; uname -srm; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uptime; whoami; id; e
h "Процессор и память"; nproc; free -h; e
h "Диск"; df -h -x tmpfs -x devtmpfs -x overlay 2>/dev/null; echo; du -sh "$HOME" 2>/dev/null; e
h "Самые затратные процессы (память)"; ps -eo user,pid,%cpu,%mem,rss,comm --sort=-rss | head -15; e
h "Открытые порты (TCP, слушают)"; ss -tln 2>/dev/null; e
h "Веб-сервер"
for b in nginx apache2 httpd caddy traefik; do command -v "$b" >/dev/null && echo "$b: $(command -v $b)"; done
nginx -v 2>&1 || true
systemctl is-active nginx apache2 caddy 2>/dev/null | paste -sd' ' || true
e
h "nginx: сайты (только server_name, listen, proxy_pass, root)"
for d in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    [ -e "$f" ] || continue
    echo "== $f"
    grep -hE '^\s*(server_name|listen|proxy_pass|root|ssl_certificate)\s' "$f" 2>/dev/null | sed 's/^\s*//' | sort -u || echo "(нет прав на чтение)"
  done
done
e
h "TLS-сертификаты (certbot)"; command -v certbot && certbot --version 2>&1; ls /etc/letsencrypt/live 2>&1 | head; e
h "Работающие службы"; systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}'; e
h "Контейнеры"; command -v docker && (docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' 2>&1 | head -20); e
h "Языки и инструменты"
for c in python3 node npm pnpm git curl openssl pm2 uv pip3; do command -v $c >/dev/null && echo "$c: $($c --version 2>&1 | head -1)"; done
python3 -c 'import venv; print("python venv: есть")' 2>&1
e
h "Ограничение ресурсов для сборщика (cgroup v2, systemd --user)"
stat -fc %T /sys/fs/cgroup; cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null
echo "user cgroup controllers: $(cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers 2>/dev/null || echo нет)"
loginctl show-user "$(whoami)" -p Linger 2>/dev/null || echo "Linger: неизвестно"
systemctl --user is-system-running 2>&1 || true
e
h "Сеть: файрвол"; command -v ufw >/dev/null && echo "ufw установлен (статус виден только root)"; e
h "Крон пользователя finmodel"; crontab -l 2>&1 | head; e
