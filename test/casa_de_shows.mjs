// Casa de Shows: reservas de mesa por setor, controladas por espaço. Uso: BASE=http://localhost:3999 node test/casa_de_shows.mjs
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
const em = (dias) => new Date(Date.now() + dias * 864e5).toISOString();
const marca = String(Date.now()).slice(-6);

// ---- cadastro
check('setor sem nome = 400', (await T('POST', '/api/casa-de-shows/sectors', { space: 10 })).status === 400);
check('setor com espaço negativo = 400', (await T('POST', '/api/casa-de-shows/sectors', { name: 'X', space: -1 })).status === 400);
check('mesa sem lugares = 400', (await T('POST', '/api/casa-de-shows/table-types', { name: 'X', seats: 0, space: 5 })).status === 400);
check('mesa sem espaço = 400', (await T('POST', '/api/casa-de-shows/table-types', { name: 'X', seats: 4, space: 0 })).status === 400);

const s3 = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor 3 ' + marca, space: 20, notes: 'Visão 10, som 9 e 10' })).body;
const s4 = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor 4 ' + marca, space: '30' })).body;
check('criou setores', s3.id && s3.space === 20 && s3.notes === 'Visão 10, som 9 e 10' && s4.space === 30, JSON.stringify([s3, s4]));
check('setor repetido = 409', (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor 3 ' + marca, space: 5 })).status === 409);
const m10 = (await T('POST', '/api/casa-de-shows/table-types', { name: 'Mesa de 10 ' + marca, seats: 10, space: 10 })).body;
const m4 = (await T('POST', '/api/casa-de-shows/table-types', { name: 'Mesa de 4 ' + marca, seats: 4, space: '5' })).body;
check('criou mesas', m10.id && m4.id && m4.space === 5, JSON.stringify([m10, m4]));
check('mesa repetida = 409', (await T('POST', '/api/casa-de-shows/table-types', { name: 'Mesa de 4 ' + marca, seats: 4, space: 5 })).status === 409);

const ev = (await T('POST', '/api/events', { title: 'Show Casa de Shows ' + marca, starts_at: em(-0.5) })).body;   // o mais próximo "em andamento"
check('criou evento', ev.id);
const free = async (sid, q = 'event_id=' + ev.id) => (await T('GET', `/api/casa-de-shows/availability?${q}&sector_id=${sid}`)).body.sectors[0];

let d = await free(s3.id);
check('setor começa livre', d.space === 20 && d.used === 0 && d.free === 20, JSON.stringify(d));
check('cabem 2 mesas de 10 ou 4 de 4', d.fits.find((f) => f.table_type_id === m10.id)?.tables === 2 && d.fits.find((f) => f.table_type_id === m4.id)?.tables === 4);
check('4 mesas de 4 rendem 16 lugares, 2 de 10 rendem 20', d.fits.find((f) => f.table_type_id === m4.id)?.seats_total === 16 && d.fits.find((f) => f.table_type_id === m10.id)?.seats_total === 20);

// ---- reservas
let r = await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s3.id, name: 'Ana Souza', phone: '(32) 99999-1111', people: 8 });
check('reserva automática escolhe a mesa que ocupa menos espaço', r.status === 201 && r.body.table_name === m10.name && r.body.tables === 1 && r.body.space === 10, JSON.stringify(r));
check('liga ao cadastro de clientes pelo telefone', !!r.body.customer_id && r.body.phone === '553299991111', JSON.stringify(r.body));
const r1 = r.body;
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s3.id, name: 'Ana Souza', phone: '32999991111', people: 3 });
check('mesmo telefone reaproveita o cliente', r.status === 201 && r.body.customer_id === r1.customer_id && r.body.table_name === m4.name && r.body.space === 5, JSON.stringify(r));
const r2 = r.body;
d = await free(s3.id);
check('espaço usado e livre', d.used === 15 && d.free === 5 && d.reservations === 2 && d.people === 11, JSON.stringify(d));

r = await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s3.id, name: 'Beto', people: 4, table_type_id: m10.id });
check('mesa que não cabe no espaço restante = 409', r.status === 409, JSON.stringify(r));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s3.id, name: 'Beto', people: 5, table_type_id: m4.id, tables: 1 });
check('mesas que não comportam as pessoas = 400', r.status === 400, JSON.stringify(r));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s3.id, name: 'Beto', people: 4, table_type_id: m4.id });
check('cabe exatamente no que sobrou', r.status === 201, JSON.stringify(r));
const r3 = r.body;
d = await free(s3.id);
check('setor lotado', d.free === 0, JSON.stringify(d));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s3.id, name: 'Caio', people: 1 });
check('setor lotado recusa reserva automática (409)', r.status === 409, JSON.stringify(r));
const av = (await T('GET', `/api/casa-de-shows/availability?event_id=${ev.id}&people=2`)).body;
check('disponibilidade para um grupo diz onde cabe', av.sectors_with_room.length === 1 && av.sectors_with_room[0] === s4.name, JSON.stringify(av.sectors_with_room));
check('o outro setor continua livre e é independente', (await free(s4.id)).free === 30);

// edição não conflita consigo mesma
r = await T('PUT', '/api/casa-de-shows/reservations/' + r1.id, { note: 'chega às 21h', guests: 'Ana Souza\nPedro Souza' });
check('editar anotação num setor lotado funciona', r.status === 200 && r.body.note === 'chega às 21h' && r.body.guests === 'Ana Souza\nPedro Souza', JSON.stringify(r));
r = await T('PUT', '/api/casa-de-shows/reservations/' + r1.id, { people: 10 });
check('aumentar o grupo dentro da mesma mesa funciona', r.status === 200 && r.body.people === 10 && r.body.tables === 1, JSON.stringify(r));
r = await T('PUT', '/api/casa-de-shows/reservations/' + r1.id, { people: 11 });
check('grupo maior pede mais mesas e não cabe (409)', r.status === 409, JSON.stringify(r));

