# Checklist de replicação (Iara → Natália, Diana, Victoria)

Tudo que foi feito na Iara e no painel e que precisa ser conferido nas outras agentes. Marcar cada item só depois de confirmar com o Thiago.
Situação: [ ] pendente · [x] feito e confirmado.

## Já feito na Iara (replicar nas outras)
- [ ] **Lembrete de cliente grava na memória do agente.** No fluxo "AGENDAMENTOS MENSAGENS <agente>", nó Postgres "Gravar na Memória da <agente>" entre "MARCAR COMO ENVIADO" e "If" (On Error: Continue). Muda a tabela de memória e o prefixo da sessão por agente (Iara: `chat_lives`, sessão `tm-lives <telefone> chats`; Natália: `chat_vendas`). O WHERE exclui o número do próprio Thiago.
  - Iara: [x] · Natália: [ ] · Diana: [ ] · Victoria: [ ]
- [ ] **Detector de loop** (redesenho de 30/09, aplicado na Iara).
  - Natália: [ ] · Diana: [ ] · Victoria: [ ]

## Painel — recursos novos que a Natália vai usar (integração do fluxo dela com o painel)
- [ ] Casa de Shows: consultar disponibilidade, vender, conferir preço/palavra-chave, registrar interesse (rotas em `/n8n/casa-de-shows/...`).
- [ ] Contratações: lançar e consultar pelo telefone (`/n8n/casa-de-shows/hirings`).
- [ ] Ingresso e contrato em PDF gerados pelo painel (Gotenberg + modelos com variáveis; imagens embutidas em base64).
- [ ] Proposta (orçamento): terceiro tipo de documento; padrão só para empresa e cerimonialista, mas liberável para qualquer contratante.
- [ ] Tipo do contratante na ficha (cliente geral, cerimonialista, empresa) e protocolos de contratação (ler a parte do prompt da Natália).
- [ ] Mapa e fotos dos setores guardados no painel por evento/setor (hoje fixos no fluxo).
- [ ] Comprovantes e pagamentos no painel (duplicidade/recência e chaves Pix).
- [ ] Importar a lista JF pelo painel (Tipo Comprador/Contratante vira perfil; sem Tipo = lead).
- [ ] Campanha de aniversariantes (não exige N8N; usa o envio de campanhas da instância da empresa).

## Servidor / implantação
- [ ] Variável `N8N_DATABASE_URL` no Coolify (conexão com o Postgres do N8N, para gravar lembretes na tabela `agendamentos_mensagens`).
- [ ] Deploy após cada commit; as migrações rodam sozinhas.

## Plano de vendas / proposta comercial
- [ ] Atualizar o plano de vendas com: Programa de assinaturas (antigo "Programa de benefícios"), Programa de benefícios por indicação (módulo próprio, fora dos planos), Casa de Shows (fora dos planos), Aniversariantes (benefício do plano Advanced, dentro de Campanhas), Contratações, geração de documentos em PDF.
- [ ] Guardar uma cópia da proposta comercial como está antes de alterar (o Thiago ainda não tem o arquivo; ele trará o modelo).

## Delivery
- Módulo `delivery` (opcional): passo 28 em `src/tenant.js`; guia do atendente em `docs/delivery-agente.md`.

## Equipe e acessos / Restaurante
- Funções e acessos: `src/funcoes.js` (tabela `company_funcoes`, colunas novas em `users`). O bloqueio vale no servidor (`bloqueioPorFuncao`); toda tela nova precisa entrar em `TELAS`, `ROTAS_DA_TELA` (e, se lê dados de outras, `LEITURAS_DA_TELA`).
- Restaurante (módulo `restaurante`, passo 29): telas `rst_salao`, `rst_cozinha`, `rst_caixa`, `rst_gestao`. Usa o cardápio do Delivery (coluna `station` em `dlv_items`). Não é exposto ao atendente (n8n).

## Casa de Shows: mapa e fotos dos setores
- Passo 30 (`shows_media`). Painel: aba Setores (mapa do espaço no topo; fotos dentro da edição do setor). O atendente consulta `GET /n8n/casa-de-shows/media` (ou `?sector_id=`) e recebe `map.url` e `sectors[].photos[].url` para enviar ao cliente; o envio e a exclusão são só do painel.
- Passo 31 (`shows_sale_payments`). Pagamentos da venda na Casa de Shows: `POST /casa-de-shows/sales/:id/payments` (forma pix/dinheiro/cartao/parceiro/cortesia/outro, valor, `pix_key_id`, `payment_id` de um comprovante aceito em Recebimentos; um comprovante só paga uma venda), `GET .../payments`, `DELETE /casa-de-shows/payments/:id` (só painel) e `GET /casa-de-shows/payments/summary?event_id=&date=` (previsto x recebido, por forma e por chave/beneficiário). A lista de vendas traz `paid` e `courtesy`.

