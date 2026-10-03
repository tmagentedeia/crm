// Financeiro: chaves Pix e conferência/baixa de comprovantes. Uso: BASE=http://localhost:3999 node test/financeiro.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (e, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()).token;
const A = await login('demo@demo.com', 'demo1234');
const B = await login('dois@x.com', 'senhasenha');
const T = (m, p, b, t = A) => call(m, p, t, b);
// horário do comprovante no fuso da empresa (America/Sao_Paulo, UTC-3)
const sp = (minAtras) => { const d = new Date(Date.now() - minAtras * 60000 - 3 * 3600000); return d.toISOString().slice(0, 16).replace('T', ' '); };

// ---- chaves Pix ----
check('sem tipo = 400', (await T('POST', '/api/finance/keys', { key: 'a@b.com' })).status === 400);
check('e-mail inválido para o tipo = 400', (await T('POST', '/api/finance/keys', { key_type: 'email', key: 'abc' })).status === 400);
check('cpf com tamanho errado = 400', (await T('POST', '/api/finance/keys', { key_type: 'cpf', key: '123' })).status === 400);
const k1 = (await T('POST', '/api/finance/keys', { key_type: 'email', key: 'Pix.Teste@Gmail.com', beneficiary: 'Thiago' })).body;
const k2 = (await T('POST', '/api/finance/keys', { key_type: 'phone', key: '(32) 99999-0001', beneficiary: 'Fred', note: 'show' })).body;
check('cadastrou 2 chaves', k1.id && k2.id && k1.active === true, JSON.stringify([k1, k2]));
check('chave repetida (outra grafia) = 409', (await T('POST', '/api/finance/keys', { key_type: 'email', key: ' pix.teste@gmail.com ' })).status === 409);
check('outra empresa não vê as chaves', (await T('GET', '/api/finance/keys', null, B)).body.length === 0);

// ---- conferência ----
const cli = (await T('POST', '/api/customers', { name: 'Paga Pix', phone: '32988880001', status: 'lead' })).body;
const ped = (await T('POST', '/api/orders', { phone: '553288880001', song: 'Pedido pago' })).body;
const pago = async (extra = {}) => (await T('POST', '/api/payments/check', {
  phone: '553288880001', payer_name: 'Fulano de Tal', amount: 30, key: 'pix.teste@gmail.com', txid: 'E' + Math.random().toString(36).slice(2).padEnd(30, 'x'),
  paid_at: sp(30), purpose: 'Pedido de música', ...extra })).body;
check('valor obrigatório', (await T('POST', '/api/payments/check', { key: 'x' })).status === 400);
const a1 = await pago({ txid: 'E1111111111111111111111111111111' });
check('aceita comprovante bom', a1.accepted === true && a1.status === 'accepted' && a1.beneficiary === 'Thiago', JSON.stringify(a1));
const d1 = await pago({ txid: 'E1111111111111111111111111111111' });
check('mesmo ID = duplicado', d1.accepted === false && d1.status === 'duplicate', JSON.stringify(d1));
check('data antiga recusada', (await pago({ paid_at: sp(60 * 30) })).status === 'old');
check('data no futuro vai para análise', (await pago({ paid_at: sp(-120) })).status === 'review');
check('chave de outra pessoa recusada', (await pago({ key: 'outro@x.com' })).status === 'wrong_key');
check('sem chave no comprovante = análise', (await pago({ key: '' })).status === 'review');
check('chave em outra grafia aceita (telefone)', (await pago({ key: '+55 32 99999-0001' })).accepted === true);
const semId = await pago({ txid: '' });
check('sem ID da transação = análise', semId.status === 'review', JSON.stringify(semId));

// desativar a chave: não apaga, e a conferência passa a recusar
check('desativa a chave', (await T('PUT', '/api/finance/keys/' + k2.id, { active: false })).body.active === false);
const off = await pago({ key: '32999990001' });
check('chave desativada recusa', off.status === 'wrong_key' && /não está em uso/.test(off.motivo), JSON.stringify(off));
check('reativa', (await T('PUT', '/api/finance/keys/' + k2.id, { active: true })).body.active === true);

// valor mínimo
await T('PUT', '/api/finance/settings', { min_amount: 20 });
check('valor abaixo do mínimo', (await pago({ amount: 10 })).status === 'low_amount');
await T('PUT', '/api/finance/settings', { min_amount: '' });
check('mínimo vazio aceita qualquer valor', (await pago({ amount: 10 })).accepted === true);
check('ajuste inválido = 400', (await T('PUT', '/api/finance/settings', { max_age_hours: 0 })).status === 400);