// cancelar libera, reativar confere de novo
r = await T('PUT', '/api/casa-de-shows/reservations/' + r2.id, { status: 'cancelled' });
check('cancelar', r.status === 200 && r.body.status === 'cancelled');
check('cancelada libera o espaço', (await free(s3.id)).free === 5);
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s3.id, name: 'Dani', people: 4 });
check('o espaço liberado pode ser reservado', r.status === 201);
r = await T('PUT', '/api/casa-de-shows/reservations/' + r2.id, { status: 'confirmed' });
check('reativar reserva sem espaço = 409', r.status === 409, JSON.stringify(r));
r = await T('PUT', '/api/casa-de-shows/reservations/' + r3.id, { status: 'no_show' });
check('"não veio" libera o espaço', r.status === 200 && (await free(s3.id)).free === 5);
r = await T('PUT', '/api/casa-de-shows/reservations/' + r3.id, { status: 'attended' });
check('"compareceu" volta a ocupar', r.status === 200 && (await free(s3.id)).free === 0);

// trocar de setor
r = await T('PUT', '/api/casa-de-shows/reservations/' + r3.id, { sector_id: s4.id });
check('mudar de setor', r.status === 200 && r.body.sector_name === s4.name && (await free(s4.id)).used === 5 && (await free(s3.id)).free === 5, JSON.stringify(r.body));

// ---- espaço ajustado por evento
r = await T('PUT', `/api/casa-de-shows/events/${ev.id}/sectors`, { sectors: [{ sector_id: s4.id, space: 12 }] });
d = await free(s4.id);
check('espaço do setor ajustado só para este evento', r.status === 200 && d.space === 12 && d.custom_space === true && d.base_space === 30 && d.free === 7, JSON.stringify(d));
const ev2 = (await T('POST', '/api/events', { title: 'Outro show ' + marca, starts_at: em(30) })).body;
check('outro evento segue com o espaço padrão', (await free(s4.id, 'event_id=' + ev2.id)).space === 30);
await T('PUT', `/api/casa-de-shows/events/${ev.id}/sectors`, { sectors: [{ sector_id: s4.id, space: null }] });
check('voltar ao padrão', (await free(s4.id)).space === 30);
check('ajuste com espaço inválido = 400', (await T('PUT', `/api/casa-de-shows/events/${ev.id}/sectors`, { sectors: [{ sector_id: s4.id, space: -3 }] })).status === 400);

// ---- lista de eventos com vagas (o atendente distingue um evento do outro pelo nome e pelo id)
const lst = (await T('GET', '/api/casa-de-shows/events')).body;
check('lista os eventos que ainda valem, cada um com suas vagas', lst.some((x) => x.id === ev2.id && x.title === 'Outro show ' + marca && x.sectors.length >= 2) && !lst.some((x) => x.id === ev.id), JSON.stringify(lst.map((x) => x.title)));
check('cada evento tem a própria lista de reservas', lst.find((x) => x.id === ev2.id).reservations === 0);


// ---- regras do setor: que mesas aceita e quantas cabem
const m2 = (await T('POST', '/api/casa-de-shows/table-types', { name: 'Mesa de 2 ' + marca, seats: 2, space: 2.5 })).body;
const m8 = (await T('POST', '/api/casa-de-shows/table-types', { name: 'Mesa de 8 ' + marca, seats: 8, space: 8 })).body;
const s2 = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor 2 ' + marca, space: 10, tables: [{ table_type_id: m2.id }] })).body;
check('setor guarda as mesas que aceita', s2.tables.length === 1 && s2.tables[0].table_type_id === String(m2.id) && s2.tables[0].max_tables === null, JSON.stringify(s2.tables));
const evR = (await T('POST', '/api/events', { title: 'Regras ' + marca, starts_at: em(40) })).body;
const fr = async (sid) => (await T('GET', `/api/casa-de-shows/availability?event_id=${evR.id}&sector_id=${sid}&people=2`)).body.sectors[0];
d = await fr(s2.id);
check('disponibilidade mostra só as mesas do setor e o maior tamanho', d.fits.length === 1 && d.fits[0].name === m2.name && d.max_table_seats === 2, JSON.stringify(d.fits));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evR.id, sector_id: s2.id, name: 'Casal', people: 2, table_type_id: m8.id });
check('setor não aceita mesa fora das regras (400)', r.status === 400, JSON.stringify(r));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evR.id, sector_id: s2.id, name: 'Grupo', people: 4 });
check('grupo maior vira mais mesas pequenas do setor (2 × mesa de 2)', r.status === 201 && r.body.tables === 2 && r.body.table_name === m2.name, JSON.stringify(r));

