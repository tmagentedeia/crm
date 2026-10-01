#!/bin/bash
# Cria um banco de teste do zero, carrega a empresa de demonstração e os dados extras, e roda os testes:
#  - isolamento.mjs: isolamento entre empresas e chaves de integração (servidor normal, porta 3999)
#  - chave_global.mjs: chave global desligada com ALLOW_GLOBAL_KEY=false (segundo servidor, porta 3998)
# Precisa de um Postgres de teste (PGBASE = conexão sem banco, ex.: postgres://postgres@/postgres?host=/var/tmp/pgtest&port=55432)
set -e
cd "$(dirname "$0")/.."
PGBASE=${PGBASE:-"postgres://postgres@/postgres?host=/var/tmp/pgtest&port=55432"}
DB=$(echo "$PGBASE" | sed "s#@/postgres?#@/crmtest?#")
psql "$PGBASE" -qc "drop database if exists crmtest" -c "create database crmtest"
export DATABASE_URL="$DB" JWT_SECRET=x N8N_API_KEY=k ALLOW_SIGNUP=true ADMIN_EMAILS=demo@demo.com
node src/migrate.js
node src/migrate.js   # rodar de novo não pode quebrar nem duplicar
node src/seed_demo.js
node test/seed_extra.mjs
PORT=3999 node src/index.js > /tmp/crm-test.log 2>&1 &
PID=$!
PORT=3998 ALLOW_GLOBAL_KEY=false node src/index.js > /tmp/crm-test2.log 2>&1 &
PID2=$!
sleep 2
R=0
BASE=http://localhost:3999 node test/isolamento.mjs || R=1
BASE=http://localhost:3998 node test/chave_global.mjs || R=1
kill $PID $PID2
exit $R
