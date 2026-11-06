#!/bin/sh

set -eu

root_password="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"

if [ -z "$root_password" ]; then
    echo "database health check: root password is unavailable" >&2
    exit 1
fi

exec mariadb \
    --protocol=tcp \
    --host=127.0.0.1 \
    --user=root \
    --password="$root_password" \
    --batch \
    --skip-column-names \
    --execute="SELECT 1"
