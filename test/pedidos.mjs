// Lives, pedidos de música e franquia do programa de benefícios. Uso: BASE=http://localhost:3999 node test/pedidos.mjs
import { execSync } from 'child_process';
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
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

// datas: sempre no mês seguinte (3 lives no mesmo mês) e uma dois meses adiante
const now = new Date();
const dia = (meses, d, h = 22) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + meses, d, h, 0, 0)).toISOString();
const mesDe = (iso) => iso.slice(0, 7);

// níveis e clientes
const lv = (await T('GET', '/api/club')).body.levels;
const nivel = async (name, qtd) => (lv.find((l) => l.name === name) || (await T('POST', '/api/club/levels', { name, benefit_qty: qtd })).body).id;
const n2 = await nivel('Pedidos N2', 2), n0 = await nivel('Pedidos N0', 0);
const mk = async (name, phone, extra = {}) => (await T('POST', '/api/customers', { name, phone, status: 'client', ...extra })).body;
await mk('Membro Dois', '32980010001', { club_status: 'member', club_level_id: n2 });
await mk('Membro Zero', '32980010002', { club_status: 'member', club_level_id: n0 });
await mk('Ex Membro', '32980010003', { club_status: 'former' });
const P1 = '553280010001', P2 = '553280010002', P3 = '553280010003', P4 = '553280019999';
const ped = (phone, song, extra = {}) => T('POST', '/api/orders', { phone, song, ...extra });

// ---- sem live marcada: vai para a fila ----
let o = await ped(P1, 'Trem das Onze', { dedication: 'para meu pai' });
check('sem live = fila', o.status === 201 && o.body.status === 'queued' && o.body.kind === null && o.body.live === null, JSON.stringify(o.body));
let bal = (await T('GET', '/api/orders/balance?phone=' + P1)).body;
check('saldo mostra o pedido na fila e nenhuma live', bal.found && bal.queued === 1 && bal.next_live === null && bal.franchise === 2 && bal.remaining === 2, JSON.stringify(bal));
await ped(P2, 'Detalhes');
await ped(P3, 'Sozinho', { amount_paid: 10 });
const fila = (await T('GET', '/api/orders?queue=1')).body;
check('fila em ordem de chegada', fila.length === 3 && fila[0].song === 'Trem das Onze' && fila[2].song === 'Sozinho', JSON.stringify(fila.map((x) => x.song)));
check('cliente novo vira lead', (await ped(P4, 'Aquarela', { name: 'Fulano Novo' })).body.status === 'queued' && (await T('GET', '/api/customers/by-phone/' + P4)).body.status === 'lead');

// ---- validações ----
check('telefone curto = 400', (await ped('123', 'x')).status === 400);
check('sem música = 400', (await ped(P1, '  ')).status === 400);
check('valor negativo = 400', (await ped(P1, 'x', { amount_paid: -5 })).status === 400);

// ---- marcar live1: a fila entra, com a franquia decidida ----
const d1 = dia(1, 5), d2 = dia(1, 12), d3 = dia(1, 20), d4 = dia(2, 8);
check('live sem data = 400', (await T('POST', '/api/lives', { title: 'x' })).status === 400);
check('fim antes do começo = 400', (await T('POST', '/api/lives', { starts_at: d1, ends_at: dia(1, 4) })).status === 400);
const l1 = (await T('POST', '/api/lives', { title: 'Live 1', starts_at: d1, external_id: 'yt-abc' })).body;
check('criou a live e encaixou a fila', l1.live.id && l1.attached.length === 4, JSON.stringify(l1));
const kinds = Object.fromEntries(l1.attached.map((a) => [a.id, a.kind]));
let daLive = (await T('GET', '/api/orders?live_id=' + l1.live.id)).body;
const por = (lista, song) => lista.find((x) => x.song === song);
check('membro com franquia: franquia', por(daLive, 'Trem das Onze').kind === 'franchise' && Number(por(daLive, 'Trem das Onze').amount_paid) === 0, JSON.stringify(daLive[0]));
check('membro nível sem benefício: pago', por(daLive, 'Detalhes').kind === 'paid');
check('ex-membro: pago, com valor', por(daLive, 'Sozinho').kind === 'paid' && Number(por(daLive, 'Sozinho').amount_paid) === 10);
check('fila esvaziou', (await T('GET', '/api/orders?queue=1')).body.length === 0);
const l1b = await T('POST', '/api/lives', { title: 'Live 1 (nome novo)', starts_at: d1, external_id: 'yt-abc' });
check('mesma identificação externa atualiza', l1b.status === 200 && l1b.body.live.id === l1.live.id && l1b.body.live.title === 'Live 1 (nome novo)');

