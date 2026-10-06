// Planilha vinculada da empresa (Google Sheets) como origem dos contatos.
// O endereço é cadastrado na Administração. A planilha precisa estar com "qualquer pessoa com o link pode ver".
// O painel baixa a planilha como CSV e a tela de importação usa as linhas (Conferir → Importar), com as colunas da planilha
// como referência: as que o painel já conhece entram nos campos dele e as outras viram campos personalizados do contato.
import { qg } from './db.js';

// Campos personalizados: valores das colunas extras da planilha, por contato ({ "Instrumento": "Violão" }).
export const CAMPOS_EXTRA_SQL = `ALTER TABLE customers ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;`;

// Aceita o endereço da planilha como aparece no navegador e devolve o de exportação em CSV (ou null).
export function enderecoCsv(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
    const m = u.pathname.match(/^\/spreadsheets\/d\/(e\/)?([\w-]+)/);
    if (!m) return null;
    if (m[1]) return `https://docs.google.com/spreadsheets/d/e/${m[2]}/pub?output=csv${u.searchParams.get('gid') ? `&gid=${encodeURIComponent(u.searchParams.get('gid'))}` : ''}`;
    const gid = u.searchParams.get('gid') || u.hash.match(/gid=(\d+)/)?.[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${m[2]}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  } catch { return null; }
}

export async function baixarPlanilha(url) {
  const alvo = enderecoCsv(url);
  if (!alvo) throw Object.assign(new Error('O endereço da planilha não é válido.'), { status: 400 });
  let r;
  try { r = await fetch(alvo, { redirect: 'follow', signal: AbortSignal.timeout(20000) }); }
  catch { throw Object.assign(new Error('Não consegui abrir a planilha agora. Tente de novo em instantes.'), { status: 502 }); }
  const tipo = r.headers.get('content-type') || '';
  const texto = await r.text();
  if (!r.ok || !/csv|text\/plain/i.test(tipo) || /^\s*<(!doctype|html)/i.test(texto)) {
    throw Object.assign(new Error('Não consegui ler a planilha. Confira se ela está compartilhada como "qualquer pessoa com o link pode ver".'), { status: 400 });
  }
  if (texto.length > 8_000_000) throw Object.assign(new Error('A planilha é grande demais para importar de uma vez.'), { status: 400 });
  return texto;
}

export function registerPlanilhaAdmin(app, requireUser, requireAdmin) {
  app.put('/api/admin/companies/:id/contact-sheet', requireUser, requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
      const url = String(req.body?.url ?? '').trim();
      if (url && !enderecoCsv(url)) return res.status(400).json({ error: 'Endereço inválido. Cole o endereço da planilha do Google (docs.google.com/spreadsheets/…).' });
      const { rowCount } = await qg("UPDATE companies SET contact_sheet_url=NULLIF($2,'') WHERE id=$1", [id, url]);
      if (!rowCount) return res.status(404).json({ error: 'Empresa não encontrada' });
      res.json({ ok: true, url });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
  });
}

export async function planilhaDaEmpresa(companyId) {
  return (await qg('SELECT contact_sheet_url FROM companies WHERE id=$1', [companyId])).rows[0]?.contact_sheet_url || null;
}
