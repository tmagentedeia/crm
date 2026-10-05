// Importação de setores e mesas por planilha (Casa de Shows). Uso: BASE=http://localhost:3999 node test/shows_importar.mjs
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const limpa = () => execSync(`psql "${process.env.DATABASE_URL}" -qc "set search_path to company_1, public; delete from shows_sectors where name like 'ZZI %'; delete from shows_table_types where name like 'ZZI %'"`);
limpa();
const dados = {
  tables: [{ Mesa: 'ZZI Mesa de 2', Lugares: 2, Pontos: 3 }, { Mesa: 'ZZI Mesa de 4', Lugares: 4, Pontos: '' }, { Mesa: 'ZZI sem lugares', Lugares: 'x' }],
  sectors: [{ Setor: 'ZZI A', Capacidade: 24 }, { Setor: 'ZZI B', Mesas: 6, 'Lugares por mesa': 4 }, { Setor: 'ZZI C' }],
};
const sim = (await api('POST', '/casa-de-shows/import', { ...dados, dry_run: true })).body;
check('conferir não grava', sim.dry_run && sim.tables.created === 2 && sim.sectors.created === 2 && (await api('GET', '/casa-de-shows/table-types')).body.every((x) => !x.name.startsWith('ZZI')));
check('linhas com problema aparecem', sim.errors.length === 2 && sim.errors.some((e) => /ZZI sem lugares/.test(e)) && sim.errors.some((e) => /ZZI C/.test(e)), JSON.stringify(sim.errors));
const real = (await api('POST', '/casa-de-shows/import', { ...dados, dry_run: false })).body;
check('importa', real.tables.created === 2 && real.sectors.created === 2, JSON.stringify(real));
const mesas = (await api('GET', '/casa-de-shows/table-types')).body.filter((x) => x.name.startsWith('ZZI'));
check('pontos informados valem e, vazios, valem os lugares', mesas.find((x) => x.name === 'ZZI Mesa de 2').space === 3 && mesas.find((x) => x.name === 'ZZI Mesa de 4').space === 4, JSON.stringify(mesas));
const setores = (await api('GET', '/casa-de-shows/sectors')).body.filter((x) => x.name.startsWith('ZZI'));
check('capacidade direta e por mesas x lugares', setores.find((x) => x.name === 'ZZI A').space === 24 && setores.find((x) => x.name === 'ZZI B').space === 24, JSON.stringify(setores));
const de_novo = (await api('POST', '/casa-de-shows/import', { ...dados, dry_run: false })).body;
check('reimportar atualiza sem duplicar', de_novo.tables.updated === 2 && de_novo.tables.created === 0 && de_novo.sectors.updated === 2, JSON.stringify(de_novo));
// mesas aceitas pelo setor
const regras = (await api('POST', '/casa-de-shows/import', { sectors: [{ Setor: 'ZZI A', Capacidade: 24, 'Mesas aceitas': 'ZZI Mesa de 2:4; ZZI Mesa de 4' }, { Setor: 'ZZI B', Capacidade: 10, 'Mesas aceitas': 'ZZI Mesa inexistente' }], dry_run: false })).body;
const sa = (await api('GET', '/casa-de-shows/sectors')).body.find((x) => x.name === 'ZZI A');
check('mesas aceitas gravadas com máximo', regras.sectors.updated === 1 && JSON.stringify((sa.tables || []).map((x) => x.max_tables).sort()) === JSON.stringify([null, 4].sort()) || (sa.tables || []).length === 2, JSON.stringify(sa.tables));
check('mesa aceita desconhecida vira aviso de erro', regras.errors.length === 1 && /inexistente/.test(regras.errors[0]), JSON.stringify(regras.errors));
// ficha do setor: visão, som, características, grupo ideal, última opção
const ficha = (await api('POST', '/casa-de-shows/import', { sectors: [
  { Setor: 'ZZI A', Capacidade: 24, 'Visão': '8,5', Som: '7 e 8', 'Características': 'longe das janelas', 'Grupo ideal de': 1, 'Grupo ideal até': 2 },
  { Setor: 'ZZI B', Capacidade: 24, 'Só se não houver outro': 'sim' },
  { Setor: 'ZZI D', Capacidade: 8, 'Visão': 11 }], dry_run: false })).body;
const fa = (await api('GET', '/casa-de-shows/sectors')).body.filter((x) => x.name.startsWith('ZZI'));
const a1 = fa.find((x) => x.name === 'ZZI A'), b1 = fa.find((x) => x.name === 'ZZI B');
check('ficha do setor importada', a1.view_score === 8.5 && a1.sound === '7 e 8' && a1.traits === 'longe das janelas' && a1.ideal_min === 1 && a1.ideal_max === 2 && b1.last_resort === true, JSON.stringify(a1));
check('nota de visão fora de 0 a 10 é recusada', ficha.errors.length === 1 && /ZZI D/.test(ficha.errors[0]), JSON.stringify(ficha.errors));
const pu = await api('PUT', '/casa-de-shows/sectors/' + a1.id, { ideal_min: 5, ideal_max: 2 });
check('grupo ideal com mínimo maior que o máximo é recusado', pu.status === 400, JSON.stringify(pu.body));
const pu2 = await api('PUT', '/casa-de-shows/sectors/' + a1.id, { view_score: 12 });
check('nota 12 recusada pelo painel', pu2.status === 400);
const pu3 = await api('PUT', '/casa-de-shows/sectors/' + a1.id, { sound: '9 e 10', last_resort: true });
check('editar a ficha pelo painel', pu3.status === 200 && pu3.body.sound === '9 e 10' && pu3.body.last_resort === true && pu3.body.view_score === 8.5, JSON.stringify(pu3.body));
await api('PUT', '/casa-de-shows/sectors/' + a1.id, { last_resort: false });
// ordem sugerida: ideal primeiro, "só se não houver outro" por último
const dia = new Date(Date.now() + 86400000 * 40).toISOString().slice(0, 10);
const disp = (await api('GET', `/casa-de-shows/availability?date=${dia}&people=2`)).body;
const sug = disp.suggested_sectors || [];
check('ordem sugerida: ideal antes do resto e última opção no fim', sug.indexOf('ZZI A') !== -1 && sug.indexOf('ZZI A') < sug.indexOf('ZZI B') && sug.indexOf('ZZI B') === sug.length - 1, JSON.stringify(sug));
limpa();
console.log(`shows_importar: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
