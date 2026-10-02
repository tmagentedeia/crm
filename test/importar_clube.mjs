// Importação de clientes com ficha e Clube. Uso: BASE=http://localhost:3999 node test/importar_clube.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const lg = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@demo.com', password: 'demo1234' }) });
const T = (await lg.json()).token;
const niv = (await call('GET', '/api/club', T)).body.levels;
for (const n of ['Nível 1', 'Nível 2']) if (!niv.find((l) => l.name === n)) await call('POST', '/api/club/levels', T, { name: n, benefit_qty: 1 });

const rows = [
  { Nome: 'Teste', Sobrenome: 'Um', Telefone: '554191010001', Tipo: 'Clube', Plano: 'Nível 2', Pedidos: '', Aniversario: '19/09', Cidade: 'Londrina - PR', 'Data do cadastro': '11/09/2026', 'Status envio': 'Enviado' },
  { Nome: 'Teste', Sobrenome: 'Dois', Telefone: '(32) 99999-0002', Tipo: 'Ex Clube', Plano: '', Aniversario: '03/11/1985', Cidade: 'MA', 'Data do cadastro': '27/09/2026 17:54' },
  { Nome: 'Teste', Sobrenome: 'Tres', Telefone: '553299990003', Tipo: 'Contribuinte', Cidade: 'Tokio - Japan' },
  { Nome: 'Teste', Sobrenome: 'Quatro', Telefone: '553299990004', Tipo: '', Aniversario: '31/04' },
  { Nome: '', Sobrenome: '', Telefone: '553299990005', Tipo: '' },
  { Nome: 'Teste', Sobrenome: 'Seis', Telefone: '553299990006', Tipo: 'Clube', Plano: 'Nível 99' },
  { Nome: 'Ruim', Telefone: '123', Tipo: 'Clube' },
];
const sim = (await call('POST', '/api/import', T, { customers: rows, dry_run: true })).body;
check('simulação conta 6 novos', sim.customers.created === 6 && sim.dry_run === true, JSON.stringify(sim.customers));
check('telefone ruim vira erro', sim.errors.length === 1 && /telefone/.test(sim.errors[0]), JSON.stringify(sim.errors));
check('colunas não usadas listadas', sim.ignored_columns.includes('Pedidos') && sim.ignored_columns.includes('Status envio') && !sim.ignored_columns.includes('Plano'), JSON.stringify(sim.ignored_columns));
check('avisa nível que não existe', sim.warnings.some((w) => /Nível 99/.test(w)), JSON.stringify(sim.warnings));
check('avisa data inválida', sim.warnings.some((w) => /31\/04/.test(w)), JSON.stringify(sim.warnings));
check('simulação não grava', (await call('GET', '/api/customers?search=Teste', T)).body.filter((c) => c.last_name === 'Um').length === 0);

await call('POST', '/api/import', T, { customers: rows, dry_run: false });
const por = async (tel) => (await call('GET', '/api/customers/by-phone/' + tel, T)).body;
const c1 = await por('554191010001');
check('membro com nível, cidade e estado', c1.club_status === 'member' && c1.club_level_name === 'Nível 2' && c1.city === 'Londrina' && c1.state === 'PR' && c1.status === 'client', JSON.stringify(c1));
check('nascimento sem ano', c1.birth_day === 19 && c1.birth_month === 9 && c1.birth_year === null);
check('data do cadastro original', new Date(c1.created_at).toISOString().startsWith('2026-09-11'), c1.created_at);
const c2 = await por('553299990002');
check('telefone padronizado', !!c2 && c2.last_name === 'Dois', JSON.stringify(c2));
check('ex-membro sem nível, ano e hora do cadastro', c2.club_status === 'former' && c2.club_level_id === null && c2.birth_year === 1985 && new Date(c2.created_at).toISOString() === '2026-09-27T20:54:00.000Z', JSON.stringify(c2));
check('só estado', c2.city === null && c2.state === 'MA');
const c3 = await por('553299990003');
check('contribuinte e cidade fora do padrão', c3.club_status === 'supporter' && c3.city === 'Tokio - Japan' && c3.state === null);
const c4 = await por('553299990004');
check('sem situação = lead', c4.status === 'lead' && c4.club_status === null && c4.birth_day === null);
check('sem nome entra', (await por('553299990005')).name === null);
const c6 = await por('553299990006');
check('nível inexistente: membro sem nível', c6.club_status === 'member' && c6.club_level_id === null);

const again = (await call('POST', '/api/import', T, { customers: [{ Nome: 'Teste', Sobrenome: 'Um', Telefone: '554191010001', Cidade: '' }], dry_run: false })).body;
const c1b = await por('554191010001');
check('reimportar atualiza, não duplica', again.customers.updated === 1 && again.customers.created === 0);
check('reimportar com campo vazio não apaga', c1b.city === 'Londrina' && c1b.club_level_name === 'Nível 2' && c1b.birth_day === 19);
await call('POST', '/api/import', T, { customers: [{ Nome: 'Antigo', Telefone: '553299990007' }], dry_run: false });
check('planilha simples = cliente', (await por('553299990007')).status === 'client');

console.log(`importar_clube: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
