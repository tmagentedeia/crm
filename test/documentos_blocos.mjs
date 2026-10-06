// Modelos por blocos e logotipo dos documentos. Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/documentos_blocos.mjs
import { execSync } from 'child_process';
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
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
psql('delete from company_1.doc_files; delete from company_1.doc_templates; delete from company_1.doc_settings');
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });

// logotipo
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
check('sem logotipo devolve vazio', (await api('GET', '/documents/logo')).body.logo === null);
check('logotipo inválido recusado', (await api('PUT', '/documents/logo', { logo: 'http://x/y.png' })).status === 400);
check('logotipo script recusado', (await api('PUT', '/documents/logo', { logo: 'data:image/svg+xml;base64,PHN2Zz4=' })).status === 400);
check('logotipo salvo', (await api('PUT', '/documents/logo', { logo: PNG })).body.logo === PNG);
check('empresa comum também cuida do próprio logotipo', (await call('PUT', '/api/documents/logo', { token: B.token, body: { logo: PNG } })).status === 200);
await call('PUT', '/api/documents/logo', { token: B.token, body: { logo: null } });
check('dados fixos não apagam o logotipo', (await api('PUT', '/documents/settings', { vars: { chave_pix: 'p@x.com' } })).status === 200 && (await api('GET', '/documents/logo')).body.logo === PNG);

// blocos
const doc = { config: { fonte: 'serif', cor: '#112233', borda: false }, blocos: [
  { tipo: 'logo', alinhamento: 'left', altura: 60 },
  { tipo: 'titulo', texto: 'Olá <b>{{nome}}</b>', tamanho: 28, alinhamento: 'center' },
  { tipo: 'dados', linhas: [{ rotulo: 'Pix', valor: '{{chave_pix}}' }] },
  { tipo: 'qrcode', alinhamento: 'center' },
  { tipo: 'script', texto: 'x' },
  { tipo: 'texto', texto: 'linha1\nlinha2', cor: 'red; background:url(x)' },
] };
const pv = (await api('POST', '/documents/preview', { blocks: doc })).body;
check('prévia dos blocos traz o logotipo', pv.html.includes(PNG), pv.html?.slice(0, 300));
check('prévia traz o nome e o Pix fixo', pv.html.includes('Maria da Silva') && pv.html.includes('p@x.com'));
check('texto do bloco não vira HTML', pv.html.includes('&lt;b&gt;') && !pv.html.includes('<b>'));
check('bloco desconhecido é ignorado', !/script/.test(pv.html.replace(/<title>.*<\/title>/, '')));
check('cor inválida é descartada', !/background:url/.test(pv.html));
check('quebra de linha vira <br>', pv.html.includes('linha1<br>linha2'));
check('fonte escolhida', pv.html.includes('Georgia') && pv.html.includes('#112233'));
check('QR Code entra no lugar do bloco', /data:image\/svg\+xml/.test(pv.html));

// sem logotipo a imagem some
await api('PUT', '/documents/logo', { logo: null });
const pv2 = (await api('POST', '/documents/preview', { blocks: doc })).body;
check('sem logotipo não sobra imagem quebrada', !/<img[^>]*src=""/.test(pv2.html) && !pv2.html.includes('logotipo_src'));

// salvar e reabrir
check('empresa comum não salva modelo', (await call('POST', '/api/documents/templates', { token: B.token, body: { name: 'x', kind: 'ingresso', blocks: doc } })).status === 403);
const c = await api('POST', '/documents/templates', { name: 'Por blocos', kind: 'ingresso', blocks: doc });
check('modelo por blocos criado', c.status === 201, JSON.stringify(c.body));
const t = (await api('GET', `/documents/templates/${c.body.id}`)).body;
check('reabre com os blocos normalizados', t.blocks?.blocos?.length === 5 && t.blocks.config.fonte === 'serif' && t.html.includes('Georgia'), JSON.stringify(t.blocks));
check('variáveis do modelo listadas', t.variables.includes('nome') && t.variables.includes('qrcode'));
const u = { ...t.blocks, blocos: [...t.blocks.blocos, { tipo: 'texto', texto: 'Rodapé {{empresa}}' }] };
await api('PUT', `/documents/templates/${c.body.id}`, { blocks: u });
const t2 = (await api('GET', `/documents/templates/${c.body.id}`)).body;
check('edição dos blocos atualiza o HTML', t2.blocks.blocos.length === 6 && t2.html.includes('Rodapé'));
await api('PUT', `/documents/templates/${c.body.id}`, { name: 'Renomeado' });
check('renomear mantém os blocos', (await api('GET', `/documents/templates/${c.body.id}`)).body.blocks?.blocos?.length === 6);
await api('PUT', `/documents/templates/${c.body.id}`, { html: '<p>{{nome}}</p>' });
const t3 = (await api('GET', `/documents/templates/${c.body.id}`)).body;
check('editar o HTML direto sai do modo por blocos', t3.blocks === null && t3.html === '<p>{{nome}}</p>');

// exemplo de ingresso é por blocos e usa o logotipo
psql('delete from company_1.doc_templates');
await api('PUT', '/documents/logo', { logo: PNG });
await api('POST', '/documents/templates/examples');
const lst = (await api('GET', '/documents/templates')).body;
const ing = lst.find((x) => x.kind === 'ingresso');
const ti = (await api('GET', `/documents/templates/${ing.id}`)).body;
check('ingresso de exemplo vem em blocos', ti.blocks?.blocos?.some((b) => b.tipo === 'logo') && ti.blocks.blocos.some((b) => b.tipo === 'qrcode'));
const pi = (await api('POST', '/documents/preview', { blocks: ti.blocks })).body;
check('ingresso de exemplo mostra logotipo e dados', pi.html.includes(PNG) && pi.html.includes('Show de exemplo') && pi.html.includes('Pista'));

// ingresso vertical: moldura de bilhete, cores e áreas do logotipo e do QR
const vert = (await api('GET', '/documents/templates')).body.find((x) => x.name.startsWith('Ingresso vertical'));
const tv = (await api('GET', `/documents/templates/${vert.id}`)).body;
check('ingresso vertical é por blocos com moldura de bilhete', tv.blocks.config.moldura === 'bilhete' && tv.blocks.config.largura === 380);
const pvv = (await api('POST', '/documents/preview', { blocks: { ...tv.blocks, config: { ...tv.blocks.config, corMoldura: '#ffcc00', fundo: '#f0f0ff', cor: '#003366' } } })).body;
check('cores da moldura, do miolo e do texto', pvv.html.includes('#ffcc00 19px') && pvv.html.includes('background:#f0f0ff') && pvv.html.includes('color:#003366'));
check('logotipo em área fixa sem distorcer', pvv.html.includes('object-fit:contain') && pvv.html.includes('width:240px'));
check('endereço, comprador e lugares da mesa na prévia', pvv.html.includes('Rua Exemplo, 100') && pvv.html.includes('João da Silva') && pvv.html.includes('Mesa para 4 lugares'));

// PDF gerado usa o logotipo
const g = await api('POST', '/documents/generate', { template: String(ing.id), name: 'Joana' });
check('gera PDF do modelo por blocos', g.status === 201, JSON.stringify(g.body));
console.log(`documentos_blocos: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
