import pg from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import 'dotenv/config';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Cada empresa tem o seu próprio schema (company_<id>) com as tabelas de negócio.
// As tabelas gerais (companies, users) ficam em public.
const als = new AsyncLocalStorage();

export const schemaOf = (id) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Empresa inválida');
  return `company_${n}`;
};

// Roda fn "como" a empresa: todo q() dentro dela (inclusive trabalho em segundo plano) usa o schema dela.
export const runAs = (companyId, fn) => als.run({ companyId: Number(companyId) }, fn);
export const currentCompany = () => als.getStore()?.companyId;

// Consulta nas tabelas da empresa atual (search_path = schema da empresa, depois public).
export async function q(text, params) {
  const id = currentCompany();
  if (!id) throw new Error('q() chamado fora do contexto de uma empresa');
  const cx = await pool.connect();
  try {
    await cx.query(`SET search_path TO ${schemaOf(id)}, public`);
    return await cx.query(text, params);
  } finally {
    await cx.query('RESET search_path').catch(() => {});
    cx.release();
  }
}

// Consulta nas tabelas gerais (public): login, empresas, usuários.
export async function qg(text, params) {
  const cx = await pool.connect();
  try {
    await cx.query('SET search_path TO public');
    return await cx.query(text, params);
  } finally {
    cx.release();
  }
}

// Transação dentro do schema da empresa: fn recebe uma função query presa à mesma conexão.
export async function tx(companyId, fn) {
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    await cx.query(`SET LOCAL search_path TO ${schemaOf(companyId)}, public`);
    const out = await fn((t, p) => cx.query(t, p));
    await cx.query('COMMIT');
    return out;
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
}
