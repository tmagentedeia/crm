# Checklist de replicação (Iara → Natália, Diana, Victoria)

Tudo que foi feito na Iara e no painel e que precisa ser conferido nas outras agentes. Marcar cada item só depois de confirmar com o Thiago.
Situação: [ ] pendente · [x] feito e confirmado.

## Já feito na Iara (replicar nas outras)
- [ ] **Lembrete de cliente grava na memória do agente.** No fluxo "AGENDAMENTOS MENSAGENS <agente>", nó Postgres "Gravar na Memória da <agente>" entre "MARCAR COMO ENVIADO" e "If" (On Error: Continue). Muda a tabela de memória e o prefixo da sessão por agente (Iara: `chat_lives`, sessão `tm-lives <telefone> chats`; Natália: `chat_vendas`). O WHERE exclui o número do próprio Thiago.
  - Iara: [x] · Natália: [ ] · Diana: [ ] · Victoria: [ ]
- [ ] **Detector de loop** (redesenho de 30/09, aplicado na Iara).
  - Natália: [ ] · Diana: [ ] · Victoria: [ ]

## Painel — recursos novos que a Natália vai usar (integração do fluxo dela com o painel)
- [ ] Casa de Shows: consultar disponibilidade, reservar, conferir preço/palavra-chave, registrar interesse (rotas em `/n8n/casa-de-shows/...`).
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
- Passo 31 (`shows_res_payments`). Pagamentos da reserva na Casa de Shows: `POST /casa-de-shows/reservations/:id/payments` (forma pix/dinheiro/cartao/parceiro/cortesia/outro, valor, `pix_key_id`, `payment_id` de um comprovante aceito em Recebimentos; um comprovante só paga uma reserva), `GET .../payments`, `DELETE /scenarium/payments/:id` (só painel) e `GET /scenarium/payments/summary?event_id=&date=` (previsto x recebido, por forma e por chave/beneficiário). A lista de reservas traz `paid` e `courtesy`.

## Casa de Shows
- Chave interna do módulo `casa_de_shows`; rotas `/api/casa-de-shows/...` e `/n8n/casa-de-shows/...`; tabelas com prefixo `shows_`. A migração (`node src/migrate.js`) converte o que já estava gravado com o nome antigo.
- Locais e formatos (passo 33, tabelas `shows_venues`, `shows_layouts`, `shows_layout_sectors`, `shows_layout_tables`, `shows_event_setup`): cada setor pertence a um local; um formato escolhe os setores que valem, o espaço de cada um e, se quiser, as mesas aceitas. O evento escolhe local e formato em `PUT /casa-de-shows/events/:id/setup` (sem escolha vale o primeiro local e o formato padrão, como antes). O atendente recebe `venue` e `layout` em `availability` e em `events`, e consulta o mapa do local pelo evento com `GET /n8n/casa-de-shows/media?event_id=`. Rotas novas: `/casa-de-shows/venues`, `/casa-de-shows/layouts`.
- Pagamentos no painel (Casa de Shows → Reservas): coluna "Pagamento" com a situação (Paga, Falta R$, Pendente, Cortesia), botão para lançar pagamentos (Pix com chave e comprovante de Recebimentos, dinheiro, cartão, parceiro, cortesia) e resumo do evento com previsto, recebido, em aberto e total por forma e por chave Pix. A função da equipe com a tela da Casa de Shows também lê as chaves Pix e os comprovantes de Recebimentos.
