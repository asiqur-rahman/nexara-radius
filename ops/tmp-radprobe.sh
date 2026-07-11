#!/bin/bash
# Probe RADIUS UDP 1812/1813 on a remote host.
# Usage: ./ops/tmp-radprobe.sh [host] [secret]
# or: ./ops/tmp-radprobe.sh 38.242.224.225 testing123
# wsl -e bash /mnt/d/RnD/Freeradius/ops/tmp-radprobe.sh
HOST=${1:-38.242.224.225}
SECRET=${2:-testing123}

echo "Ping:"
ping -c 2 -W 2 "$HOST" || true
echo

echo "=== Status-Server UDP/1812 ==="
docker exec nexara-radius sh -c "printf 'Message-Authenticator = 0x00\n' | radclient -t 5 -r 1 ${HOST}:1812 status ${SECRET}" 2>&1 || true

echo
echo "=== Access-Request UDP/1812 ==="
docker exec nexara-radius sh -c "printf 'User-Name = probe\nUser-Password = probe\nNAS-IP-Address = 127.0.0.1\n' | radclient -t 5 -r 1 ${HOST}:1812 auth ${SECRET}" 2>&1 || true

echo
echo "=== Accounting UDP/1813 ==="
docker exec nexara-radius sh -c "printf 'Acct-Status-Type = Accounting-On\nNAS-IP-Address = 127.0.0.1\nAcct-Session-Id = probe1\n' | radclient -t 5 -r 1 ${HOST}:1813 acct ${SECRET}" 2>&1 || true