// ---- segundo pedido na mesma live é pago ----
o = await ped(P1, 'Detalhes de novo');
check('segundo pedido na live = pago', o.body.status === 'confirmed' && o.body.kind === 'paid' && o.body.live.id === l1.live.id && o.body.balance.used === 1 && o.body.balance.remaining === 1, JSON.stringify(o.body));

// ---- franquia acaba no mês; novo mês renova ----
const l2 = (await T('POST', '/api/lives', { title: 'Live 2', starts_at: d2 })).body.live;
const l3 = (await T('POST', '/api/lives', { title: 'Live 3', starts_at: d3 })).body.live;
const l4 = (await T('POST', '/api/lives', { title: 'Live 4', starts_at: d4 })).body.live;
check('lista de lives abertas', (await T('GET', '/api/lives?open=1')).body.length === 4);
check('encerrar a live 1', (await T('POST', `/api/lives/${l1.live.id}/close`)).body.closed_at);
o = await ped(P1, 'Sob Medida');
check('vai para a live seguinte (2) com franquia', o.body.live.id === l2.id && o.body.kind === 'franchise' && o.body.balance.used === 2 && o.body.balance.remaining === 0, JSON.stringify(o.body));
await T('POST', `/api/lives/${l2.id}/close`);
o = await ped(P1, 'Pra Não Dizer');
check('franquia do mês esgotada = pago', o.body.live.id === l3.id && o.body.kind === 'paid' && o.body.balance.remaining === 0, JSON.stringify(o.body));
await T('POST', `/api/lives/${l3.id}/close`);
o = await ped(P1, 'Mês Novo');
check('mês seguinte renova a franquia', o.body.live.id === l4.id && o.body.kind === 'franchise' && o.body.balance.used === 1 && o.body.balance.remaining === 1 && o.body.balance.month === mesDe(d4), JSON.stringify(o.body));

// ---- resumo do mês ----
const sum = (await T('GET', '/api/orders/summary?month=' + mesDe(d1))).body;
const m = sum.rows.find((x) => x.phone === P1);
check('resumo do mês do membro', m && m.used === 2 && m.paid_count === 2 && m.remaining === 0 && m.franchise === 2 && m.total === 4, JSON.stringify(m));
check('resumo traz todos com pedido', sum.rows.length === 4 && sum.totals.orders === 7, JSON.stringify(sum.totals));
check('total pago do mês', sum.totals.paid_total === 10 && sum.totals.franchise === 2, JSON.stringify(sum.totals));
check('mês sem pedidos vem vazio', (await T('GET', '/api/orders/summary?month=2001-01')).body.rows.length === 0);

// ---- cortesia e edição ----
const pago = por((await T('GET', '/api/orders?live_id=' + l1.live.id)).body, 'Detalhes');
const ed = (await T('PUT', '/api/orders/' + pago.id, { kind: 'franchise' })).body;
check('mudar para cortesia zera o valor', ed.kind === 'franchise' && Number(ed.amount_paid) === 0);
check('editar dedicatória', (await T('PUT', '/api/orders/' + pago.id, { dedication: 'oi' })).body.dedication === 'oi');
check('cobrança inválida = 400', (await T('PUT', '/api/orders/' + pago.id, { kind: 'x' })).status === 400);

// ---- ficha do cliente ----
const f = (await T('GET', '/api/customers/' + (await T('GET', '/api/customers/by-phone/' + P1)).body.id)).body;
check('ficha traz histórico de pedidos e saldo', f.orders.length === 5 && f.balance.franchise === 2 && f.orders[0].song === 'Mês Novo', JSON.stringify(f.balance));

// ---- sem live aberta, volta a fila ----
await T('POST', `/api/lives/${l4.id}/close`);
o = await ped(P2, 'Fila de Novo');
check('todas encerradas = fila de novo', o.body.status === 'queued');
check('reabrir encaixa a fila', (await T('POST', `/api/lives/${l4.id}/reopen`)).body.attached.length === 1);

// ---- apagar ----
check('live com pedidos não apaga', (await T('DELETE', '/api/lives/' + l1.live.id)).status === 409);
const vazia = (await T('POST', '/api/lives', { title: 'Vazia', starts_at: dia(3, 3) })).body.live;
check('live vazia apaga', (await T('DELETE', '/api/lives/' + vazia.id)).status === 200);
const um = por((await T('GET', '/api/orders?live_id=' + l4.id)).body, 'Fila de Novo');
check('apagar pedido', (await T('DELETE', '/api/orders/' + um.id)).status === 200 && (await T('DELETE', '/api/orders/' + um.id)).status === 404);
const cli4 = (await T('GET', '/api/customers/by-phone/' + P4)).body;
check('excluir cliente leva os pedidos junto', (await T('DELETE', '/api/customers/' + cli4.id)).status === 200);

