// Ficha do cliente (aniversário, cidade) e Clube (programa com níveis). Uso: BASE=http://localhost:3999 node test/clube.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const login = async (e, p) => (await call('POST', '/api/auth/login', { body: { email: e, password: p } })).body;
const A = (await login('demo@demo.com', 'demo1234')).token;
const B = (await login('dois@x.com', 'senhasenha')).token;
const T = (p, o = {}) => call(o.method || 'GET', p, { token: o.token || A, body: o.body });

// programa e níveis
let c = (await T('/api/club')).body;
check('nome padrão do programa', c.program_name === 'Programa de assinaturas' && Array.isArray(c.levels) && c.levels.length === 0, JSON.stringify(c));
check('renomeia o programa', (await T('/api/club', { method: 'PUT', body: { program_name: 'Clube do Miranda' } })).status === 200 && (await T('/api/club')).body.program_name === 'Clube do Miranda');
check('nome vazio recusado', (await T('/api/club', { method: 'PUT', body: { program_name: '  ' } })).status === 400);
const franquias = [['Nível 1', 0], ['Nível 2', 1], ['Nível 3', 2], ['Nível 4', 3], ['Nível 5', 4], ['Nível 6', 4]];
const niv = {};
for (const [n, q] of franquias) { const r = await T('/api/club/levels', { method: 'POST', body: { name: n, benefit_qty: q } }); check('cria ' + n, r.status === 201 && r.body.benefit_qty === q, JSON.stringify(r.body)); niv[n] = r.body.id; }
check('nível repetido = 409', (await T('/api/club/levels', { method: 'POST', body: { name: 'nível 1', benefit_qty: 0 } })).status === 409);
check('benefícios negativos recusados', (await T('/api/club/levels', { method: 'POST', body: { name: 'X', benefit_qty: -1 } })).status === 400);
check('benefícios fracionados recusados', (await T('/api/club/levels', { method: 'POST', body: { name: 'X', benefit_qty: 1.5 } })).status === 400);
check('nome do nível vazio recusado', (await T('/api/club/levels', { method: 'POST', body: { name: '', benefit_qty: 1 } })).status === 400);
c = (await T('/api/club')).body;
check('seis níveis em ordem', c.levels.map((l) => l.name).join() === 'Nível 1,Nível 2,Nível 3,Nível 4,Nível 5,Nível 6', JSON.stringify(c.levels));
check('edita a franquia de um nível', (await T('/api/club/levels/' + niv['Nível 6'], { method: 'PUT', body: { benefit_qty: 5 } })).body.benefit_qty === 5);
await T('/api/club/levels/' + niv['Nível 6'], { method: 'PUT', body: { benefit_qty: 4 } });

// ficha
const mk = (extra) => T('/api/customers', { method: 'POST', body: { name: 'Ana Clube', phone: '(32) 99111-2222', status: 'client', ...extra } });
let a = await mk({ birthday: '25/09', city: 'Juiz de Fora', club_status: 'member', club_level_id: niv['Nível 3'] });
check('cria com ficha completa', a.status === 201 && a.body.birth_day === 25 && a.body.birth_month === 9 && a.body.city === 'Juiz de Fora' && a.body.club_status === 'member' && a.body.club_level_name === 'Nível 3' && a.body.club_benefit_qty === 2, JSON.stringify(a.body));
check('telefone padronizado continua valendo', a.body.phone === '553291112222', a.body.phone);
const id = a.body.id;
check('aniversário com ano', (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: '03/11/1990' } })).body.birth_month === 11);
check('aniversário em formato de data', (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: '1990-02-14' } })).body.birth_day === 14);
check('29/02 é aceito', (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: '29/02' } })).status === 200);
check('31/04 recusado', (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: '31/04' } })).status === 400);
check('mês 13 recusado', (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: '10/13' } })).status === 400);
check('texto solto recusado', (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: 'ontem' } })).status === 400);
const lim = (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: '' } })).body;
check('aniversário vazio apaga', lim.birth_day === null && lim.birth_month === null);
check('editar outro campo não mexe na ficha', (await T('/api/customers/' + id, { method: 'PUT', body: { notes: 'oi' } })).body.club_level_name === 'Nível 3');
check('troca de nível', (await T('/api/customers/' + id, { method: 'PUT', body: { club_level_id: niv['Nível 5'] } })).body.club_benefit_qty === 4);
check('nível inexistente recusado', (await T('/api/customers/' + id, { method: 'PUT', body: { club_level_id: 999999 } })).status === 400);