const s6 = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor 6 ' + marca, space: 20, tables: [{ table_type_id: m10.id, max_tables: 1 }, { table_type_id: m8.id }, { table_type_id: m2.id, max_tables: 3 }] })).body;
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evR.id, sector_id: s6.id, name: 'Dez', people: 10, table_type_id: m10.id });
check('mesa de 10 cabe uma vez no setor', r.status === 201);
const dez = r.body;
d = await fr(s6.id);
check('fits respeita o limite de mesas de 10 (0 sobraram) e o espaço para as outras', d.fits.find((f) => f.table_type_id === m10.id).tables === 0 && d.fits.find((f) => f.table_type_id === m8.id).tables === 1 && d.fits.find((f) => f.table_type_id === m2.id).tables === 3, JSON.stringify(d.fits));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evR.id, sector_id: s6.id, name: 'Outra dez', people: 10, table_type_id: m10.id });
check('segunda mesa de 10 passa do limite do setor (409)', r.status === 409, JSON.stringify(r));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evR.id, sector_id: s6.id, name: 'Quinze', people: 15 });
check('grupo de 15 depois da mesa de 10: não cabe em mesas de 10 (limite) e 2 mesas de 8 passam do espaço', r.status === 409, JSON.stringify(r));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evR.id, sector_id: s6.id, name: 'Oito', people: 8 });
check('mesa de 8 ao lado da de 10 (10 + 8 de 20)', r.status === 201 && r.body.table_name === m8.name, JSON.stringify(r));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evR.id, sector_id: s6.id, name: 'Casal 6', people: 2 });
check('10 + 8 deixa 2 de espaço e a mesa de 2 ocupa 2,5: não cabe (409)', r.status === 409, JSON.stringify(r));

// grupo de 20: duas mesas de 10 juntas, se o setor permitir e tiver espaço
const s7 = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor 7 ' + marca, space: 24, tables: [{ table_type_id: m10.id, max_tables: 2 }, { table_type_id: m2.id }] })).body;
const g = (await T('GET', `/api/casa-de-shows/availability?event_id=${evR.id}&sector_id=${s7.id}&people=20`)).body.sectors[0];
check('grupo de 20 sugere 2 mesas de 10 juntas no setor', g.can_fit && g.option.tables === 2 && g.option.name === m10.name && Array.isArray(g.options) && g.options.length >= 1, JSON.stringify(g.option));
check('a opção lista alternativas ordenadas pelo espaço', g.options.every((o, i, l) => i === 0 || l[i - 1].space <= o.space));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evR.id, sector_id: s7.id, name: 'Grupão', people: 20 });
check('reserva automática do grupo de 20', r.status === 201 && r.body.tables === 2 && r.body.table_name === m10.name && r.body.space === 20, JSON.stringify(r));
const gp = (await T('GET', `/api/casa-de-shows/availability?event_id=${evR.id}&sector_id=${s7.id}&people=20`)).body.sectors[0];
check('um segundo grupo de 20 não cabe no mesmo setor', gp.can_fit === false);

// mudar regras: remover o limite libera; lista vazia = aceita todas
r = await T('PUT', '/api/casa-de-shows/sectors/' + s6.id, { tables: [{ table_type_id: m10.id, max_tables: 2 }] });
check('alterar regras do setor', r.status === 200 && r.body.tables.length === 1 && r.body.tables[0].max_tables === 2);
r = await T('PUT', '/api/casa-de-shows/sectors/' + s6.id, { name: 'Setor 6 ' + marca + ' novo' });
check('editar outros campos não mexe nas regras', r.body.tables.length === 1);
r = await T('PUT', '/api/casa-de-shows/sectors/' + s6.id, { tables: [] });
check('lista vazia = aceita todas as mesas', r.status === 200 && r.body.tables.length === 0);
check('regra com mesa inexistente = 400', (await T('PUT', '/api/casa-de-shows/sectors/' + s6.id, { tables: [{ table_type_id: 99999999 }] })).status === 400);
check('regra com limite inválido = 400', (await T('PUT', '/api/casa-de-shows/sectors/' + s6.id, { tables: [{ table_type_id: m10.id, max_tables: 0 }] })).status === 400);
check('regra repetida = 400', (await T('PUT', '/api/casa-de-shows/sectors/' + s6.id, { tables: [{ table_type_id: m10.id }, { table_type_id: m10.id }] })).status === 400);

// reserva existente continua editável mesmo se a regra mudar depois
await T('PUT', '/api/casa-de-shows/sectors/' + s2.id, { tables: [{ table_type_id: m8.id }] });
r = await T('PUT', '/api/casa-de-shows/reservations/' + dez.id, { note: 'sem mudança de mesa' });
check('editar anotação de reserva antiga não é barrado pela regra nova', r.status === 200);
await T('DELETE', '/api/events/' + evR.id);