// ---- outra empresa ----
check('empresa 2 não vê lives', (await T('GET', '/api/lives', undefined, B)).body.length === 0);
check('empresa 2 não mexe em live da 1', (await T('POST', `/api/lives/${l4.id}/close`, undefined, B)).status === 404);
check('empresa 2 não vê pedidos da 1', (await T('GET', '/api/orders/summary?month=' + mesDe(d1), undefined, B)).body.rows.length === 0);

// resumo de pagamento por live
const lv1 = (await T('GET', '/api/lives')).body.find((x) => x.id === l1.live.id);
const lista1 = (await T('GET', '/api/orders?live_id=' + l1.live.id)).body;
check('live traz franquia, pagos, aguardando e recebido', lv1.orders === lista1.length && lv1.franchise_count === lista1.filter((x) => x.kind === 'franchise').length
  && lv1.paid_count === lista1.filter((x) => x.kind === 'paid').length && lv1.awaiting_count === lista1.filter((x) => x.kind === 'paid' && x.amount_paid == null).length
  && Math.abs(lv1.received - lista1.filter((x) => x.kind === 'paid').reduce((s2, x) => s2 + Number(x.amount_paid || 0), 0)) < 0.001, JSON.stringify(lv1));
const meus = (await T('GET', '/api/orders?phone=' + P1)).body;
check('pedidos do cliente por telefone (próxima live + fila)', Array.isArray(meus.orders) && meus.orders.length > 0 && meus.orders.every((x) => x.id && x.song !== undefined) && 'next_live' in meus, JSON.stringify(meus).slice(0, 200));
check('telefone sem pedidos devolve lista vazia', ((await T('GET', '/api/orders?phone=32900000000')).body.orders || [1]).length === 0);
// ---- cortesia do 1º pedido ----
const PC = '553288880099';
const c1 = (await T('POST', '/api/orders', { phone: PC, name: 'Cliente Cortesia', song: 'Primeira' })).body;
check('1º pedido sem pagamento avisa o prazo da cortesia', c1.courtesy_in_minutes === 15 && c1.kind === 'paid', JSON.stringify(c1));
check('dentro do prazo ainda aguarda pagamento', ((await T('GET', '/api/orders?phone=' + PC)).body.orders[0] || {}).kind === 'paid');
const c2 = (await T('POST', '/api/orders', { phone: PC, song: 'Segunda' })).body;
check('2º pedido não tem cortesia', c2.courtesy_in_minutes === null, JSON.stringify(c2));
psql(`update company_1.song_orders set created_at = now() - interval '20 minutes' where id in (${c1.id}, ${c2.id})`);
const depois = (await T('GET', '/api/orders?phone=' + PC)).body.orders;
check('passado o prazo, só o 1º vira cortesia', depois.find((x) => String(x.id) === String(c1.id)).kind === 'courtesy' && depois.find((x) => String(x.id) === String(c2.id)).kind === 'paid', JSON.stringify(depois));
const cliC = (await T('GET', '/api/customers/by-phone/' + PC)).body;
check('ficha marcada com a cortesia usada', !!cliC.courtesy_used_at, JSON.stringify(cliC).slice(0, 200));
check('cortesia não se repete no cliente', (await T('POST', '/api/orders', { phone: PC, song: 'Terceira' })).body.courtesy_in_minutes === null);
check('assinante com pedido pago não é elegível', (await T('POST', '/api/orders', { phone: '553288880098', song: 'Pago', amount_paid: 30 })).body.courtesy_in_minutes === null);
// contato já cadastrado (não criado pela agente) não ganha cortesia
const velho = (await T('POST', '/api/customers', { name: 'Já cadastrado', phone: '32988880097', status: 'lead' })).body;
check('cliente já cadastrado não é elegível à cortesia', (await T('POST', '/api/orders', { phone: '553288880097', song: 'Velho' })).body.courtesy_in_minutes === null);
// assinatura de mudanças (a tela só recarrega quando muda)
const sg1 = (await T('GET', '/api/orders/changes')).body.sig;
check('assinatura estável sem mudança', (await T('GET', '/api/orders/changes')).body.sig === sg1 && typeof sg1 === 'string' && sg1.length > 10);
await T('POST', '/api/orders', { phone: '553288880055', song: 'Mudou a assinatura', amount_paid: 30 });
check('assinatura muda com pedido novo', (await T('GET', '/api/orders/changes')).body.sig !== sg1);
check('outra empresa tem assinatura própria', (await T('GET', '/api/orders/changes', null, B)).body.sig !== (await T('GET', '/api/orders/changes')).body.sig);
console.log(`pedidos: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