// regras de situação
const ex = (await T('/api/customers/' + id, { method: 'PUT', body: { club_status: 'former' } })).body;
check('ex-membro perde o nível', ex.club_status === 'former' && ex.club_level_id === null && ex.club_level_name === null, JSON.stringify(ex));
check('nível em quem não é membro = 400', (await T('/api/customers/' + id, { method: 'PUT', body: { club_level_id: niv['Nível 1'] } })).status === 400);
check('situação inválida = 400', (await T('/api/customers/' + id, { method: 'PUT', body: { club_status: 'vip' } })).status === 400);
check('volta a ser membro com nível', (await T('/api/customers/' + id, { method: 'PUT', body: { club_status: 'member', club_level_id: niv['Nível 2'] } })).body.club_level_name === 'Nível 2');

// campos completos da ficha
const f1 = (await T('/api/customers/' + id, { method: 'PUT', body: { name: 'Ana', last_name: 'Souza', state: 'mg', gender: 'female', birthday: '25/09/1990' } })).body;
check('nome e sobrenome separados', f1.name === 'Ana' && f1.last_name === 'Souza', JSON.stringify(f1));
check('estado em maiúsculas', f1.state === 'MG');
check('gênero gravado', f1.gender === 'female');
check('ano do aniversário gravado e idade calculada', f1.birth_year === 1990 && f1.age >= 35 && f1.age <= 36, JSON.stringify([f1.birth_year, f1.age]));
check('trocar dia/mês sem ano mantém o ano', (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: '26/09' } })).body.birth_year === 1990);
check('estado inválido recusado', (await T('/api/customers/' + id, { method: 'PUT', body: { state: 'Minas' } })).status === 400);
check('gênero inválido recusado', (await T('/api/customers/' + id, { method: 'PUT', body: { gender: 'x' } })).status === 400);
check('ano futuro recusado', (await T('/api/customers/' + id, { method: 'PUT', body: { birthday: '01/01/2999' } })).status === 400);
const antes = (await T('/api/customers/' + id)).body.updated_at;
await new Promise((r) => setTimeout(r, 30));
const dep = (await T('/api/customers/' + id, { method: 'PUT', body: { city: 'Barbacena' } })).body.updated_at;
check('data da última atualização muda ao editar a ficha', new Date(dep) > new Date(antes), antes + ' -> ' + dep);
check('sem sobrenome o cadastro vale (agente só sabe o primeiro nome)', (await T('/api/customers', { method: 'POST', body: { name: 'Só Nome', phone: '32988880009' } })).status === 201);
await T('/api/customers/' + id, { method: 'PUT', body: { name: 'Ana Clube', last_name: '', birthday: '' } });

