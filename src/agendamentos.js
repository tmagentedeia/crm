// Agendamentos do atendente e do assistente pessoal: lista, edição e cancelamento das mensagens que ainda vão sair.
// Os agendamentos ficam na tabela agendamentos_mensagens, no Postgres do N8N (o mesmo que o painel já usa para as conversas).
// Cada empresa só enxerga e altera as linhas da PRÓPRIA instância do WhatsApp (companies.whatsapp_instance), e só as pendentes.
// Entram na lista: mensagens agendadas pelo assistente (origem vazia) e lembretes pedidos por clientes (origem 'lembrete_cliente').
// Avisos do próprio painel (delivery, indicações) têm outra origem e nunca aparecem nem são alterados por aqui.
// Cancelar não apaga a linha: marca como 'cancelado' (o agendador do N8N só envia o que está 'pendente').
import { qg } from './db.js';
import { poolDaEmpresa } from './conversas.js';
import { podeVerTelefone } from './funcoes.js';
import { normPhone } from './phone.js';

const TEXTO_MAX = 4000;
const ORIGENS = "(origem IS NULL OR origem = 'lembrete_cliente')";
const MOMENTO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// Banco + instância da empresa. Responde o erro sozinho e devolve null quando a ligação não existe.
async function ligacao(req, res) {
  const c = (await qg('SELECT whatsapp_instance, conv_db_url, timezone, admin_phone FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
  const pool = c ? poolDaEmpresa(c) : null;
  if (!pool) { res.status(503).json({ error: 'A lista de agendamentos ainda não está disponível. Fale com o suporte.' }); return null; }
  if (!c.whatsapp_instance) { res.status(409).json({ error: 'Os agendamentos ainda não foram ligados ao atendimento desta empresa. Fale com o suporte.' }); return null; }
  return { pool, instancia: c.whatsapp_instance, tz: c.timezone || 'America/Sao_Paulo', adm: normPhone(c.admin_phone || '') };
}

const idsDe = (b) => (Array.isArray(b?.ids) ? [...new Set(b.ids.map(String).filter((x) => /^\d+$/.test(x)))].slice(0, 2000) : []);
const falhou = (res, e) => {
  console.error('agendamentos:', e.message);
  res.status(503).json({ error: 'Não foi possível falar com a lista de agendamentos agora. Tente de novo em instantes.' });
};

export function registerAgendamentosRoutes(r, wrap) {
  r.get('/scheduled-messages', wrap(async (req, res) => {
    const l = await ligacao(req, res); if (!l) return;
    const ver = await podeVerTelefone(req.user);
    try {
      const { rows } = await l.pool.query(
        `SELECT id::text AS id, telefone, nome, mensagem, data_hora_envio, origem
         FROM agendamentos_mensagens
         WHERE status = 'pendente' AND instancia = $1 AND ${ORIGENS}
         ORDER BY data_hora_envio ASC, id ASC LIMIT 600`, [l.instancia]);
      res.json({
        tz: l.tz, max: TEXTO_MAX,
        items: rows.map((x) => ({
          id: x.id,
          tipo: x.origem === 'lembrete_cliente' ? 'cliente' : (l.adm && normPhone(x.telefone) === l.adm ? 'pessoal' : 'contato'),
          nome: x.nome || null,
          phone: ver ? x.telefone : null,
          text: x.mensagem,
          send_at: x.data_hora_envio,
        })),
      });
    } catch (e) { falhou(res, e); }
  }));

  // Muda a data/hora e/ou o texto de um agendamento que ainda não saiu. send_at = "aaaa-mm-ddThh:mm" no horário da empresa.
  r.put('/scheduled-messages/:id', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Agendamento inválido' });
    const temData = req.body?.send_at !== undefined, temTexto = req.body?.text !== undefined;
    if (!temData && !temTexto) return res.status(400).json({ error: 'Nada para alterar' });
    const data = temData ? String(req.body.send_at) : null;
    const texto = temTexto ? String(req.body.text).trim() : null;
    if (temData && !MOMENTO.test(data)) return res.status(400).json({ error: 'Data e hora inválidas' });
    if (temTexto && !texto) return res.status(400).json({ error: 'A mensagem não pode ficar vazia' });
    if (temTexto && texto.length > TEXTO_MAX) return res.status(400).json({ error: `A mensagem é grande demais (até ${TEXTO_MAX} letras)` });
    const l = await ligacao(req, res); if (!l) return;
    try {
      if (temData) {
        const ok = (await l.pool.query('SELECT ($1::timestamp AT TIME ZONE $2) > now() AS futuro', [data, l.tz])).rows[0]?.futuro;
        if (!ok) return res.status(400).json({ error: 'Escolha uma data e hora que ainda não passaram' });
      }
      const { rows } = await l.pool.query(
        `UPDATE agendamentos_mensagens
         SET data_hora_envio = CASE WHEN $3::text IS NULL THEN data_hora_envio ELSE $3::timestamp AT TIME ZONE $4 END,
             mensagem = COALESCE($5, mensagem)
         WHERE id = $1::bigint AND status = 'pendente' AND instancia = $2 AND ${ORIGENS}
         RETURNING id::text AS id, data_hora_envio, mensagem`,
        [req.params.id, l.instancia, data, l.tz, texto]);
      if (!rows[0]) return res.status(409).json({ error: 'Este agendamento já foi enviado ou cancelado' });
      res.json({ ok: true, send_at: rows[0].data_hora_envio, text: rows[0].mensagem });
    } catch (e) { falhou(res, e); }
  }));

  r.post('/scheduled-messages/bulk-cancel', wrap(async (req, res) => {
    const ids = idsDe(req.body);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    const l = await ligacao(req, res); if (!l) return;
    try {
      const { rows } = await l.pool.query(
        `UPDATE agendamentos_mensagens SET status = 'cancelado'
         WHERE id = ANY($1::bigint[]) AND status = 'pendente' AND instancia = $2 AND ${ORIGENS}
         RETURNING id::text AS id`, [ids, l.instancia]);
      res.json({ cancelled: rows.length, ids: rows.map((x) => x.id) });
    } catch (e) { falhou(res, e); }
  }));

  r.post('/scheduled-messages/:id/cancel', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Agendamento inválido' });
    const l = await ligacao(req, res); if (!l) return;
    try {
      const { rowCount } = await l.pool.query(
        `UPDATE agendamentos_mensagens SET status = 'cancelado'
         WHERE id = $1::bigint AND status = 'pendente' AND instancia = $2 AND ${ORIGENS}`, [req.params.id, l.instancia]);
      if (!rowCount) return res.status(409).json({ error: 'Este agendamento já foi enviado ou cancelado' });
      res.json({ ok: true });
    } catch (e) { falhou(res, e); }
  }));
}