// ---- baixa no pedido ----
check('pedido existe', !!ped.id);
const cli2 = (await T('POST', '/api/lives', { title: 'Live pagamento', starts_at: new Date(Date.now() + 3 * 864e5).toISOString() }));
const pp = (await T('POST', '/api/orders', { phone: '553288880002', song: 'Esperando', name: 'Esperando Pix' })).body;
// pedido pago sem valor (aguardando pagamento) numa live: cria e zera o valor
const lista = (await T('GET', '/api/orders?live_id=' + pp.live?.id)).body;
const meu = lista.find((x) => x.id === pp.id);
if (meu && meu.kind === 'paid') {
  const bx = await pago({ phone: '553288880002', amount: 25, txid: 'E2222222222222222222222222222222' });
  check('baixa automática no pedido que aguardava', bx.accepted && bx.order_id === pp.id, JSON.stringify(bx));
  const dep = (await T('GET', '/api/orders?live_id=' + pp.live.id)).body.find((x) => x.id === pp.id);
  check('pedido ficou pago com o valor', Number(dep.amount_paid) === 25 && dep.kind === 'paid');
} else check('(pedido pago aguardando não montado neste ambiente)', true);

// ---- recebimentos e resumo ----
const lst = (await T('GET', '/api/payments')).body;
check('lista traz os recebimentos', lst.length >= 8 && lst.some((x) => x.status === 'duplicate'));
const rev = lst.find((x) => x.status === 'review');
const apr = await T('POST', `/api/payments/${rev.id}/approve`, {});
check('aprova um que estava em análise', apr.status === 200 && (await T('GET', '/api/payments?status=accepted')).body.some((x) => x.id === rev.id));
check('aprovar de novo = 409', (await T('POST', `/api/payments/${rev.id}/approve`, {})).status === 409);
const dupl = lst.find((x) => x.status === 'duplicate');
check('duplicado não aprova (ID já aceito)', (await T('POST', `/api/payments/${dupl.id}/approve`, {})).status === 409);
const rej = lst.find((x) => x.status === 'wrong_key');
check('recusa', (await T('POST', `/api/payments/${rej.id}/reject`, { reason: 'não é meu' })).status === 200);
const sum = (await T('GET', '/api/payments/summary')).body;
check('resumo por chave', sum.keys.length === 2 && sum.keys.find((x) => x.id === k1.id).total > 0 && sum.aceitos >= 3 && sum.total > 0, JSON.stringify(sum));
const recB = await T('GET', '/api/payments', null, B); check('outra empresa não vê os recebimentos da primeira', Array.isArray(recB.body) && recB.body.every((x) => x.source === 'pedido'), JSON.stringify(recB).slice(0, 300));

// ---- cliente novo: o comprovante chega antes do cadastro e depois o pedido se liga ao pagamento ----
const pg = (await T('POST', '/api/payments/check', { phone: '553288880077', payer_name: 'Novo Cliente', name: 'Novo Cliente', amount: 45, key: 'pix.teste@gmail.com', txid: 'ENOVO' + Math.random().toString(36).slice(2).padEnd(26, 'x'), paid_at: sp(2), purpose: 'Pedido de música' })).body;
check('comprovante de cliente novo aceito', pg.accepted === true, JSON.stringify(pg));
const pnovo = (await T('POST', '/api/orders', { phone: '553288880077', name: 'Novo Cliente', song: 'Primeira música', amount_paid: 45 })).body;
const ligado = (await T('GET', '/api/payments')).body.find((x) => x.id === pg.payment_id);
check('pagamento do cliente novo ligado ao pedido', ligado && String(ligado.order_id) === String(pnovo.id) && ligado.customer_name === 'Novo Cliente', JSON.stringify(ligado));

const ps1 = (await T('GET', '/api/payments/changes')).body.sig;
check('assinatura dos recebimentos estável', (await T('GET', '/api/payments/changes')).body.sig === ps1);
await pago();
check('assinatura dos recebimentos muda com pagamento novo', (await T('GET', '/api/payments/changes')).body.sig !== ps1);
// ---- apagar ----
check('apagar em massa', (await T('POST', '/api/payments/bulk-delete', { ids: lst.slice(0, 2).map((x) => x.id) })).body.deleted === 2);
check('apagar chave não perde os recebimentos', (await T('DELETE', '/api/finance/keys/' + k2.id)).status === 200 && (await T('GET', '/api/payments')).body.length >= 6);

