// Vagas de documento: quantos tipos a empresa usa ao mesmo tempo. Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/documentos_vagas.mjs (precisa do Gotenberg de mentira)
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
const idB = B.company.id;
const adm = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const cli = (m, p, body) => call(m, '/api' + p, { token: B.token, body });
psql(`delete from company_${idB}.doc_files; delete from company_${idB}.doc_templates; delete from company_${idB}.doc_settings`);
psql('delete from company_1.doc_files; delete from company_1.doc_templates; delete from company_1.doc_settings');

check('vagas inválidas recusadas', (await adm('PUT', `/admin/companies/${idB}`, { doc_slots: 9 })).status === 400);
check('empresa comum não mexe nas vagas', (await cli('PUT', `/admin/companies/${idB}`, { doc_slots: 3 })).status === 403);
check('admin define 1 vaga', (await adm('PUT', `/admin/companies/${idB}`, { doc_slots: 1 })).body.doc_slots === 1);
check('a lista de empresas mostra as vagas', (await adm('GET', '/admin/companies')).body.find((c) => c.id === idB).doc_slots === 1);

let v = (await cli('GET', '/documents/slots')).body;
check('começa sem tipo em uso', v.total === 1 && v.ativos.length === 0 && v.livres === 1, JSON.stringify(v));
const corpo = { blocos: [{ tipo: 'titulo', texto: 'Oi {{nome}}' }] };
const ing = await cli('POST', '/documents/templates', { name: 'Meu ingresso', kind: 'ingresso', blocks: corpo });
check('empresa comum cria modelo e ocupa a vaga', ing.status === 201, JSON.stringify(ing.body));
v = (await cli('GET', '/documents/slots')).body;
check('ingresso ocupa a vaga', v.ativos.join() === 'ingresso' && v.livres === 0);
const con = await cli('POST', '/documents/templates', { name: 'Meu contrato', kind: 'contrato', blocks: corpo });
check('segundo tipo é recusado com mensagem clara', con.status === 403 && /1 tipo de documento/.test(con.body.error) && /pare de usar/.test(con.body.error), JSON.stringify(con.body));
check('editar o tipo que ocupa a vaga continua livre', (await cli('PUT', `/documents/templates/${ing.body.id}`, { name: 'Ingresso novo', blocks: corpo })).status === 200);
check('mudar o modelo para outro tipo sem vaga é recusado', (await cli('PUT', `/documents/templates/${ing.body.id}`, { kind: 'contrato' })).status === 403);

// modelo de outro tipo já existente (criado pelo administrador) aparece como sem vaga
psql(`insert into company_${idB}.doc_templates (kind, name, html, is_default) values ('contrato','Contrato da M2','<p>{{nome}}</p>',true)`);
const lst = (await cli('GET', '/documents/templates')).body;
check('lista marca o tipo sem vaga', lst.find((t) => t.kind === 'contrato').sem_vaga === true && lst.find((t) => t.kind === 'ingresso').sem_vaga === false, JSON.stringify(lst));

const gerar = (template) => cli('POST', '/documents/generate', { template, name: 'Joana' });
check('gera o tipo que tem vaga', (await gerar('ingresso')).status === 201);
const g2 = await gerar('contrato');
check('gerar tipo sem vaga é recusado', g2.status === 403 && /pare de usar/.test(g2.body.error), JSON.stringify(g2.body));

check('tipo inválido na liberação', (await cli('POST', '/documents/slots/release', { kind: 'x' })).status === 400);
v = (await cli('POST', '/documents/slots/release', { kind: 'ingresso' })).body;
check('parar de usar um tipo libera o lugar', v.ativos.length === 0 && v.livres === 1);
check('modelo do tipo liberado continua guardado', (await cli('GET', `/documents/templates/${ing.body.id}`)).status === 200);
check('agora o contrato ocupa a vaga', (await gerar('contrato')).status === 201 && (await cli('GET', '/documents/slots')).body.ativos.join() === 'contrato');
check('e o ingresso fica sem vaga', (await gerar('ingresso')).status === 403);

check('com vagas vazias (sem limite) tudo é liberado', (await adm('PUT', `/admin/companies/${idB}`, { doc_slots: null })).body.doc_slots === null && (await gerar('ingresso')).status === 201);
check('sem limite não informa total', (await cli('GET', '/documents/slots')).body.total === null);

// administrador da plataforma não é barrado nem ocupa vaga
await adm('PUT', '/admin/companies/1', { doc_slots: 0 });
const ga = await adm('POST', '/documents/templates', { name: 'Admin', kind: 'proposta', blocks: corpo });
check('administrador cria modelo mesmo com 0 vagas', ga.status === 201);
check('administrador não ocupa vaga', (await adm('GET', '/documents/slots')).body.ativos.length === 0);
await adm('PUT', '/admin/companies/1', { doc_slots: null });

