// Locais e formatos da Casa de Shows. Uso: BASE=http://localhost:3999 node test/casa_de_shows_locais.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body, headers: h } = {}) => {
  const headers = { 'content-type': 'application/json', ...h };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };
const marca = String(Date.now()).slice(-6);
const em = (dias) => new Date(Date.now() + dias * 864e5).toISOString();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---- o local inicial se chama Padrão
const locais0 = (await api('GET', '/casa-de-shows/venues')).body;
const principal = locais0[0];
check('existe um local chamado Padrão com formato padrão', principal && principal.name === 'Padrão' && principal.layouts.length >= 1 && principal.layouts[0].is_default === true, JSON.stringify(locais0));

// ---- criar local
check('local sem nome recusado', (await api('POST', '/casa-de-shows/venues', { name: '' })).status === 400);
const B = (await api('POST', '/casa-de-shows/venues', { name: 'Espaço B ' + marca, address: 'Rua das Flores, 10' })).body;
check('local criado já nasce com formato padrão', B.id && B.layouts.length === 1 && B.layouts[0].name === 'Padrão' && B.layouts[0].is_default, JSON.stringify(B));
check('nome de local repetido = 409', (await api('POST', '/casa-de-shows/venues', { name: 'Espaço B ' + marca })).status === 409);
check('editar o local', (await api('PUT', `/casa-de-shows/venues/${B.id}`, { notes: 'Salão dos fundos' })).body.notes === 'Salão dos fundos');

// ---- setores por local
const tipo = (await api('POST', '/casa-de-shows/table-types', { name: 'Mesa Loc ' + marca, seats: 4, space: 2 })).body;
const sPista = (await api('POST', '/casa-de-shows/sectors', { name: 'Pista ' + marca, space: 20 })).body;
const sCam = (await api('POST', '/casa-de-shows/sectors', { name: 'Camarote ' + marca, space: 10 })).body;
check('setor sem local vai para o primeiro local', String(sPista.venue_id) === String(principal.id), JSON.stringify(sPista));
const sB1 = (await api('POST', '/casa-de-shows/sectors', { venue_id: B.id, name: 'Pista ' + marca, space: 8 })).body;
check('mesmo nome de setor em outro local é permitido', sB1.id && String(sB1.venue_id) === String(B.id), JSON.stringify(sB1));
check('mesmo nome no mesmo local = 409', (await api('POST', '/casa-de-shows/sectors', { venue_id: B.id, name: 'Pista ' + marca, space: 3 })).status === 409);
check('lista de setores filtra por local', (await api('GET', `/casa-de-shows/sectors?venue_id=${B.id}`)).body.length === 1);
check('local inexistente recusado', (await api('POST', '/casa-de-shows/sectors', { venue_id: '999999', name: 'X', space: 1 })).status === 400);

// ---- sem escolha: primeiro local e formato padrão (como antes)
const evA = (await api('POST', '/events', { title: 'Evento A ' + marca, starts_at: em(30) })).body;
const dispA = (await api('GET', `/casa-de-shows/availability?event_id=${evA.id}`)).body;
check('evento sem escolha usa o primeiro local', String(dispA.venue.id) === String(principal.id) && dispA.layout.name === 'Padrão' && dispA.sectors.some((s) => s.name === 'Pista ' + marca && s.space === 20) && !dispA.sectors.some((s) => s.space === 8), JSON.stringify(dispA.venue));

// ---- formatos
const F = (await api('POST', '/casa-de-shows/layouts', { venue_id: principal.id, name: 'Show em pé ' + marca,
  sectors: [{ sector_id: sPista.id, space: 12, tables: [{ table_type_id: tipo.id, max_tables: 2 }] }] })).body;