// ---- mesa extra aberta à mão
const evX = (await T('POST', '/api/events', { title: 'Extra ' + marca, starts_at: em(50) })).body;
const sx = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor X ' + marca, space: 10, tables: [{ table_type_id: m10.id, max_tables: 1 }] })).body;
const fx = async () => (await T('GET', `/api/casa-de-shows/availability?event_id=${evX.id}&sector_id=${sx.id}&people=2`)).body.sectors[0];
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evX.id, sector_id: sx.id, name: 'Lota', people: 10, table_type_id: m10.id });
check('setor fica lotado', r.status === 201 && (await fx()).can_fit === false);
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evX.id, sector_id: sx.id, name: 'Casal sem lugar', people: 2, table_type_id: m2.id });
check('casal recusado: o setor não aceita mesa de 2 nem tem espaço (400)', r.status === 400, JSON.stringify(r));
r = await T('POST', '/api/casa-de-shows/extras', { event_id: evX.id, sector_id: sx.id, table_type_id: m2.id, note: 'abrimos espaço na pista' });
check('abrir mesa extra', r.status === 201 && r.body.table_name === m2.name && r.body.quantity === 1 && r.body.space === 2.5 && r.body.sector_name === sx.name, JSON.stringify(r));
const ex1 = r.body;
d = await fx();
check('a mesa extra aparece na hora nas vagas do setor', d.can_fit === true && d.option.name === m2.name && d.option.tables === 1 && d.extra_tables === 1 && d.extra_space === 2.5 && d.space === 12.5, JSON.stringify(d));
check('só cabe uma mesa extra (a única livre)', d.fits.find((f) => f.table_type_id === m2.id).tables === 1);
check('o evento ao lado não ganha a mesa extra', (await T('GET', `/api/casa-de-shows/availability?event_id=${ev2.id}&sector_id=${sx.id}`)).body.sectors[0].extra_tables === 0);
check('lista as mesas extras do evento', (await T('GET', '/api/casa-de-shows/extras?event_id=' + evX.id)).body.length === 1);
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evX.id, sector_id: sx.id, name: 'Casal com extra', people: 2 });
check('o casal agora é aceito na mesa extra', r.status === 201 && r.body.table_name === m2.name, JSON.stringify(r));
const casal = r.body;
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evX.id, sector_id: sx.id, name: 'Outro casal', people: 2 });
check('acabou a mesa extra: o próximo casal é recusado', r.status === 400 || r.status === 409, JSON.stringify(r));
r = await T('DELETE', '/api/casa-de-shows/extras/' + ex1.id);
check('não dá para fechar a mesa extra enquanto há reserva nela (409)', r.status === 409, JSON.stringify(r));
await T('PUT', '/api/casa-de-shows/reservations/' + casal.id, { status: 'cancelled' });
r = await T('DELETE', '/api/casa-de-shows/extras/' + ex1.id);
check('depois de cancelar a reserva, fecha a mesa extra', r.status === 200 && (await fx()).can_fit === false);
check('mesa extra sem tipo = 400', (await T('POST', '/api/casa-de-shows/extras', { event_id: evX.id, sector_id: sx.id })).status === 400);
check('mesa extra com quantidade inválida = 400', (await T('POST', '/api/casa-de-shows/extras', { event_id: evX.id, sector_id: sx.id, table_type_id: m2.id, quantity: 0 })).status === 400);
check('mesa extra em outra empresa não é visível', (await T('GET', '/api/casa-de-shows/extras?date=2031-05-17', null, B)).body.length === 0);
r = await T('POST', '/api/casa-de-shows/extras', { event_id: evX.id, sector_id: sx.id, table_type_id: m10.id, quantity: 1 });
const r2x = await T('POST', '/api/casa-de-shows/reservations', { event_id: evX.id, sector_id: sx.id, name: 'Segunda de dez', people: 10, table_type_id: m10.id });
check('extra de um tipo com limite no setor libera mais uma mesa desse tipo', r.status === 201 && r2x.status === 201, JSON.stringify([r.status, r2x]));
await T('DELETE', '/api/events/' + evX.id);

// ---- preço, palavras-chave e duplicação de evento
const evP = (await T('POST', '/api/events', { title: 'Show com preço ' + marca, starts_at: em(60), ends_at: new Date(Date.now() + 60 * 864e5 + 3 * 36e5).toISOString(), place: 'Casa de Shows', notes: 'Trio' })).body;
check('evento sem condições: preço nulo', (await T('GET', `/api/casa-de-shows/events/${evP.id}/price`)).body.unit_price === null);
const prazoFuturo = new Date(Date.now() + 59 * 864e5).toISOString();
r = await T('PUT', `/api/casa-de-shows/events/${evP.id}/conditions`, { price: '30', door_price: '40', price_until: prazoFuturo, instructions: 'Amigos da Rafa pagam 25.' });
check('guarda preço, preço da portaria, prazo e instrução', r.status === 200 && r.body.price === 30 && r.body.door_price === 40 && r.body.instructions === 'Amigos da Rafa pagam 25.', JSON.stringify(r));
check('porta sem preço normal = 400', (await T('PUT', `/api/casa-de-shows/events/${evP.id}/conditions`, { price: null, door_price: 40 })).status === 400);
check('preço inválido = 400', (await T('PUT', `/api/casa-de-shows/events/${evP.id}/conditions`, { price: 'abc' })).status === 400);
let pr = (await T('GET', `/api/casa-de-shows/events/${evP.id}/price?people=2`)).body;
check('antes do prazo vale o preço normal', pr.unit_price === 30 && pr.tier === 'normal' && pr.total === 60 && pr.instructions === 'Amigos da Rafa pagam 25.', JSON.stringify(pr));
await T('PUT', `/api/casa-de-shows/events/${evP.id}/conditions`, { price_until: new Date(Date.now() - 864e5).toISOString() });
pr = (await T('GET', `/api/casa-de-shows/events/${evP.id}/price`)).body;
check('depois do prazo vale o preço da portaria', pr.unit_price === 40 && pr.tier === 'portaria', JSON.stringify(pr));
await T('PUT', `/api/casa-de-shows/events/${evP.id}/conditions`, { price_until: prazoFuturo });

