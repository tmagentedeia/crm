#!/bin/bash
# Cria um banco de teste do zero, carrega a empresa de demonstração e os dados extras, e roda os testes de isolamento.
# Precisa de um Postgres de teste (PGBASE = conexão sem banco, ex.: postgres://postgres@/postgres?host=/var/tmp/pgtest&port=55432)
set -e
cd "$(dirname "$0")/.."
PGBASE=${PGBASE:-"postgres://postgres@/postgres?host=/var/tmp/pgtest&port=55432"}
DB=$(echo "$PGBASE" | sed "s#@/postgres?#@/crmtest?#")
psql "$PGBASE" -qc "drop database if exists crmtest" -c "create database crmtest"
export DATABASE_URL="$DB" JWT_SECRET=x N8N_API_KEY=k ALLOW_SIGNUP=true ADMIN_EMAILS=demo@demo.com PORT=3999
node src/migrate.js
node src/migrate.js   # rodar de novo não pode quebrar nem duplicar
node src/seed_demo.js
node test/seed_extra.mjs
node src/index.js > /tmp/crm-test.log 2>&1 &
PID=$!
sleep 2
node test/isolamento.mjs; R=$?
kill $PID
exit $R
