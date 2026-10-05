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
limpa();
console.log(`shows_importar: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
