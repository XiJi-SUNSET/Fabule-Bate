#!/usr/bin/env bash
# Fabula Board · ECS 安装脚本（在服务器上执行：bash /tmp/install-on-ecs.sh）
# 幂等：可重复执行（服务覆盖更新、nginx 只补一次 location）
set -e

echo '== 1. 安装服务文件'
sudo mkdir -p /opt/fabula-board/data
sudo cp /tmp/board-server.py /opt/fabula-board/board-server.py
sudo chown -R ecs-user:ecs-user /opt/fabula-board
sudo chmod 755 /opt/fabula-board/board-server.py

echo '== 2. systemd 单元'
sudo cp /tmp/fabula-board.service /etc/systemd/system/fabula-board.service
sudo systemctl daemon-reload
sudo systemctl reset-failed fabula-board 2>/dev/null || true
sudo systemctl enable fabula-board
# 必须 restart（不是 enable --now）：对已运行的服务 enable --now 不重启，
# 会出现"文件更新了但进程还在跑旧代码"的幽灵故障（实测踩到）
sudo systemctl restart fabula-board
sleep 2
systemctl is-active fabula-board || (sudo journalctl -u fabula-board -n 20 --no-pager; exit 1)

echo '== 3. Nginx 反代（备份后 patch，只补一次）'
sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-fabula-board
sudo python3 - <<'PYEOF'
p = '/etc/nginx/nginx.conf'
s = open(p, encoding='utf-8').read()
if 'fabula-board' in s:
    print('nginx: already patched')
else:
    blk = '''        location /fabula-board/ {
            proxy_pass http://127.0.0.1:8787;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            client_max_body_size 24m;
        }

'''
    anchor = '        location = /404.html {'
    if anchor not in s:
        raise SystemExit('nginx anchor not found')
    s = s.replace(anchor, blk + anchor, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('nginx: patched')
PYEOF
sudo nginx -t
sudo systemctl reload nginx

echo '== 4. 回路验证'
SECRET=$(cat /opt/fabula-board/data/secret.txt)
echo "secret=$SECRET"
curl -s -o /dev/null -w 'direct-8787: %{http_code}\n' "http://127.0.0.1:8787/s/$SECRET/api/board"
curl -s -o /dev/null -w 'nginx-8080: %{http_code}\n' "http://127.0.0.1:8080/fabula-board/s/$SECRET/api/board"
echo '== install done'