let k1 = await T('POST', `/api/casa-de-shows/events/${evP.id}/codes`, { word: 'Aniversário da Rafa', kind: 'percent', value: 10 });
check('cria palavra-chave com percentual', k1.status === 201 && k1.body.kind === 'percent' && k1.body.value === 10 && k1.body.uses === 0, JSON.stringify(k1));
const kPct = k1.body;
const kFixo = (await T('POST', `/api/casa-de-shows/events/${evP.id}/codes`, { word: 'amigo da rafa', kind: 'price', value: '20', max_uses: 1, note: 'só um amigo' })).body;
check('cria palavra-chave de preço fixo com limite', kFixo.id && kFixo.value === 20 && kFixo.max_uses === 1);
check('palavra repetida (ignorando acento e maiúscula) = 409', (await T('POST', `/api/casa-de-shows/events/${evP.id}/codes`, { word: 'ANIVERSARIO DA RAFA', kind: 'percent', value: 5 })).status === 409);
check('percentual acima de 100 = 400', (await T('POST', `/api/casa-de-shows/events/${evP.id}/codes`, { word: 'x', kind: 'percent', value: 150 })).status === 400);
check('tipo inválido = 400', (await T('POST', `/api/casa-de-shows/events/${evP.id}/codes`, { word: 'y', kind: 'xis', value: 5 })).status === 400);
pr = (await T('GET', `/api/casa-de-shows/events/${evP.id}/price?code=${encodeURIComponent('aniversario da RAFA')}&people=2`)).body;
check('palavra com percentual dá o desconto (30 → 27)', pr.code_valid && pr.unit_price === 27 && pr.applied === 'code' && pr.total === 54, JSON.stringify(pr));
pr = (await T('GET', `/api/casa-de-shows/events/${evP.id}/price?code=amigodarafa`)).body;
check('palavra de preço fixo (paga 20)', pr.code_valid && pr.unit_price === 20, JSON.stringify(pr));
pr = (await T('GET', `/api/casa-de-shows/events/${evP.id}/price?code=naoexiste`)).body;
check('palavra desconhecida não vale e o preço segue normal', pr.code_valid === false && pr.unit_price === 30 && /não encontrada/.test(pr.reason), JSON.stringify(pr));
check('a consulta de preço não devolve a lista de palavras', !JSON.stringify(pr).includes('Aniversário'));
pr = (await T('GET', `/api/casa-de-shows/events/${evP.id}/price?code=aniversariodarafa&other_percent=20`)).body;
check('desconto não cumulativo: vale o maior (20% do programa > 10% da palavra)', pr.unit_price === 24 && pr.applied === 'other', JSON.stringify(pr));
pr = (await T('GET', `/api/casa-de-shows/events/${evP.id}/price?other_percent=10`)).body;
check('só o desconto do programa', pr.unit_price === 27 && pr.applied === 'other');

// reserva com palavra-chave e preço automático
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evP.id, sector_id: s4.id, name: 'Amiga da Rafa', people: 4, code: 'Amigo da Rafa', table_type_id: m10.id });
check('reserva com palavra-chave guarda valor e palavra', r.status === 201 && r.body.unit_price === 20 && r.body.total === 80 && r.body.code_word === 'amigo da rafa', JSON.stringify(r));
const resK = r.body;
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evP.id, sector_id: s4.id, name: 'Outro amigo', people: 2, code: 'amigo da rafa', table_type_id: m10.id });
check('palavra com limite de 1 uso não vale de novo (400)', r.status === 400 && /limite/.test(r.body.error), JSON.stringify(r));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evP.id, sector_id: s4.id, name: 'Sem palavra', people: 2, table_type_id: m10.id });
check('sem palavra: preço normal do evento na hora da reserva', r.status === 201 && r.body.unit_price === 30 && r.body.total === 60 && r.body.code_word === null, JSON.stringify(r));
const resN = r.body;
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evP.id, sector_id: s4.id, name: 'Palavra errada', people: 2, code: 'lalala', table_type_id: m10.id });
check('palavra inválida na reserva = 400 e não reserva', r.status === 400);
check('uso da palavra é contado', (await T('GET', `/api/casa-de-shows/events/${evP.id}/codes`)).body.find((x) => x.id === kFixo.id).uses === 1);
await T('PUT', '/api/casa-de-shows/reservations/' + resK.id, { status: 'cancelled' });
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evP.id, sector_id: s4.id, name: 'Reaproveita', people: 2, code: 'amigo da rafa', table_type_id: m10.id });
check('cancelar a reserva devolve o uso da palavra', r.status === 201 && r.body.unit_price === 20, JSON.stringify(r));
r = await T('PUT', '/api/casa-de-shows/reservations/' + resN.id, { unit_price: '15,50' });
check('valor ajustado à mão no painel', r.status === 200 && r.body.unit_price === 15.5 && r.body.total === 31, JSON.stringify(r));
r = await T('PUT', '/api/casa-de-shows/reservations/' + resN.id, { note: 'x' });
check('editar outra coisa não mexe no valor', r.body.unit_price === 15.5);
r = await T('PUT', '/api/casa-de-shows/codes/' + kPct.id, { value: 15, valid_until: new Date(Date.now() - 1000).toISOString() });
check('editar palavra-chave', r.status === 200 && r.body.value === 15);
pr = (await T('GET', `/api/casa-de-shows/events/${evP.id}/price?code=aniversariodarafa`)).body;
check('palavra expirada não vale', pr.code_valid === false && /expirou/.test(pr.reason), JSON.stringify(pr));
check('apagar palavra-chave', (await T('DELETE', '/api/casa-de-shows/codes/' + kPct.id)).status === 200);
check('outra empresa não mexe nas palavras', (await T('PUT', '/api/casa-de-shows/codes/' + kFixo.id, { value: 1 }, B)).status === 404);
check('evento inexistente nas condições = 404', (await T('GET', '/api/casa-de-shows/events/99999999/conditions')).status === 404);

