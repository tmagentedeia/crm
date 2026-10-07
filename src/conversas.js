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

// Devolve { total } , { total: null, motivo } ou null (empresa sem conversas ligadas)
export async function contarConversas(empresa, dias) {
  const { chat_table: tabela, whatsapp_instance: instancia } = empresa;
  if (!tabela || !nomeTabelaValido(tabela)) return null;
  const pool = poolDaEmpresa(empresa);
  if (!pool) return null;
  try {
    const cols = (await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = ANY(current_schemas(false))`, [tabela])).rows;
    if (!cols.length) return { total: null, motivo: 'tabela' };
    const dt = cols.find((c) => COLUNAS_DATA.includes(c.column_name.toLowerCase()) && /^timestamp/.test(c.data_type));
    if (!dt) return { total: null, motivo: 'sem_data' };
    const msg = cols.find((c) => c.column_name === 'message');
    const soCliente = msg && /json/.test(msg.data_type) ? `AND message->>'type' = 'human'` : '';
    const args = [dias];
    let filtroInstancia = '';
    if (instancia) { args.push(String(instancia).replace(/[\\%_]/g, '\\$&') + ' %'); filtroInstancia = `AND session_id LIKE $2`; }
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT session_id)::int AS total FROM "${tabela}"
       WHERE "${dt.column_name}" >= now() - make_interval(days => $1) ${filtroInstancia} ${soCliente}`, args);
    return { total: rows[0].total };
  } catch (e) {
    console.error('conversas:', e.message);
    return { total: null, motivo: 'erro' };
  }
}
