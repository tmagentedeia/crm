// Gerador de documentos em PDF. Uso: BASE=http://localhost:3999 node test/documentos.mjs (precisa do test/fake_gotenberg.mjs e GOTENBERG_URL no servidor)
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body, key } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (key) { headers['x-api-key'] = key; headers['x-company-id'] = '1'; }
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.clone().json(); } catch {}
  return { status: r.status, body: j, res: r };
};
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
psql('delete from company_1.doc_files; delete from company_1.doc_templates; delete from company_1.doc_settings');

check('status informa que o PDF está ligado', (await call('GET', '/api/documents/status', { token: A.token })).body?.configured === true);
check('serviço de PDF responde ao teste', (await call('GET', '/api/documents/health', { token: A.token })).body?.ok === true);
check('empresa comum não edita modelos', (await call('POST', '/api/documents/templates', { token: B.token, body: { name: 'x', kind: 'contrato', html: '<p>x</p>' } })).status === 403);
check('modelo vazio recusado', (await call('POST', '/api/documents/templates', { token: A.token, body: { name: 'x', kind: 'contrato', html: '  ' } })).status === 400);
check('tipo inválido recusado', (await call('POST', '/api/documents/templates', { token: A.token, body: { name: 'x', kind: 'nada', html: '<p>x</p>' } })).status === 400);

const html = '<html><body><h1>{{nome}}</h1><p>Pix: {{chave_pix}}</p><p>{{extra}}</p><div>{{{text}}}</div><p>{{numero}} {{data}}</p><p>{{nao_enviada}}</p></body></html>';
const t1 = await call('POST', '/api/documents/templates', { token: A.token, body: { name: 'Contrato teste', kind: 'contrato', html } });
check('modelo criado', t1.status === 201 && !!t1.body?.id);
const lst = (await call('GET', '/api/documents/templates', { token: A.token })).body;
check('primeiro modelo do tipo vira o padrão', lst.length === 1 && lst[0].is_default === true);
const t2 = await call('POST', '/api/documents/templates', { token: A.token, body: { name: 'Contrato 2', kind: 'contrato', html: '<p>{{nome}}</p>', is_default: true } });
const lst2 = (await call('GET', '/api/documents/templates', { token: A.token })).body;
check('só um padrão por tipo', lst2.filter((x) => x.is_default).length === 1 && lst2.find((x) => x.is_default).id === t2.body.id);
await call('PUT', `/api/documents/templates/${t1.body.id}`, { token: A.token, body: { is_default: true } });
check('trocar o padrão', (await call('GET', '/api/documents/templates', { token: A.token })).body.find((x) => x.is_default).id === t1.body.id);
check('lista as variáveis do modelo', (await call('GET', `/api/documents/templates/${t1.body.id}`, { token: A.token })).body?.variables?.includes('chave_pix'));

check('dados fixos só aceitam nomes válidos', Object.keys((await call('PUT', '/api/documents/settings', { token: A.token, body: { vars: { chave_pix: 'pix@x.com', 'nome inválido': 'x', extra: 'fixo' } } })).body.vars).join() === 'chave_pix,extra');

const prev = (await call('POST', '/api/documents/preview', { token: A.token, body: { html } })).body;
check('pré-visualização troca as variáveis', prev.html.includes('pix@x.com') && !prev.html.includes('{{'), prev.html);
check('pré-visualização avisa variável sem valor', prev.missing.includes('nao_enviada'));

const key = psql("select 1").length ? process.env.N8N_API_KEY || 'test-key' : '';
const g = await call('POST', '/api/documents/generate', { token: A.token, body: { template: 'contrato', name: 'João <b>Silva</b>', number: '32 99999-1111', text: '<ul><li>Data: 20/12</li></ul><script>alert(1)</script><img src=x onerror=alert(2)>', fields: { extra: 'campo do agente' } } });
check('gera o documento', g.status === 201 && /\/d\/1-[0-9a-f]{48}\.pdf$/.test(g.body?.url || ''), JSON.stringify(g.body));
const pub = await fetch(g.body.url.replace(/^https?:\/\/[^/]+/, BASE));
const bin = Buffer.from(await pub.arrayBuffer()).toString();
check('o link público entrega o PDF sem login', pub.status === 200 && pub.headers.get('content-type') === 'application/pdf' && bin.startsWith('%PDF-FAKE'));
check('nome do cliente sai escapado', bin.includes('João &lt;b&gt;Silva&lt;/b&gt;'));
check('dado fixo e campo do agente entram', bin.includes('pix@x.com') && bin.includes('campo do agente'));
check('o texto em HTML entra sem script nem eventos', bin.includes('<li>Data: 20/12</li>') && !bin.includes('<script') && !/onerror/i.test(bin));
check('variável não enviada sai em branco', !bin.includes('nao_enviada') && !bin.includes('{{'));
check('contratante vira cliente com perfil', psql("select client_kinds::text || status from company_1.customers where phone='553299991111'").includes('hirer'));
check('token inválido não abre', (await fetch(BASE + '/d/1-' + '0'.repeat(48) + '.pdf')).status === 404);
check('token de outra empresa não abre', (await fetch(BASE + '/d/2-' + g.body.url.slice(-52, -4).slice(2) + '.pdf')).status === 404);
check('lista os documentos gerados', (await call('GET', '/api/documents', { token: A.token })).body.length === 1);
check('empresa 2 não enxerga os documentos da 1', (await call('GET', '/api/documents', { token: B.token })).body.length === 0);
check('telefone inválido recusado', (await call('POST', '/api/documents/generate', { token: A.token, body: { template: 'contrato', name: 'X', number: '12' } })).status === 400);
check('tipo sem modelo padrão dá 404', (await call('POST', '/api/documents/generate', { token: A.token, body: { template: 'proposta', name: 'X' } })).status === 404);
const ex = await call('POST', '/api/documents/templates/examples', { token: A.token });
check('modelos de exemplo entram', ex.status === 200 && ex.body.added >= 2);
check('exemplo não duplica', (await call('POST', '/api/documents/templates/examples', { token: A.token })).body.added === 0);
const ing = await call('POST', '/api/documents/generate', { token: A.token, body: { template: 'ingresso', name: 'Maria', number: '32988880000', text: '2 mesas<br>Setor A' } });
check('gera o ingresso do exemplo', ing.status === 201 && psql("select client_kinds::text from company_1.customers where phone='553288880000'").includes('buyer'));
const id = (await call('GET', '/api/documents', { token: A.token })).body[0].id;
check('apaga o documento', (await call('DELETE', `/api/documents/${id}`, { token: A.token })).status === 200);

psql('delete from company_1.doc_files; delete from company_1.doc_templates; delete from company_1.doc_settings');
console.log(`documentos: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