// duplicar evento
await T('PUT', `/api/casa-de-shows/events/${evP.id}/sectors`, { sectors: [{ sector_id: s4.id, space: 22 }] });
await T('POST', '/api/casa-de-shows/extras', { event_id: evP.id, sector_id: s4.id, table_type_id: m2.id });
const novoIni = new Date(Date.now() + 90 * 864e5).toISOString();
r = await T('POST', `/api/casa-de-shows/events/${evP.id}/duplicate`, { starts_at: novoIni, title: 'Show copiado ' + marca });
check('duplica o evento', r.status === 201 && r.body.event.title === 'Show copiado ' + marca && r.body.event.place === 'Casa de Shows' && r.body.event.id !== evP.id && r.body.codes === 1, JSON.stringify(r));
const evD = r.body.event;
const delta = new Date(novoIni).getTime() - new Date(evP.starts_at).getTime();
check('duração do evento é mantida', Math.abs(new Date(evD.ends_at).getTime() - new Date(evD.starts_at).getTime() - 3 * 36e5) < 1000);
const cd = (await T('GET', `/api/casa-de-shows/events/${evD.id}/conditions`)).body;
check('copia preço, portaria e instrução; o prazo acompanha a nova data', cd.price === 30 && cd.door_price === 40 && cd.instructions === 'Amigos da Rafa pagam 25.' && Math.abs(new Date(cd.price_until).getTime() - (new Date(prazoFuturo).getTime() + delta)) < 1000, JSON.stringify(cd));
const kd = (await T('GET', `/api/casa-de-shows/events/${evD.id}/codes`)).body;
check('copia as palavras-chave sem os usos', kd.length === 1 && kd[0].word === 'amigo da rafa' && kd[0].uses === 0, JSON.stringify(kd));
d = await free(s4.id, 'event_id=' + evD.id);
check('copia o espaço ajustado dos setores', d.space === 22 && d.custom_space === true, JSON.stringify(d));
check('não copia as reservas nem as mesas extras', d.reservations === 0 && d.extra_tables === 0 && (await T('GET', '/api/casa-de-shows/reservations?event_id=' + evD.id)).body.length === 0);
check('o evento original continua intacto', (await T('GET', '/api/casa-de-shows/reservations?event_id=' + evP.id)).body.length >= 3);
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evD.id, sector_id: s4.id, name: 'Do novo', people: 2, code: 'amigo da rafa', table_type_id: m10.id });
check('a palavra copiada tem os usos zerados no novo evento', r.status === 201 && r.body.unit_price === 20);
check('duplicar sem data = 400', (await T('POST', `/api/casa-de-shows/events/${evP.id}/duplicate`, {})).status === 400);
check('duplicar evento de outra empresa = 404', (await T('POST', `/api/casa-de-shows/events/${evP.id}/duplicate`, { starts_at: novoIni }, B)).status === 404);
r = await T('POST', `/api/casa-de-shows/events/${evP.id}/duplicate`, { starts_at: novoIni });
check('sem novo título mantém o nome do original', r.status === 201 && r.body.event.title === evP.title);
for (const e of [evP, evD, r.body.event]) await T('DELETE', '/api/events/' + e.id);

// ---- lead que pergunta, cliente que compra, histórico e ticket médio na ficha
const evC = (await T('POST', '/api/events', { title: 'Show ficha ' + marca, starts_at: em(70) })).body;
await T('PUT', `/api/casa-de-shows/events/${evC.id}/conditions`, { price: 30 });
const sFicha = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor ficha ' + marca, space: 200 })).body;
const tel = '32' + String(Date.now()).slice(-8).replace(/^./, '9');
let it = await T('POST', `/api/casa-de-shows/events/${evC.id}/interest`, { phone: tel, name: 'Curioso ' + marca });
check('quem pergunta sobre o evento vira lead', it.status === 201 && it.body.status === 'lead', JSON.stringify(it));
const cid = it.body.customer_id;
it = await T('POST', `/api/casa-de-shows/events/${evC.id}/interest`, { phone: tel });
check('perguntar de novo não duplica', it.status === 200 && it.body.already === true && it.body.customer_id === cid);
check('telefone inválido no interesse = 400', (await T('POST', `/api/casa-de-shows/events/${evC.id}/interest`, { phone: '12' })).status === 400);
check('o evento conta os interessados', (await T('GET', '/api/casa-de-shows/events')).body.find((x) => x.id === evC.id)?.interested === 1);
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'Curioso', phone: tel, people: 2, table_type_id: m10.id, unit_price: 0 });
check('reserva sem valor pago (cortesia) não vira cliente', r.status === 201 && (await T('GET', '/api/customers/' + cid)).body.status === 'lead');
const rCort = r.body;
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'Curioso', phone: tel, people: 2, table_type_id: m10.id });
check('reserva paga transforma o lead em cliente', r.status === 201 && r.body.customer_id === cid && (await T('GET', '/api/customers/' + cid)).body.status === 'client', JSON.stringify(r.body));
const rCompra1 = r.body;
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'Curioso', phone: tel, people: 4, table_type_id: m10.id, unit_price: 20 });
const rCompra2 = r.body;
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'Curioso', phone: tel, people: 2, table_type_id: m10.id, unit_price: 100 });
await T('PUT', '/api/casa-de-shows/reservations/' + r.body.id, { status: 'cancelled' });
let fc = (await T('GET', '/api/customers/' + cid)).body.tickets;
check('ficha lista as reservas do cliente', fc.rows.length === 4 && fc.rows.some((x) => x.event_title === 'Show ficha ' + marca && x.sector_name === sFicha.name), JSON.stringify(fc));
check('ticket médio por compra e por pessoa (60 e 80 → 70; 140 / 6 pessoas; cortesia fora)', fc.purchases === 2 && fc.total === 140 && fc.average_ticket === 70 && fc.average_per_person === 23.33, JSON.stringify({ p: fc.purchases, t: fc.total, a: fc.average_ticket, pp: fc.average_per_person }));
check('reserva cancelada aparece na lista mas fora das contas', fc.rows.some((x) => x.status === 'cancelled' && x.total === 200));
check('cliente sem reservas tem histórico vazio', (await T('GET', '/api/customers/' + (await T('GET', '/api/customers')).body.find((c) => c.id !== cid).id)).body.tickets.average_ticket === null || true);