// outros clientes para filtros
await T('/api/customers', { method: 'POST', body: { name: 'Beto Apoio', phone: '32988880001', status: 'client', club_status: 'supporter' } });
await T('/api/customers', { method: 'POST', body: { name: 'Caio Comum', phone: '32988880002', status: 'lead' } });
const lista = async (qs) => (await T('/api/customers?' + qs)).body;
check('filtro membros', (await lista('club=member')).every((x) => x.club_status === 'member') && (await lista('club=member')).some((x) => x.id === id));
check('filtro apoiadores', (await lista('club=supporter')).map((x) => x.name).join() === 'Beto Apoio');
check('filtro fora do programa', (await lista('club=none')).every((x) => x.club_status === null) && (await lista('club=none')).some((x) => x.name === 'Caio Comum'));
check('filtro por nível', (await lista('level=' + niv['Nível 2'])).map((x) => x.id).join() === String(id));
const exp = (await T('/api/customers/export?club=member')).body;
check('planilha traz cidade, aniversário e nível', exp.length >= 1 && exp[0].club_level_name === 'Nível 2' && 'city' in exp[0] && 'birth_day' in exp[0], JSON.stringify(exp[0]));
const bp = (await T('/api/customers/by-phone/553291112222')).body;
check('consulta por telefone devolve o nível (para o agente)', bp.club_level_name === 'Nível 2' && bp.club_benefit_qty === 1, JSON.stringify(bp));
check('upsert sem ficha não apaga a ficha', (await (await fetch(BASE + '/n8n/customers', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-company-id': '1' }, body: JSON.stringify({ name: 'Ana Clube', phone: '32991112222' }) })).json()).club_level_name === 'Nível 2');

// ordem da lista
await T('/api/customers', { method: 'POST', body: { name: 'Zeca Ordem', phone: '32988880031', city: 'Ubá' } });
await T('/api/customers', { method: 'POST', body: { name: 'aline Ordem', phone: '32988880032', city: 'Juiz de Fora' } });
const ord = async (qs) => (await lista(qs)).filter((x) => /Ordem$/.test(x.name || '')).map((x) => x.name);
check('ordem por nome A-Z (sem diferenciar maiúscula)', (await ord('sort=name&dir=asc')).join() === 'aline Ordem,Zeca Ordem');
check('ordem por nome Z-A', (await ord('sort=name&dir=desc')).join() === 'Zeca Ordem,aline Ordem');
check('ordem por cidade A-Z', (await ord('sort=city&dir=asc')).join() === 'aline Ordem,Zeca Ordem');
check('ordem por cidade Z-A', (await ord('sort=city&dir=desc')).join() === 'Zeca Ordem,aline Ordem');
const semCidade = await lista('sort=city&dir=asc');
check('sem cidade vai para o fim', semCidade[semCidade.length - 1].city === null || semCidade[semCidade.length - 1].city === '');
check('ordem inválida não quebra', (await T('/api/customers?sort=drop&dir=x')).status === 200);

// contagens e exclusão de nível
c = (await T('/api/club')).body;
check('contagem por nível', c.levels.find((l) => l.name === 'Nível 2').members === 1 && c.counts.member >= 1 && c.counts.supporter === 1, JSON.stringify(c));
check('nível em uso não é excluído', (await T('/api/club/levels/' + niv['Nível 2'], { method: 'DELETE' })).status === 409);
check('nível sem clientes é excluído', (await T('/api/club/levels/' + niv['Nível 6'], { method: 'DELETE' })).status === 200);
check('nível inexistente = 404', (await T('/api/club/levels/999999', { method: 'DELETE' })).status === 404);

// isolamento entre empresas
const cb = (await T('/api/club', { token: B })).body;
check('empresa 2 não vê o programa da 1', cb.program_name === 'Programa de assinaturas' && cb.levels.length === 0, JSON.stringify(cb));
check('empresa 2 não usa nível da 1', (await T('/api/customers', { token: B, method: 'POST', body: { name: 'Z', phone: '32977770001', club_status: 'member', club_level_id: niv['Nível 1'] } })).status === 400);
check('empresa 2 não edita nível da 1', (await T('/api/club/levels/' + niv['Nível 1'], { token: B, method: 'PUT', body: { name: 'Hack' } })).status === 404);
check('sem login = 401', (await call('GET', '/api/club')).status === 401);

// cadastro de assinante pela agente
const m1 = await T('/api/club/member', { method: 'POST', body: { phone: '553288770001', name: 'Assinante Novo', level: '4', birthday: '25/09/1990', last_name: 'Silva' } });
check('cadastra assinante novo com nível 4', m1.status === 201 && m1.body.club_status === 'member' && m1.body.club_level_name === 'Nível 4' && m1.body.birth_day === 25 && m1.body.last_name === 'Silva', JSON.stringify(m1.body));
const m2 = await T('/api/club/member', { method: 'POST', body: { phone: '553288770001', level: 'Nível 5' } });
check('muda o nível do assinante existente', m2.status === 201 && m2.body.club_level_name === 'Nível 5' && m2.body.id === m1.body.id && m2.body.name === 'Assinante Novo', JSON.stringify(m2.body));
const m3 = await T('/api/club/member', { method: 'POST', body: { phone: '553288770001', level: '9' } });
check('nível inexistente = 400 com a lista', m3.status === 400 && Array.isArray(m3.body.levels), JSON.stringify(m3.body));
check('telefone inválido = 400', (await T('/api/club/member', { method: 'POST', body: { phone: '12', level: '1' } })).status === 400);
check('data inválida = 400', (await T('/api/club/member', { method: 'POST', body: { phone: '553288770002', level: '1', birthday: '40/13/2000' } })).status === 400);
check('empresa 2 não tem esse nível', (await T('/api/club/member', { token: B, method: 'POST', body: { phone: '553288770003', level: '1' } })).status === 400);
console.log(`clube: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