// ---- editar recebimento e controle único (pedidos pagos entram no Financeiro) ----
const novoTx = () => 'E' + Math.random().toString(36).slice(2).padEnd(30, 'y');
const errado = (await T('POST', '/api/payments/check', { phone: '553288880055', payer_name: 'Dani', amount: 25, key: 'pix.te.ste@gmail.com', txid: novoTx(), paid_at: sp(5) })).body;
check('chave com ponto a mais = chave diferente', errado.status === 'wrong_key', JSON.stringify(errado));
const antesAcc = (await T('GET', '/api/payments/summary')).body.total;
const ed = await T('PUT', '/api/payments/' + errado.payment_id, { key: 'pix.teste@gmail.com' });
check('corrigir a chave aceita o recebimento', ed.status === 200 && ed.body.status === 'accepted', JSON.stringify(ed.body));
const depoisAcc = (await T('GET', '/api/payments/summary')).body.total;
check('total do mês sobe com o recebimento corrigido', Math.abs(depoisAcc - antesAcc - 25) < 0.01, `${antesAcc} -> ${depoisAcc}`);
const pagList = async () => (await T('GET', '/api/payments')).body;
check('recebimento corrigido liga à chave cadastrada', (await pagList()).find((x) => x.id === errado.payment_id)?.pix_key_id === k1.id);
check('editar valor inválido = 400', (await T('PUT', '/api/payments/' + errado.payment_id, { amount: 'abc' })).status === 400);
check('outra empresa não edita', (await T('PUT', '/api/payments/' + errado.payment_id, { payer_name: 'x' }, B)).status === 404);

const lvF = (await T('POST', '/api/lives', { title: 'Fin', starts_at: new Date(Date.now() - 3 * 864e5).toISOString() })).body.live;
await T('POST', `/api/lives/${lvF.id}/close`);   // live passada: não puxa a fila de pedidos de outros testes
const pedFin = (await T('POST', '/api/orders', { phone: '553288880066', name: 'Pagou Pedido', song: 'Direto no pedido', live_id: lvF.id, kind: 'paid', amount_paid: 40 })).body;
let pagsPed = (await pagList()).filter((x) => x.order_id === pedFin.id);
check('pedido pago vira lançamento no Financeiro', pagsPed.length === 1 && pagsPed[0].source === 'pedido' && pagsPed[0].status === 'accepted' && Number(pagsPed[0].amount) === 40, JSON.stringify(pagsPed));
await T('PUT', '/api/orders/' + pedFin.id, { amount_paid: 55 });
pagsPed = (await pagList()).filter((x) => x.order_id === pedFin.id);
check('mudar o valor do pedido muda o lançamento (sem duplicar)', pagsPed.length === 1 && Number(pagsPed[0].amount) === 55, JSON.stringify(pagsPed));
check('lançamento vindo de pedido não se edita no Financeiro', (await T('PUT', '/api/payments/' + pagsPed[0].id, { amount: 1 })).status === 409);
await T('PUT', '/api/orders/' + pedFin.id, { kind: 'courtesy' });
check('pedido deixa de ser pago = lançamento some', (await pagList()).filter((x) => x.order_id === pedFin.id).length === 0);
await T('PUT', '/api/orders/' + pedFin.id, { kind: 'paid', amount_paid: 40 });
check('volta a ser pago = lançamento volta', (await pagList()).filter((x) => x.order_id === pedFin.id).length === 1);
await T('DELETE', '/api/orders/' + pedFin.id);
check('apagar o pedido apaga o lançamento dele', (await pagList()).filter((x) => x.order_id === pedFin.id).length === 0);

// comprovante aceito depois: não conta em dobro
const aguard = (await T('POST', '/api/orders', { phone: '553288880077', name: 'Comprovante Depois', song: 'Aguardando', live_id: lvF.id, kind: 'paid' })).body;
const rec = (await T('POST', '/api/payments/check', { phone: '553288880077', payer_name: 'Comprovante Depois', amount: 30, key: 'pix.teste@gmail.com', txid: novoTx(), paid_at: sp(3) })).body;
const doOrdem = (await pagList()).filter((x) => x.order_id === aguard.id);
check('comprovante dá baixa e o pedido tem um lançamento só', rec.accepted && doOrdem.length === 1 && doOrdem[0].source === 'comprovante', JSON.stringify(doOrdem));