## Casa de Shows
- Chave interna do módulo `casa_de_shows`; rotas `/api/casa-de-shows/...` e `/n8n/casa-de-shows/...`; tabelas com prefixo `shows_`. A migração (`node src/migrate.js`) converte o que já estava gravado com o nome antigo.
- Locais e formatos (passo 33, tabelas `shows_venues`, `shows_layouts`, `shows_layout_sectors`, `shows_layout_tables`, `shows_event_setup`): cada setor pertence a um local; um formato escolhe os setores que valem, o espaço de cada um e, se quiser, as mesas aceitas. O evento escolhe local e formato em `PUT /casa-de-shows/events/:id/setup` (sem escolha vale o primeiro local e o formato padrão, como antes). O atendente recebe `venue` e `layout` em `availability` e em `events`, e consulta o mapa do local pelo evento com `GET /n8n/casa-de-shows/media?event_id=`. Rotas novas: `/casa-de-shows/venues`, `/casa-de-shows/layouts`.
- Pagamentos no painel (Casa de Shows → Vendas): coluna "Pagamento" com a situação (Paga, Falta R$, Pendente, Cortesia), botão para lançar pagamentos (Pix com chave e comprovante de Recebimentos, dinheiro, cartão, parceiro, cortesia) e resumo do evento com previsto, recebido, em aberto e total por forma e por chave Pix. A função da equipe com a tela da Casa de Shows também lê as chaves Pix e os comprovantes de Recebimentos.
- Passo 35 (`shows_event_pix`). Chaves Pix por evento com rodízio por valor: `GET/PUT /casa-de-shows/events/:id/pix` (PUT só painel; corpo `{ keys: [{ key_id, limit_amount? }] }` na ordem do rodízio). A chave da vez é a primeira ativa que ainda não recebeu o limite NESTE evento (Pix lançado nas vendas, sem canceladas); se todas encheram, fica a última e vem `all_full`. Evento sem chaves próprias usa a primeira chave ativa da empresa. A rota de preço do atendente (`GET /casa-de-shows/events/:id/price`) já devolve `pix_key` e `pix_all_full`, então o fluxo da Natália não precisa de ajuste manual quando o rodízio muda. Duplicar o evento copia o rodízio. No painel: Casa de Shows → escolher o evento → Condições do evento → Chaves Pix do evento; ao lançar pagamento Pix a chave da vez já vem preenchida.
- Passo 36 (`shows_event_lots`). Lotes de ingresso por evento: `GET/PUT /casa-de-shows/events/:id/lots` (PUT só painel; corpo `{ lots: [{ id?, name, price, valid_until?, max_qty? }] }` em ordem; o lote fecha pelo prazo OU ao esgotar `max_qty` ingressos (pessoas), o que vier primeiro; só o último pode ficar sem prazo e sem quantidade; mandar o `id` preserva as vendas do lote, e a venda guarda o `lot_id` em que foi vendida; `{ lots: [] }` volta ao preço único). O preço vigente é o do primeiro lote cujo prazo não venceu; lote sem prazo vale até o começo do evento, e depois entra o valor da portaria (`door_price`). Sem portaria, o último lote continua valendo. A rota de preço do atendente devolve `lot`, `lot_until`, `lot_qty`, `lot_remaining` (quantos ingressos restam), `next_lot` (o que vem a seguir e a que valor) e `tier` (`lote`, `portaria` ou `normal`); a palavra-chave de desconto incide sobre o valor do lote. Evento sem lotes segue com o preço único antigo. Duplicar o evento copia os lotes com as datas deslocadas. No painel: Casa de Shows → evento → Condições do evento → Ingresso por pessoa.
- Passo 38 (mesa reservada). Uma venda vira mesa reservada quando o dono compra a mesa e os lugares que sobram são vendidos a convidados: `GET /casa-de-shows/sales/:id/held` (lugares, palavra, convidados), `PUT .../held` (só painel; `{ enabled: true, word, kind: percent|price, value }` liga/ajusta, `{ enabled: false }` desliga sem convidados, `{ closed: true|false }` encerra/reabre a venda pela palavra) e `POST .../guests` (`price_mode`: `mesa` com o desconto da mesa, `normal` valor vigente, `manual` com `unit_price`). Cada convidado é uma venda ligada à mesa (`host_sale_id`): debita lugares da mesa e não ocupa espaço novo do setor. O atendente usa o fluxo de sempre: `POST /casa-de-shows/sales` com `event_id` e `code` (a palavra da mesa) coloca a pessoa na mesa; `GET /casa-de-shows/events/:id/price?code=` devolve `held.free_seats` e, com a mesa lotada ou encerrada, `code_valid: false` com o motivo. O desconto é percentual ou valor fixo sobre o valor vigente (lote ou portaria) e nunca encarece. Os lugares que sobrarem na portaria são vendidos à mão pela equipe (`price_mode` normal ou manual). Cancelar um convidado devolve os lugares; a mesa com convidados não pode ser cancelada nem apagada. No painel: Casa de Shows → Vendas → botão "Mesa reservada" da venda do dono.