check('formato criado com setor, espaço e mesas próprias', F.id && F.all_sectors === false && F.sectors.length === 1 && F.sectors[0].space === 12 && F.sectors[0].effective_space === 12 && F.sectors[0].tables.length === 1 && F.sectors[0].tables[0].max_tables === 2, JSON.stringify(F));
check('formato com setor de outro local = 400', (await api('POST', '/casa-de-shows/layouts', { venue_id: principal.id, name: 'Errado', sectors: [{ sector_id: sB1.id }] })).status === 400);
check('nome de formato repetido = 409', (await api('POST', '/casa-de-shows/layouts', { venue_id: principal.id, name: 'Show em pé ' + marca })).status === 409);
const Fpadrao = (await api('GET', `/casa-de-shows/layouts?venue_id=${principal.id}`)).body.find((l) => l.is_default);
check('formato padrão lista todos os setores do local', Fpadrao.all_sectors === true && Fpadrao.sectors.length >= 2);

// ---- evento escolhe local e formato
const evB = (await api('POST', '/events', { title: 'Evento B ' + marca, starts_at: em(31) })).body;
check('formato de outro local = 400', (await api('PUT', `/casa-de-shows/events/${evB.id}/setup`, { venue_id: B.id, layout_id: F.id })).status === 400);
const st = (await api('PUT', `/casa-de-shows/events/${evB.id}/setup`, { venue_id: principal.id, layout_id: F.id })).body;
check('evento passa a usar o formato', st.layout.name === 'Show em pé ' + marca && st.chosen === true);
const dispB = (await api('GET', `/casa-de-shows/availability?event_id=${evB.id}`)).body;
check('só o setor do formato aparece, com o espaço do formato', dispB.sectors.length === 1 && dispB.sectors[0].name === 'Pista ' + marca && dispB.sectors[0].space === 12 && dispB.sectors[0].base_space === 12, JSON.stringify(dispB.sectors));
check('regra de mesas do formato vale (máx. 2)', dispB.sectors[0].fits.find((f) => String(f.table_type_id) === String(tipo.id)).tables === 2);
check('setor fora do formato não recebe reserva', (await api('POST', '/casa-de-shows/reservations', { event_id: evB.id, sector_id: sCam.id, name: 'Fora', people: 2 })).status === 409);
const r1 = await api('POST', '/casa-de-shows/reservations', { event_id: evB.id, sector_id: sPista.id, name: 'Dentro', people: 8, table_type_id: tipo.id });
check('reserva no setor do formato', r1.status === 201, JSON.stringify(r1.body));
check('máximo de mesas do formato respeitado', (await api('POST', '/casa-de-shows/reservations', { event_id: evB.id, sector_id: sPista.id, name: 'Demais', people: 4, table_type_id: tipo.id })).status === 409);
check('diminuir o espaço abaixo do usado = 409', (await api('PUT', `/casa-de-shows/layouts/${F.id}`, { sectors: [{ sector_id: sPista.id, space: 3 }] })).status === 409);
check('tirar do formato um setor com reservas = 409', (await api('PUT', `/casa-de-shows/events/${evB.id}/setup`, { venue_id: B.id })).status === 409);
check('formato em uso não pode ser apagado', (await api('DELETE', `/casa-de-shows/layouts/${F.id}`)).status === 409);
check('formato padrão não pode ser apagado', (await api('DELETE', `/casa-de-shows/layouts/${Fpadrao.id}`)).status === 409);

