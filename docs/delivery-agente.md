# Módulo Delivery — guia para o atendente (N8N)

Módulo opcional (desligado por padrão). Ligue em Administração → empresa → módulos → Delivery.
Avisos ao cliente por WhatsApp exigem `N8N_DATABASE_URL` e a instância (`whatsapp_instance`) da empresa.

Todas as rotas em `/n8n/...` com `x-api-key` e `x-company-id`.

| Rota | Uso |
|---|---|
| `GET /n8n/delivery/status` | Aberto agora? Horários, taxa mínima, tempo estimado |
| `GET /n8n/delivery/menu` | Cardápio completo com grupos e opções |
| `POST /n8n/delivery/quote` | Calcula total (itens, taxa do bairro, cupom). O servidor sempre recalcula os preços |
| `POST /n8n/delivery/orders` | Cria o pedido (mesmo corpo do quote + cliente, telefone, endereço, pagamento) |
| `GET /n8n/delivery/orders/by-phone/:phone` | Pedidos do cliente (acompanhamento) |
| `GET /n8n/delivery/orders/:id` | Detalhe de um pedido |

Fluxo sugerido: status → menu → conversa → quote (mostrar total ao cliente) → orders.
Pedido fora do horário ou abaixo do mínimo é recusado (o painel pode forçar com `force:true`; o atendente não).
Etapas: novo → confirmado → em preparo → pronto → saiu para entrega → entregue (ou cancelado). O cliente é avisado a cada mudança.
