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

## Administração: novas empresas e módulos
Quem tem o e-mail em `ADMIN_EMAILS` vê a tela Administração:
- **Nova empresa:** cria a empresa, o login do responsável, o schema e a chave de integração, já com os módulos escolhidos.
- **Modelos:** "Salvar como modelo" (em cada empresa) guarda a estrutura: módulos, configurações (dias de inatividade, fuso, lembrete),
  categorias, serviços e o manual do atendente publicado. Nunca guarda clientes, agenda, profissionais, atualizações provisórias, logotipo,
  telefone nem a chave. Em "Nova empresa", "Começar do modelo" cria a empresa já com tudo isso (os módulos vêm marcados como no modelo e podem ser ajustados).
  Apagar um modelo não muda as empresas já criadas com ele.
- **Módulos por empresa** (`companies.modules`): Agenda, Clientes e Leads, Dashboard e Atendente. O menu de cada empresa mostra só
  o que está ligado; Configurações sempre aparece. Um módulo só está desligado quando vale explicitamente `false`, então empresas
  que nunca tiveram módulos configurados continuam vendo tudo. Desligar um módulo esconde o item do menu; as rotas da API
  continuam respondendo (assim os fluxos do N8N de uma empresa não quebram por causa do menu).
- **Chave de integração** de cada empresa (ver a seção do N8N abaixo) e o **código** da empresa, usado no `x-company-id`.

## Atendente (módulo)
Tela com duas abas. **Manual:** texto em linguagem comum com rascunho, publicação e versões anteriores (voltar uma versão a coloca como rascunho).
**Atualizações provisórias:** recados curtos (até 1000 caracteres, no máximo 10 em vigor) com início e fim opcionais, escolhidos pela pessoa
por dia e hora (no fuso da empresa). Passado o fim, saem sozinhas do atendente e ficam em "Encerradas", de onde podem ser reativadas.
Tudo é guardado por empresa (`agent_manual_versions` e `agent_updates`) e entregue ao N8N por `GET /n8n/agent/prompt`.

## Rodar no Coolify
1. Crie um Postgres separado e copie a connection string.
2. Suba este projeto (Dockerfile na raiz) e defina as variáveis de `.env.example`.
3. O container cria as tabelas sozinho na primeira subida (`src/migrate.js`).
4. Acesse o site, clique em "Criar conta" e cadastre a sua empresa. Depois mude `ALLOW_SIGNUP=false` se não quiser cadastro aberto.

## Integração com o N8N
Mesmas rotas do painel, em `/n8n/...`, com os headers:
- `x-api-key`: a chave de integração **da empresa** indicada em `x-company-id`
- `x-company-id`: id da empresa no painel

Cada empresa tem a sua chave. O administrador (e-mails em `ADMIN_EMAILS`) gera e regenera na tela Administração; a chave
aparece uma única vez, e no banco fica só o hash (SHA-256). A chave de uma empresa não vale em outra, então um
`x-company-id` errado nunca age na empresa de outro. Regenerar invalida a chave anterior na hora.

A chave global (`N8N_API_KEY`) continua valendo em qualquer empresa só durante a transição. Depois de trocar a credencial de
cada workflow pela chave da empresa, defina `ALLOW_GLOBAL_KEY=false` para desligá-la nas rotas `/n8n` (a variável
`N8N_API_KEY` continua sendo usada como segredo dos avisos que o painel envia aos webhooks).

Principais rotas:
- `GET  /n8n/agent/prompt` — texto pronto para o atendente: manual publicado + atualizações provisórias em vigor agora (`{prompt, manual, updates, published_at}`); chamar uma vez antes do agente de IA
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


## Abrir painel (administrador)
Na Administração, o botão **Abrir painel** entra no painel da empresa como o responsável dela, sem senha. O acesso dura 2 horas, mostra uma faixa "Voltar à administração" e cada abertura fica registrada na tabela `admin_access_log` (administrador, empresa, data). Não dá para encadear de uma empresa para outra.