// ---- sem duplicar e com chave Pix ----
const sem = (await T('POST', '/api/payments/check', { payer_name: 'Dani Silva', amount: 37, key: 'pix.teste@gmail.com', txid: novoTx(), paid_at: sp(10) })).body;
check('comprovante aceito sem cliente nem pedido', sem.accepted && !sem.order_id, JSON.stringify(sem));
const manual = (await T('POST', '/api/orders', { phone: '553288880088', name: 'Dani', song: 'Anotado à mão', live_id: lvF.id, kind: 'paid', amount_paid: 37 })).body;
const doManual = (await pagList()).filter((x) => x.order_id === manual.id);
check('pedido à mão casa com o comprovante existente (sem duplicar)', doManual.length === 1 && doManual[0].source === 'comprovante' && doManual[0].id === sem.payment_id, JSON.stringify(doManual));
const totalNo37 = (await pagList()).filter((x) => Number(x.amount) === 37 && x.status === 'accepted').length;
check('o valor aparece uma vez só no Financeiro', totalNo37 === 1, String(totalNo37));

const lancado = (await T('POST', '/api/orders', { phone: '553288880089', name: 'Lançado Antes', song: 'Primeiro o pedido', live_id: lvF.id, kind: 'paid', amount_paid: 41 })).body;
let lp = (await pagList()).filter((x) => x.order_id === lancado.id);
check('lançamento de pedido sem comprovante não inventa chave Pix', lp.length === 1 && lp[0].source === 'pedido' && lp[0].pix_key_id === null, JSON.stringify(lp));
const chegou = (await T('POST', '/api/payments/check', { phone: '553288880089', payer_name: 'Lançado Antes', amount: 41, key: 'pix.teste@gmail.com', txid: novoTx(), paid_at: sp(2) })).body;
lp = (await pagList()).filter((x) => x.order_id === lancado.id);
check('comprovante que chega depois assume o lançamento do pedido', chegou.accepted && lp.length === 1 && lp[0].source === 'comprovante' && lp[0].id === chegou.payment_id, JSON.stringify(lp));

const solto = (await T('POST', '/api/orders', { phone: '553288880090', name: 'Chave Manual', song: 'Trocar chave', live_id: lvF.id, kind: 'paid', amount_paid: 12 })).body;
const lps = (await pagList()).find((x) => x.order_id === solto.id);
const trocaChave = await T('PUT', '/api/payments/' + lps.id, { key: 'pix.teste@gmail.com', amount: 12 });
check('editar a chave de um lançamento de pedido', trocaChave.status === 200);
check('mudar o valor do lançamento de pedido continua bloqueado', (await T('PUT', '/api/payments/' + lps.id, { amount: 99 })).status === 409);

// ---- tipo da entrada e chave Pix em todo lançamento ----
const catPed = (await pagList()).find((x) => x.order_id === solto.id);
check('lançamento de pedido tem o tipo Pedido', catPed?.category === 'pedido', JSON.stringify(catPed));
const contrib = (await T('POST', '/api/payments/check', { payer_name: 'Doador', amount: 18, key: 'pix.teste@gmail.com', txid: novoTx(), paid_at: sp(4) })).body;
check('contribuição avulsa fica como Contribuição', (await pagList()).find((x) => x.id === contrib.payment_id)?.category === 'contribuicao');
await T('PUT', '/api/payments/' + contrib.payment_id, { category: 'outro' });
check('mudar o tipo da entrada', (await pagList()).find((x) => x.id === contrib.payment_id)?.category === 'outro');
check('tipo inválido = 400', (await T('PUT', '/api/payments/' + contrib.payment_id, { category: 'x' })).status === 400);
check('filtrar por tipo', (await T('GET', '/api/payments?category=outro')).body.every((x) => x.category === 'outro'));
const semChave = (await T('POST', '/api/orders', { phone: '553288880095', name: 'Sem Chave', song: 'Sem chave', live_id: lvF.id, kind: 'paid', amount_paid: 9 })).body;
check('resumo conta lançamentos sem chave Pix', (await T('GET', '/api/payments/summary')).body.sem_chave >= 1);
const comChave = (await T('POST', '/api/orders', { phone: '553288880096', name: 'Com Chave', song: 'Com chave', live_id: lvF.id, kind: 'paid', amount_paid: 9, pix_key_id: k1.id })).body;
check('pedido anotado com a chave Pix escolhida', (await pagList()).find((x) => x.order_id === comChave.id)?.pix_key_id === k1.id);
await T('PUT', '/api/orders/' + semChave.id, { pix_key_id: k1.id });
check('indicar a chave depois, editando o pedido', (await pagList()).find((x) => x.order_id === semChave.id)?.pix_key_id === k1.id);

console.log(`financeiro: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