// ---- outro local
const evC = (await api('POST', '/events', { title: 'Evento C ' + marca, starts_at: em(32) })).body;
await api('PUT', `/casa-de-shows/events/${evC.id}/setup`, { venue_id: B.id });
const dispC = (await api('GET', `/casa-de-shows/availability?event_id=${evC.id}`)).body;
check('evento no outro local só mostra setores dele', dispC.venue.name === 'Espaço B ' + marca && dispC.sectors.length === 1 && dispC.sectors[0].space === 8, JSON.stringify(dispC));
check('setor do local errado recusado', (await api('POST', '/casa-de-shows/reservations', { event_id: evC.id, sector_id: sPista.id, name: 'X', people: 2 })).status === 409);
check('reserva no local certo', (await api('POST', '/casa-de-shows/reservations', { event_id: evC.id, sector_id: sB1.id, name: 'No B', people: 4 })).status === 201);
check('o mesmo dia pode ter dois locais com vagas separadas', (await api('GET', `/casa-de-shows/availability?event_id=${evB.id}`)).body.sectors[0].reservations === 1 && dispC.sectors[0].reservations === 0);
const lista = (await api('GET', '/casa-de-shows/events')).body;
check('lista de eventos traz local e formato', lista.find((e) => e.id === evC.id)?.venue.name === 'Espaço B ' + marca && lista.find((e) => e.id === evB.id)?.layout.name === 'Show em pé ' + marca);
check('o atendente vê o local e o formato', (await call('GET', `/n8n/casa-de-shows/availability?event_id=${evC.id}`, { headers: N8N })).body.venue.name === 'Espaço B ' + marca);

// ---- duplicar o evento leva local e formato
const dup = (await api('POST', `/casa-de-shows/events/${evB.id}/duplicate`, { starts_at: em(60), title: 'Copia B ' + marca })).body;
check('duplicar leva o formato', (await api('GET', `/casa-de-shows/events/${dup.event.id}/setup`)).body.layout.name === 'Show em pé ' + marca);

// ---- mapa por local
check('mapa do local B', (await api('POST', '/casa-de-shows/media', { kind: 'map', venue_id: B.id, data: PNG })).status === 201);
const mapaB = (await api('GET', `/casa-de-shows/media?venue_id=${B.id}`)).body;
check('cada local tem o seu mapa', mapaB.map && (await api('GET', `/casa-de-shows/media?event_id=${evC.id}`)).body.map?.url === mapaB.map.url && (await api('GET', `/casa-de-shows/media?event_id=${evB.id}`)).body.map?.url !== mapaB.map.url);

const fotoB = await api('POST', '/casa-de-shows/media', { kind: 'photo', sector_id: sB1.id, data: PNG });
check('foto de setor do outro local', fotoB.status === 201 && (await api('GET', `/casa-de-shows/media?sector_id=${sB1.id}`)).body.sectors[0]?.photos.length === 1);

// ---- voltar ao padrão e apagar
check('voltar ao padrão com reservas no outro local = 409', (await api('PUT', `/casa-de-shows/events/${evC.id}/setup`, { venue_id: null })).status === 409);
await api('PUT', `/casa-de-shows/events/${evA.id}/setup`, { venue_id: B.id });
const volta = (await api('PUT', `/casa-de-shows/events/${evA.id}/setup`, { venue_id: null })).body;
check('voltar ao primeiro local e formato padrão', volta.chosen === false && String(volta.venue.id) === String(principal.id) && volta.layout.name === 'Padrão', JSON.stringify(volta));
check('local com setores não é apagado', (await api('DELETE', `/casa-de-shows/venues/${B.id}`)).status === 409);

// ---- limpeza
const reservas = (await api('GET', '/casa-de-shows/reservations')).body.filter((v) => /^(Dentro|No B)$/.test(v.name));
for (const v of reservas) await api('DELETE', `/casa-de-shows/reservations/${v.id}`);
for (const e of [evA, evB, evC, dup.event]) await api('DELETE', `/events/${e.id}`);
await api('DELETE', `/casa-de-shows/layouts/${F.id}`);
check('apagar setor e local', (await api('DELETE', `/casa-de-shows/sectors/${sB1.id}`)).status === 200 && (await api('DELETE', `/casa-de-shows/venues/${B.id}`)).status === 200);
await api('DELETE', `/casa-de-shows/sectors/${sPista.id}`); await api('DELETE', `/casa-de-shows/sectors/${sCam.id}`); await api('DELETE', `/casa-de-shows/table-types/${tipo.id}`);
check('o último local não pode ser apagado', (await api('DELETE', `/casa-de-shows/venues/${principal.id}`)).status === 409);
console.log(`casa_de_shows_locais: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