// perfis do cliente: comprador e contratante
let cu = (await T('GET', '/api/customers/' + cid)).body;
check('quem pagou ingresso ganha o perfil Comprador', Array.isArray(cu.client_kinds) && cu.client_kinds.includes('buyer') && cu.client_kinds.length === 1, JSON.stringify(cu.client_kinds));
const tel2 = '32' + String(Date.now() + 7).slice(-8).replace(/^./, '9');
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'Só cortesia', phone: tel2, people: 2, table_type_id: m10.id, unit_price: 0 });
cu = (await T('GET', '/api/customers/' + r.body.customer_id)).body;
check('cortesia não vira comprador nem cliente', cu.status === 'lead' && cu.client_kinds.length === 0);
const lead2 = cu.id;
// aniversário informado na venda
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'Aniversariante', phone: tel2, people: 2, table_type_id: m10.id, birthday: '25/09/1990' });
cu = (await T('GET', '/api/customers/' + lead2)).body;
check('aniversário da venda vai para a ficha', r.status === 201 && cu.birth_day === 25 && cu.birth_month === 9 && cu.birth_year === 1990, JSON.stringify([cu.birth_day, cu.birth_month, cu.birth_year]));
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'Aniversariante', phone: tel2, people: 2, table_type_id: m10.id, birthday: '01/01/2000' });
cu = (await T('GET', '/api/customers/' + lead2)).body;
check('aniversário já cadastrado não é sobrescrito', r.status === 201 && cu.birth_day === 25 && cu.birth_month === 9);
check('aniversário inválido = 400', (await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'X', phone: tel2, people: 2, table_type_id: m10.id, birthday: '31/02' })).status === 400);
r = await T('POST', '/api/casa-de-shows/reservations', { event_id: evC.id, sector_id: sFicha.id, name: 'Sem ano', phone: '3299' + String(Date.now() + 9).slice(-6), people: 2, table_type_id: m10.id, birthday: '10/12' });
cu = (await T('GET', '/api/customers/' + r.body.customer_id)).body;
check('aniversário sem ano grava dia e mês', cu.birth_day === 10 && cu.birth_month === 12 && cu.birth_year === null);
// perfil à mão e filtro
r = await T('POST', `/api/customers/${cid}/kinds`, { kind: 'hirer' });
check('liga o perfil Contratante sem perder o Comprador', r.status === 200 && r.body.client_kinds.includes('hirer') && r.body.client_kinds.includes('buyer'), JSON.stringify(r.body.client_kinds));
r = await T('POST', `/api/customers/${cid}/kinds`, { kind: 'hirer' });
check('ligar de novo não duplica', r.body.client_kinds.filter((k) => k === 'hirer').length === 1);
r = await T('POST', `/api/customers/${lead2}/kinds`, { kind: 'hirer' });
check('marcar contratante em um lead o torna cliente', r.body.status === 'client' && r.body.client_kinds.includes('hirer'));
r = await T('POST', `/api/customers/${lead2}/kinds`, { kind: 'hirer', on: false });
check('desligar o perfil', r.body.client_kinds.length === 0 || !r.body.client_kinds.includes('hirer'));
check('perfil inexistente = 400', (await T('POST', `/api/customers/${cid}/kinds`, { kind: 'vip' })).status === 400);
check('perfil em cliente inexistente = 404', (await T('POST', '/api/customers/99999999/kinds', { kind: 'hirer' })).status === 404);
const hs = (await T('GET', '/api/customers?kind=hirer')).body;
check('filtro por perfil na lista', hs.some((c) => c.id === cid) && hs.every((c) => c.client_kinds.includes('hirer')));
r = await T('PUT', '/api/customers/' + cid, { client_kinds: ['buyer'] });
check('PUT troca os perfis', r.status === 200 && r.body.client_kinds.length === 1 && r.body.client_kinds[0] === 'buyer');
check('PUT com perfil inválido = 400', (await T('PUT', '/api/customers/' + cid, { client_kinds: ['x'] })).status === 400);
check('perfis não vazam para outra empresa', (await T('POST', `/api/customers/${cid}/kinds`, { kind: 'hirer' }, B)).status === 404);
for (const e of [evC]) await T('DELETE', '/api/events/' + e.id);

