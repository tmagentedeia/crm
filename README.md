# CRM

Node + Express + Postgres (backend) e React (painel). Várias empresas na mesma instalação: cada empresa tem o seu
login, a sua agenda individual por profissional, o CRM de leads/clientes, retorno de inativos, dashboard,
tema claro/escuro e logotipo customizável.

## Como os dados são guardados
- Schema `public`: tabelas gerais (`companies`, `users`, `tenant_versions`).
- Um schema por empresa (`company_<id>`): categorias, serviços, profissionais, clientes, agendamentos, fila de espera,
  comandos do agente. A estrutura vem de `db/tenant.sql`; mudanças futuras entram em `TENANT_STEPS` (`src/tenant.js`)
  e rodam sozinhas em todas as empresas no deploy.
- Cada requisição roda no schema da empresa dela (`src/db.js`), então uma empresa nunca enxerga os dados de outra.
- Backup de uma empresa só: `pg_dump -n company_<id>` (mais as linhas dela em `companies` e `users`).

## Rodar no Coolify
1. Crie um Postgres separado e copie a connection string.
2. Suba este projeto (Dockerfile na raiz) e defina as variáveis de `.env.example`.
3. O container cria as tabelas sozinho na primeira subida (`src/migrate.js`).
4. Acesse o site, clique em "Criar conta" e cadastre a sua empresa. Depois mude `ALLOW_SIGNUP=false` se não quiser cadastro aberto.

## Integração com o N8N
Mesmas rotas do painel, em `/n8n/...`, com os headers:
- `x-api-key`: valor de `N8N_API_KEY`
- `x-company-id`: id da empresa no painel

Principais rotas:
- `GET  /n8n/services` — serviços com preço e duração
- `GET  /n8n/professionals` — profissionais e horários
- `GET  /n8n/availability?date=2026-10-01&service_id=1[&professional_id=2]` — horários livres
- `POST /n8n/customers` `{name, phone, chat_id, source:"ia"}` — cria/atualiza o lead pelo telefone
- `GET  /n8n/customers/by-phone/:phone`
- `POST /n8n/appointments` `{professional_id, customer_id, service_id, starts_at, source:"ia"}`
- `PATCH /n8n/appointments/:id/status` `{status}` — attended | no_show | cancelled | scheduled
- `GET  /n8n/customers-inactive?days=30` — base para campanhas de retorno

## Testes
`test/rodar.sh` cria um banco de teste do zero, carrega a empresa de demonstração e uma segunda empresa
(`src/seed_demo.js` e `test/seed_extra.mjs`) e roda os testes de isolamento entre empresas
(precisa de um Postgres de teste; veja o cabeçalho do script).

## Desenvolvimento
`npm install && npm run dev` (backend) e, em `web/`, `npm install && npm run dev` (painel com proxy p/ a API).

## Ver o painel no seu computador (Docker)
1. `docker compose up -d --build`
2. `docker compose exec app node src/seed_demo.js` (opcional: empresa de demonstração)
3. Abra http://localhost:3000 e entre com `demo@demo.com` / `demo1234`
