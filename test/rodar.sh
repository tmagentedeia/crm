#!/bin/bash
# Cria um banco de teste do zero, carrega a empresa de demonstração e os dados extras, e roda os testes:
#  - isolamento.mjs: isolamento entre empresas e chaves de integração (servidor normal, porta 3999)
#  - atendente.mjs: manual com versões e atualizações provisórias
#  - modelos.mjs: salvar como modelo e começar do modelo
#  - acesso_admin.mjs: "abrir painel" do administrador
#  - sessao.mjs: sessão do painel renova com o uso
#  - senha.mjs: alterar senha na tela de login (dono ou equipe), sem estar logado
#  - venda.mjs: venda com valor (pagamento aceito ou pedido pago) vira cliente
#  - bloqueios.mjs: lista de atendimentos bloqueados (precisa do redis-server instalado)
#  - conexoes.mjs: Redis e banco de conversas próprios de uma empresa (cifrados; vazio = padrão do servidor)
#  - agenda_unica.mjs: empresa sem profissional atende por uma agenda com o nome da empresa
#  - lembretes.mjs: lembrete de agendamento enviado pelo painel (WhatsApp falso)
#  - agendamentos.mjs: aba Agendamentos do Atendente (lista, edita e cancela mensagens agendadas)
#  - chave_global.mjs: chave global desligada com ALLOW_GLOBAL_KEY=false (segundo servidor, porta 3998)
# Precisa de um Postgres de teste (PGBASE = conexão sem banco, ex.: postgres://postgres@/postgres?host=/var/tmp/pgtest&port=55432)
set -e
cd "$(dirname "$0")/.."
PGBASE=${PGBASE:-"postgres://postgres@/postgres?host=/var/tmp/pgtest&port=55432"}
DB=$(echo "$PGBASE" | sed "s#@/postgres?#@/crmtest?#")
psql "$PGBASE" -qc "drop database if exists crmtest" -c "create database crmtest"
export DATABASE_URL="$DB" JWT_SECRET=x N8N_API_KEY=k ALLOW_SIGNUP=true ADMIN_EMAILS=demo@demo.com
# tabela de mensagens agendadas do WhatsApp (no sistema real fica no banco do N8N); aqui é uma cópia no próprio banco de teste
export N8N_DATABASE_URL="$DB"
psql "$DB" -qc "create table agendamentos_mensagens (id bigserial primary key, telefone text, mensagem text, data_hora_envio timestamptz, instancia text, nome text, origem text, status text not null default 'pendente', tentativas int not null default 0)"
node src/migrate.js
node src/migrate.js   # rodar de novo não pode quebrar nem duplicar
# empresa criada antes do módulo Atendente: tira as tabelas e volta a versão; o migrate tem que recriar
psql "$DB" -qc "select 1" >/dev/null
node src/seed_demo.js
psql "$DB" -qc "update public.companies set campaign_prog_desde=null where id=1"   # a demonstração fica no padrão; a progressiva tem teste próprio
psql "$DB" -qc "drop table company_1.agent_manual_versions, company_1.agent_updates, company_1.assistant_manual_versions, company_1.assistant_updates; update public.tenant_versions set version=1 where company_id=1"
node src/migrate.js
psql "$DB" -qc "alter table company_1.services drop constraint services_kind_check, drop column kind; update public.tenant_versions set version=19 where company_id=1"
node src/migrate.js
psql "$DB" -qc "drop table company_1.product_sales; update public.tenant_versions set version=20 where company_id=1"
node src/migrate.js
psql "$DB" -qc "drop table company_1.commission_service_rates, company_1.commission_rates, company_1.commission_settings; update public.tenant_versions set version=21 where company_id=1"
node src/migrate.js
psql "$DB" -qc "drop table company_1.shows_cancel_requests, company_1.shows_attendee_log, company_1.shows_attendees, company_1.shows_event_setup, company_1.shows_layout_tables, company_1.shows_layout_sectors, company_1.shows_layouts, company_1.shows_sale_payments, company_1.shows_media, company_1.shows_sales, company_1.shows_event_sectors, company_1.shows_sector_tables, company_1.shows_extras, company_1.shows_event_interest, company_1.shows_event_codes, company_1.shows_event_conditions, company_1.shows_table_types, company_1.shows_sectors, company_1.shows_venues; update public.tenant_versions set version=22 where company_id=1"
node src/migrate.js
psql "$DB" -qc "drop table company_1.birthday_sends, company_1.birthday_settings; alter table company_1.campaigns drop column kind; update public.tenant_versions set version=23 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.birthday_settings" | grep -q 1 || { echo "FALHOU: migração dos aniversariantes"; exit 1; }
psql "$DB" -qc "drop table company_1.shows_hirings; update public.tenant_versions set version=24 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.shows_hirings" | grep -q 0 || { echo "FALHOU: migração das contratações"; exit 1; }
psql "$DB" -qc "update company_1.loyalty_settings set program_name='Programa de benefícios'; update public.tenant_versions set version=25 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select program_name from company_1.loyalty_settings" | grep -q "Programa de assinaturas" || { echo "FALHOU: migração do nome do programa de assinaturas"; exit 1; }
psql "$DB" -qc "drop table company_1.doc_files, company_1.doc_templates, company_1.doc_settings; update public.tenant_versions set version=26 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.doc_templates" | grep -q 0 || { echo "FALHOU: migração dos documentos"; exit 1; }
psql "$DB" -qc "drop table company_1.dlv_order_events, company_1.dlv_order_items, company_1.dlv_orders, company_1.dlv_coupons, company_1.dlv_couriers, company_1.dlv_zones, company_1.dlv_options, company_1.dlv_option_groups, company_1.dlv_items, company_1.dlv_categories, company_1.dlv_settings; update public.tenant_versions set version=27 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.dlv_orders" | grep -q 0 || { echo "FALHOU: migração do delivery"; exit 1; }
psql "$DB" -tc "select count(*) from company_1.shows_sales" | grep -q 0 || { echo "FALHOU: migração da Casa de Shows"; exit 1; }
psql "$DB" -tc "select count(*) from company_1.commission_settings" | grep -q 1 || { echo "FALHOU: migração das comissões"; exit 1; }
psql "$DB" -tc "select count(*) from company_1.product_sales" | grep -q 0 || { echo "FALHOU: migração das vendas"; exit 1; }
psql "$DB" -tc "select count(*) from company_1.services where kind='service'" | grep -qv '^ *0$' || { echo "FALHOU: migração do catálogo"; exit 1; }
psql "$DB" -tc "select count(*) from company_1.agent_updates, company_1.assistant_updates" | grep -q 0 || { echo "FALHOU: migração do Atendente"; exit 1; }
psql "$DB" -qc "drop table company_1.rst_payments, company_1.rst_tab_items, company_1.rst_tabs, company_1.rst_tables, company_1.rst_settings; alter table company_1.dlv_items drop column station; update public.tenant_versions set version=28 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.rst_settings" | grep -q 1 || { echo "FALHOU: migração do restaurante"; exit 1; }
psql "$DB" -qc "drop table company_1.shows_media; update public.tenant_versions set version=29 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.shows_media" | grep -q 0 || { echo "FALHOU: migração das fotos da Casa de Shows"; exit 1; }
psql "$DB" -qc "drop table company_1.shows_sale_payments; update public.tenant_versions set version=30 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.shows_sale_payments" | grep -q 0 || { echo "FALHOU: migração dos pagamentos da Casa de Shows"; exit 1; }
psql "$DB" -qc "update public.companies set modules = modules - 'casa_de_shows' || jsonb_build_object('scenarium', true) where id=1"
node src/migrate.js
psql "$DB" -tc "select modules ? 'casa_de_shows' and not (modules ? 'scenarium') from public.companies where id=1" | grep -q t || { echo "FALHOU: troca da chave scenarium por casa_de_shows"; exit 1; }
psql "$DB" -qc "update public.companies set modules = modules - 'casa_de_shows' where id=1"
psql "$DB" -qc "drop table company_1.shows_event_setup, company_1.shows_layout_tables, company_1.shows_layout_sectors, company_1.shows_layouts; alter table company_1.shows_media drop column venue_id; alter table company_1.shows_sectors drop column venue_id; drop table company_1.shows_venues; update public.tenant_versions set version=32 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) = 1 and (select count(*) from company_1.shows_layouts where is_default) = 1 from company_1.shows_venues" | grep -q t || { echo "FALHOU: migração dos locais da Casa de Shows"; exit 1; }
psql "$DB" -qc "update company_1.shows_venues set name='Local principal'; update public.tenant_versions set version=33 where company_id=1"
node src/migrate.js
psql "$DB" -tAc "select name from company_1.shows_venues" | grep -q '^Padrão$' || { echo "FALHOU: nome Padrão do local"; exit 1; }
psql "$DB" -qc "alter table company_1.shows_media rename to scn_media; update public.tenant_versions set version=31 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.shows_media" | grep -q 0 || { echo "FALHOU: troca do prefixo das tabelas da Casa de Shows"; exit 1; }
psql "$DB" -qc "alter table company_1.shows_sales rename to shows_reservations; alter table company_1.shows_sale_payments rename to shows_res_payments; alter table company_1.shows_res_payments rename column sale_id to reservation_id; update public.tenant_versions set version=35 where company_id=1"
node src/migrate.js
psql "$DB" -tc "select count(*) from company_1.shows_sales" | grep -q 0 || { echo "FALHOU: troca de reserva para venda (tabela)"; exit 1; }
psql "$DB" -tc "select count(sale_id) from company_1.shows_sale_payments" | grep -q 0 || { echo "FALHOU: troca de reserva para venda (pagamentos)"; exit 1; }
node test/seed_extra.mjs
node src/migrate.js   # empresa 2 criada pelo seed nasce na estrutura base: põe em dia
# Redis de teste (bloqueios)
redis-server --port 56379 --save '' --appendonly no --daemonize yes >/dev/null
export REDIS_URL=redis://127.0.0.1:56379
FAKE_GOTENBERG_PORT=53000 node test/fake_gotenberg.mjs &
PIDG=$!
export GOTENBERG_URL=http://127.0.0.1:53000
PORT=3999 LEMBRETE_TICK_MS=300 ESPELHO_TICK_MS=300 LISTA_PAUSA_RAPIDA=1 node src/index.js > /tmp/crm-test.log 2>&1 &
PID=$!
PORT=3998 ALLOW_GLOBAL_KEY=false node src/index.js > /tmp/crm-test2.log 2>&1 &
PID2=$!
sleep 2
R=0
BASE=http://localhost:3999 node test/isolamento.mjs || R=1
BASE=http://localhost:3999 node test/atendente.mjs || R=1
BASE=http://localhost:3999 node test/assistente.mjs || R=1
BASE=http://localhost:3999 node test/bloqueado.mjs || R=1
BASE=http://localhost:3999 node test/maria_manual.mjs || R=1
BASE=http://localhost:3999 node test/produtos.mjs || R=1
BASE=http://localhost:3999 node test/vendas_produtos.mjs || R=1
BASE=http://localhost:3999 node test/comissoes.mjs || R=1
BASE=http://localhost:3999 node test/lembrete_cliente.mjs || R=1
BASE=http://localhost:3999 node test/agendamentos.mjs || R=1
BASE=http://localhost:3999 node test/planos.mjs || R=1
BASE=http://localhost:3999 node test/casa_de_shows.mjs || R=1
BASE=http://localhost:3999 node test/casa_de_shows_midia.mjs || R=1
BASE=http://localhost:3999 node test/casa_de_shows_pagamentos.mjs || R=1
BASE=http://localhost:3999 node test/casa_de_shows_locais.mjs || R=1
BASE=http://localhost:3999 node test/casa_de_shows_pix_evento.mjs || R=1
BASE=http://localhost:3999 node test/casa_de_shows_lotes.mjs || R=1
BASE=http://localhost:3999 node test/casa_de_shows_mesa_reservada.mjs || R=1
BASE=http://localhost:3999 node test/casa_de_shows_clube.mjs || R=1
BASE=http://localhost:3999 node test/parcerias.mjs || R=1
BASE=http://localhost:3999 node test/lista_evento.mjs || R=1
BASE=http://localhost:3999 node test/lista_evento_envio.mjs || R=1
BASE=http://localhost:3999 node test/lembretes.mjs || R=1
BASE=http://localhost:3999 node test/contratacoes.mjs || R=1
BASE=http://localhost:3999 node test/indicacoes.mjs || R=1
BASE=http://localhost:3999 node test/documentos.mjs || R=1
BASE=http://localhost:3999 node test/documentos_blocos.mjs || R=1
BASE=http://localhost:3999 node test/documentos_vagas.mjs || R=1
BASE=http://localhost:3999 node test/ingresso_qr.mjs || R=1
BASE=http://localhost:3999 node test/shows_importar.mjs || R=1
BASE=http://localhost:3999 node test/dashboard.mjs || R=1
BASE=http://localhost:3999 node test/shows_midia_envio.mjs || R=1
FAKE_GOTENBERG_PORT=${FAKE_GOTENBERG_PORT:-53000} BASE=http://localhost:3999 node test/shows_venda_ia.mjs || R=1
BASE=http://localhost:3999 node test/contatos_agente.mjs || R=1
BASE=http://localhost:3999 node test/contatos_assunto.mjs || R=1
BASE=http://localhost:3999 node test/diretrizes.mjs || R=1
BASE=http://localhost:3999 node test/ferramentas.mjs || R=1
BASE=http://localhost:3999 node test/espelho_contatos.mjs || R=1
BASE=http://localhost:3999 node test/delivery.mjs || R=1
BASE=http://localhost:3999 node test/equipe.mjs || R=1
BASE=http://localhost:3999 node test/restaurante.mjs || R=1
BASE=http://localhost:3999 node test/modelos.mjs || R=1
BASE=http://localhost:3999 node test/acesso_admin.mjs || R=1
BASE=http://localhost:3999 node test/sessao.mjs || R=1
BASE=http://localhost:3999 node test/senha.mjs || R=1
BASE=http://localhost:3999 node test/bloqueios.mjs || R=1
BASE=http://localhost:3999 node test/conexoes.mjs || R=1
BASE=http://localhost:3999 node test/agenda_unica.mjs || R=1
BASE=http://localhost:3999 node test/confirmacao.mjs || R=1
BASE=http://localhost:3999 node test/clube.mjs || R=1
BASE=http://localhost:3999 node test/importar_clube.mjs || R=1
BASE=http://localhost:3999 node test/pedidos.mjs || R=1
BASE=http://localhost:3999 node test/eventos.mjs || R=1
BASE=http://localhost:3999 node test/financeiro.mjs || R=1
BASE=http://localhost:3999 node test/venda.mjs || R=1
node test/telefone.mjs || R=1
node test/passos.mjs || R=1
BASE=http://localhost:3999 node test/campanhas.mjs || R=1
BASE=http://localhost:3999 node test/aniversario.mjs || R=1
BASE=http://localhost:3999 node test/campanhas_progressivo.mjs || R=1
BASE=http://localhost:3999 node test/contatos_lote.mjs || R=1
BASE=http://localhost:3999 node test/excecoes.mjs || R=1
BASE=http://localhost:3999 node test/exclusao.mjs || R=1
BASE=http://localhost:3999 node test/apagar_massa.mjs || R=1
BASE=http://localhost:3998 node test/chave_global.mjs || R=1
kill $PID $PID2 $PIDG
redis-cli -p 56379 shutdown nosave 2>/dev/null || true
exit $R