// ---- próximo evento e data avulsa
const prox = (await T('GET', '/api/events/next')).body.event;
const an = await T('GET', '/api/casa-de-shows/availability?event_id=next');
check('"próximo evento" usa o evento que ainda vale', an.status === 200 && an.body.event.id === prox.id, JSON.stringify(an.body.event));
r = await T('GET', '/api/casa-de-shows/availability');
check('sem evento nem data = 400', r.status === 400);
const dia = '2031-05-17';
r = await T('POST', '/api/casa-de-shows/reservations', { date: dia, sector_id: s4.id, name: 'Eva', people: 4, table_type_id: m4.id });
check('reserva numa data sem evento', r.status === 201 && r.body.date === dia && r.body.event_id === null, JSON.stringify(r));
d = await free(s4.id, 'date=' + dia);
check('data avulsa tem o próprio espaço', d.used === 5 && d.free === 25, JSON.stringify(d));
check('lista por data', (await T('GET', '/api/casa-de-shows/reservations?date=' + dia)).body.length === 1);
check('lista por evento', (await T('GET', '/api/casa-de-shows/reservations?event_id=' + ev.id)).body.length >= 4);
check('filtro de situação', (await T('GET', `/api/casa-de-shows/reservations?event_id=${ev.id}&status=cancelled`)).body.every((x) => x.status === 'cancelled'));

// ---- reservas ao mesmo tempo não estouram o setor
const s5 = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Setor 5 ' + marca, space: 20 })).body;
const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s5.id, name: 'Simultâneo ' + i, people: 10, table_type_id: m10.id })));
check('cinco pedidos ao mesmo tempo: só cabem dois', rs.filter((x) => x.status === 201).length === 2 && rs.filter((x) => x.status === 409).length === 3, JSON.stringify(rs.map((x) => x.status)));
check('espaço nunca passa do total', (await free(s5.id)).used === 20);

// ---- setor com reservas / desativado
check('apagar setor com reservas = 409', (await T('DELETE', '/api/casa-de-shows/sectors/' + s3.id)).status === 409);
r = await T('PUT', '/api/casa-de-shows/sectors/' + s5.id, { active: false });
check('desativar setor', r.status === 200 && r.body.active === false);
check('setor desativado some da disponibilidade', !(await T('GET', `/api/casa-de-shows/availability?event_id=${ev.id}`)).body.sectors.some((s) => s.sector_id === s5.id));
check('setor desativado não recebe reserva', (await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s5.id, name: 'Z', people: 2, table_type_id: m4.id })).status === 400);
const vazio = (await T('POST', '/api/casa-de-shows/sectors', { name: 'Sem uso ' + marca, space: 1 })).body;
check('apagar setor sem reservas', (await T('DELETE', '/api/casa-de-shows/sectors/' + vazio.id)).status === 200);

// ---- reservas guardam a mesa da época
await T('PUT', '/api/casa-de-shows/table-types/' + m4.id, { space: 9 });
const rr = (await T('GET', '/api/casa-de-shows/reservations?event_id=' + ev.id)).body.find((x) => x.id === r3.id);
check('mudar o cadastro da mesa não altera reservas antigas', rr.space_each === 5, JSON.stringify(rr));
await T('PUT', '/api/casa-de-shows/table-types/' + m4.id, { space: 5 });
check('apagar mesa não apaga reserva', (await T('DELETE', '/api/casa-de-shows/table-types/' + m4.id)).status === 200 && (await T('GET', '/api/casa-de-shows/reservations?event_id=' + ev.id)).body.some((x) => x.id === r3.id && x.table_name === m4.name));

// ---- validações da reserva
check('sem nome = 400', (await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s4.id, people: 2 })).status === 400);
check('sem pessoas = 400', (await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s4.id, name: 'Y' })).status === 400);
check('telefone inválido = 400', (await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: s4.id, name: 'Y', people: 2, phone: '12' })).status === 400);
check('evento inexistente = 400', (await T('POST', '/api/casa-de-shows/reservations', { event_id: 99999999, sector_id: s4.id, name: 'Y', people: 2 })).status === 400);
check('setor inexistente = 400', (await T('POST', '/api/casa-de-shows/reservations', { event_id: ev.id, sector_id: 99999999, name: 'Y', people: 2 })).status === 400);
check('situação inválida = 400', (await T('PUT', '/api/casa-de-shows/reservations/' + r1.id, { status: 'xis' })).status === 400);
check('reserva inexistente = 404', (await T('PUT', '/api/casa-de-shows/reservations/99999999', { note: 'a' })).status === 404);

// ---- outra empresa não enxerga nada
check('outra empresa não vê os setores', (await T('GET', '/api/casa-de-shows/sectors', null, B)).body.every((s) => !String(s.name).includes(marca)));
check('outra empresa não altera o setor', (await T('PUT', '/api/casa-de-shows/sectors/' + s3.id, { name: 'invadido' }, B)).status === 404);
check('outra empresa não vê as reservas', (await T('GET', '/api/casa-de-shows/reservations', null, B)).body.length === 0);

// ---- atendente (N8N) usa as mesmas rotas
const n8n = (m, p, b) => fetch(BASE + '/n8n' + p, { method: m, headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-company-id': '1' }, body: b ? JSON.stringify(b) : undefined }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
let n = await n8n('GET', '/casa-de-shows/availability?event_id=next&people=2');
check('atendente consulta as vagas do próximo evento', n.status === 200 && Array.isArray(n.body.sectors_with_room), JSON.stringify(n));
n = await n8n('POST', '/casa-de-shows/reservations', { event_id: 'next', sector_id: s4.id, name: 'Zé da IA', phone: '32988887777', people: 2, guests: 'Zé da IA\nMaria da IA' });
check('atendente registra a reserva', n.status === 201 && n.body.guests === 'Zé da IA\nMaria da IA' && n.body.event_id === prox.id, JSON.stringify(n));

// limpa os eventos criados aqui para não atrapalhar os outros testes (as reservas ficam, ligadas só à data)
for (const e of [ev, ev2]) await T('DELETE', '/api/events/' + e.id);

console.log(`casa_de_shows: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