check('teste do serviço de PDF continua só do administrador', (await cli('GET', '/documents/health')).status === 403);
// documentos adicionais somam ao plano
check('empresa comum não mexe nos adicionais', (await cli('PUT', `/admin/companies/${idB}`, { doc_extras: 2 })).status === 403);
check('adicionais inválidos recusados', (await adm('PUT', `/admin/companies/${idB}`, { doc_extras: -1 })).status === 400);
await adm('PUT', `/admin/companies/${idB}`, { doc_slots: 1, doc_extras: 0 });
psql(`update company_${idB}.doc_settings set active_kinds='{}'`);
await gerar('ingresso');
check('com 1 tipo o contrato é recusado', (await gerar('contrato')).status === 403);
await adm('PUT', `/admin/companies/${idB}`, { doc_extras: 1 });
check('um tipo adicional libera o segundo', (await gerar('contrato')).status === 201 && (await cli('GET', '/documents/slots')).body.total === 2);

// nível: documento simples tem limite de texto; completo não
await adm('PUT', `/admin/companies/${idB}`, { doc_nivel: 'simples' });
const longo = { blocos: [{ tipo: 'texto', texto: 'palavra '.repeat(300) }] };
const curto = { blocos: [{ tipo: 'texto', texto: 'Recibo de {{nome}}, valor {{valor}}.' }] };
const rl = await cli('PUT', `/documents/templates/${ing.body.id}`, { blocks: longo });
check('texto longo recusado no plano simples', rl.status === 403 && /1\.500 caracteres/.test(rl.body.error), JSON.stringify(rl.body));
check('texto curto aceito no plano simples', (await cli('PUT', `/documents/templates/${ing.body.id}`, { blocks: curto })).status === 200);
check('o painel informa o limite', (await cli('GET', '/documents/slots')).body.limite_texto === 1500);
const pvl = await cli('POST', '/documents/preview', { blocks: longo });
check('a prévia informa quantos caracteres tem o texto', pvl.body.chars === 'palavra '.repeat(300).trim().length, JSON.stringify(pvl.body.chars));
check('variáveis não contam como texto', (await cli('POST', '/documents/preview', { blocks: { blocos: [{ tipo: 'texto', texto: '{{nome}}{{{text}}}' }] } })).body.chars === 0);
await adm('PUT', `/admin/companies/${idB}`, { doc_nivel: 'completo' });
check('plano completo aceita texto longo', (await cli('PUT', `/documents/templates/${ing.body.id}`, { blocks: longo })).status === 200);
check('editar é livre: quantas vezes quiser no mês', (await cli('PUT', `/documents/templates/${ing.body.id}`, { blocks: curto })).status === 200 && (await cli('PUT', `/documents/templates/${ing.body.id}`, { blocks: longo })).status === 200);
check('nível inválido recusado', (await adm('PUT', `/admin/companies/${idB}`, { doc_nivel: 'enorme' })).status === 400);

// aplicar plano define tipos e nível, sem apagar os adicionais
await adm('PUT', `/admin/companies/${idB}`, { doc_extras: 1 });
await adm('PUT', `/admin/companies/${idB}/plan`, { plan: 'pro' });
let c = (await adm('GET', '/admin/companies')).body.find((x) => x.id === idB);
check('plano Pro: 1 tipo, nível simples, documentos ligados, adicionais mantidos', c.doc_slots === 1 && c.doc_nivel === 'simples' && c.doc_extras === 1 && c.modules.documentos === true, JSON.stringify(c));
await adm('PUT', `/admin/companies/${idB}/plan`, { plan: 'advanced' });
c = (await adm('GET', '/admin/companies')).body.find((x) => x.id === idB);
check('plano Advanced: 2 tipos, nível completo', c.doc_slots === 2 && c.doc_nivel === 'completo' && c.modules.documentos === true);
await adm('PUT', `/admin/companies/${idB}/plan`, { plan: 'starter' });
c = (await adm('GET', '/admin/companies')).body.find((x) => x.id === idB);
check('plano Starter: sem documentos', c.doc_slots === 0 && c.modules.documentos === false && c.locked_modules.documentos === true, JSON.stringify(c.locked_modules));
check('Starter com tipo adicional ainda usa o adicional', (await cli('GET', '/documents/slots')).body.total === 1);
await adm('PUT', `/admin/companies/${idB}`, { doc_slots: null, doc_extras: 0, doc_nivel: '' });

console.log(`documentos_vagas: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
