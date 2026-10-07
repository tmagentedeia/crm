// Atendimentos = pessoas diferentes que conversaram com o agente de IA no período.
// O histórico das conversas fica numa tabela do banco do N8N (uma por agente); a empresa aponta qual é (companies.chat_table)
// e a instância do WhatsApp (companies.whatsapp_instance) separa as conversas quando a tabela é compartilhada.
import { msgPool } from './indicacoes.js';
import { decifrar } from './segredo.js';

const NOME_OK = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const nomeTabelaValido = (t) => NOME_OK.test(String(t || ''));
const COLUNAS_DATA = ['created_at', 'data_hora', 'timestamp', 'criado_em', 'data', 'createdat'];

// Banco das conversas da empresa: o dela, se cadastrado (guardado cifrado); senão o do servidor.
// Se o endereço dela existe mas não abre (chave do servidor trocada), devolve null: nunca cai no banco de outra empresa.
export function poolDaEmpresa(c) {
  if (c?.conv_db_url) { const u = decifrar(c.conv_db_url); return u ? msgPool(u) : null; }
  return msgPool();
}

// Descobre onde e como ler as conversas da empresa.
// Devolve { pool, tabela, dt, soCliente, instancia }, { vazio: true } (empresa sem conversas ligadas) ou { motivo }.
async function lerEstrutura(empresa) {
  const { chat_table: tabela, whatsapp_instance: instancia } = empresa;
  if (!tabela || !nomeTabelaValido(tabela)) return { vazio: true };
  const pool = poolDaEmpresa(empresa);
  if (!pool) return { vazio: true };
  const cols = (await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = ANY(current_schemas(false))`, [tabela])).rows;
  if (!cols.length) return { motivo: 'tabela' };
  const dt = cols.find((c) => COLUNAS_DATA.includes(c.column_name.toLowerCase()) && /^timestamp/.test(c.data_type));
  if (!dt) return { motivo: 'sem_data' };
  const msg = cols.find((c) => c.column_name === 'message');
  const soCliente = msg && /json/.test(msg.data_type) ? `AND message->>'type' = 'human'` : '';
  return { pool, tabela, dt, soCliente, instancia };
}

// Devolve { total } , { total: null, motivo } ou null (empresa sem conversas ligadas)
export async function contarConversas(empresa, dias) {
  try {
    const e = await lerEstrutura(empresa);
    if (e.vazio) return null;
    if (e.motivo) return { total: null, motivo: e.motivo };
    const args = [dias];
    let filtroInstancia = '';
    if (e.instancia) { args.push(String(e.instancia).replace(/[\\%_]/g, '\\$&') + ' %'); filtroInstancia = `AND session_id LIKE $2`; }
    const { rows } = await e.pool.query(
      `SELECT COUNT(DISTINCT session_id)::int AS total FROM "${e.tabela}"
       WHERE "${e.dt.column_name}" >= now() - make_interval(days => $1) ${filtroInstancia} ${e.soCliente}`, args);
    return { total: rows[0].total };
  } catch (err) {
    console.error('conversas:', err.message);
    return { total: null, motivo: 'erro' };
  }
}

// Pessoas diferentes que conversaram em cada dia da semana (0 = domingo), no horário de Brasília.
// Devolve { dias: [{ weekday, total }] }, { total: null, motivo } ou null (empresa sem conversas ligadas)
export async function conversasPorDiaSemana(empresa, dias) {
  try {
    const e = await lerEstrutura(empresa);
    if (e.vazio) return null;
    if (e.motivo) return { total: null, motivo: e.motivo };
    const col = `"${e.dt.column_name}"`;
    // coluna sem fuso guarda a hora do relógio do banco (como o now() grava); com fuso já é um instante exato
    const local = e.dt.data_type === 'timestamp with time zone'
      ? `${col} AT TIME ZONE 'America/Sao_Paulo'`
      : `(${col} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'America/Sao_Paulo'`;
    const args = [dias];
    let filtroInstancia = '';
    if (e.instancia) { args.push(String(e.instancia).replace(/[\\%_]/g, '\\$&') + ' %'); filtroInstancia = `AND session_id LIKE $2`; }
    const { rows } = await e.pool.query(
      `SELECT EXTRACT(DOW FROM ${local})::int AS weekday, COUNT(DISTINCT session_id)::int AS total FROM "${e.tabela}"
       WHERE ${col} >= now() - make_interval(days => $1) ${filtroInstancia} ${e.soCliente}
       GROUP BY 1 ORDER BY 1`, args);
    return { dias: rows };
  } catch (err) {
    console.error('conversas:', err.message);
    return { total: null, motivo: 'erro' };
  }
}
