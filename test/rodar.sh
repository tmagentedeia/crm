#!/bin/bash
# Cria um banco de teste do zero, carrega a empresa de demonstração e os dados extras, e roda os testes:
#  - isolamento.mjs: isolamento entre empresas e chaves de integração (servidor normal, porta 3999)
#  - atendente.mjs: manual com versões e atualizações provisórias
#  - modelos.mjs: salvar como modelo e começar do modelo
#  - acesso_admin.mjs: "abrir painel" do administrador
#  - bloqueios.mjs: lista de atendimentos bloqueados (precisa do redis-server instalado)
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
# empresa criada antes do módulo Atendente: tira as tabelas e volta a versão; o migrate tem que recriar
psql "$DB" -qc "select 1" >/dev/null
node src/seed_demo.js
psql "$DB" -qc "drop table company_1.agent_manual_versions, company_1.agent_updates; update public.tenant_versions set version=1 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.agent_updates" | grep -q 0 || { echo "FALHOU: migração do Atendente"; exit 1; }
node test/seed_extra.mjs
# Redis de teste (bloqueios)
redis-server --port 56379 --save '' --appendonly no --daemonize yes >/dev/null
export REDIS_URL=redis://127.0.0.1:56379
PORT=3999 node src/index.js > /tmp/crm-test.log 2>&1 &
PID=$!
PORT=3998 ALLOW_GLOBAL_KEY=false node src/index.js > /tmp/crm-test2.log 2>&1 &
PID2=$!
sleep 2
R=0
BASE=http://localhost:3999 node test/isolamento.mjs || R=1
BASE=http://localhost:3999 node test/atendente.mjs || R=1
BASE=http://localhost:3999 node test/modelos.mjs || R=1
BASE=http://localhost:3999 node test/acesso_admin.mjs || R=1
BASE=http://localhost:3999 node test/bloqueios.mjs || R=1
BASE=http://localhost:3999 node test/exclusao.mjs || R=1
BASE=http://localhost:3998 node test/chave_global.mjs || R=1
kill $PID $PID2
redis-cli -p 56379 shutdown nosave 2>/dev/null || true
exit $R
