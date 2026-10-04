# Checklist de replicação (Iara → Natália, Diana, Victoria)

Tudo que foi feito na Iara e no painel e que precisa ser conferido nas outras agentes. Marcar cada item só depois de confirmar com o Thiago.
Situação: [ ] pendente · [x] feito e confirmado.

## Já feito na Iara (replicar nas outras)
- [ ] **Lembrete de cliente grava na memória do agente.** No fluxo "AGENDAMENTOS MENSAGENS <agente>", nó Postgres "Gravar na Memória da <agente>" entre "MARCAR COMO ENVIADO" e "If" (On Error: Continue). Muda a tabela de memória e o prefixo da sessão por agente (Iara: `chat_lives`, sessão `tm-lives <telefone> chats`; Natália: `chat_vendas`). O WHERE exclui o número do próprio Thiago.
  - Iara: [x] · Natália: [ ] · Diana: [ ] · Victoria: [ ]
- [ ] **Detector de loop** (redesenho de 30/09, aplicado na Iara).
  - Natália: [ ] · Diana: [ ] · Victoria: [ ]

## Painel — recursos novos que a Natália vai usar (integração do fluxo dela com o painel)
- [ ] Scenarium: consultar disponibilidade, reservar, conferir preço/palavra-chave, registrar interesse (rotas em `/n8n/scenarium/...`).
- [ ] Contratações: lançar e consultar pelo telefone (`/n8n/scenarium/hirings`).
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
- [ ] Atualizar o plano de vendas com: Programa de assinaturas (antigo "Programa de benefícios"), Programa de benefícios por indicação (módulo próprio, fora dos planos), Scenarium (fora dos planos), Aniversariantes (benefício do plano Advanced, dentro de Campanhas), Contratações, geração de documentos em PDF.
- [ ] Guardar uma cópia da proposta comercial como está antes de alterar (o Thiago ainda não tem o arquivo; ele trará o modelo).

## Delivery
- Módulo `delivery` (opcional): passo 28 em `src/tenant.js`; guia do atendente em `docs/delivery-agente.md`.

## Equipe e acessos / Restaurante
- Funções e acessos: `src/funcoes.js` (tabela `company_funcoes`, colunas novas em `users`). O bloqueio vale no servidor (`bloqueioPorFuncao`); toda tela nova precisa entrar em `TELAS`, `ROTAS_DA_TELA` (e, se lê dados de outras, `LEITURAS_DA_TELA`).
- Restaurante (módulo `restaurante`, passo 29): telas `rst_salao`, `rst_cozinha`, `rst_caixa`, `rst_gestao`. Usa o cardápio do Delivery (coluna `station` em `dlv_items`). Não é exposto ao atendente (n8n).

## Scenarium: mapa e fotos dos setores
- Passo 30 (`scn_media`). Painel: aba Setores (mapa do espaço no topo; fotos dentro da edição do setor). O atendente consulta `GET /n8n/scenarium/media` (ou `?sector_id=`) e recebe `map.url` e `sectors[].photos[].url` para enviar ao cliente; o envio e a exclusão são só do painel.
