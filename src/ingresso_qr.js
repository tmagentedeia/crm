// QR Code do ingresso: cada pessoa da lista do evento (venda + posição) tem um código próprio e assinado.
// Quem lê o QR na portaria dá baixa na entrada daquela pessoa. O código não revela nada além de "empresa-venda-posição";
// a assinatura impede inventar ingressos.
import crypto from 'crypto';
import QRCode from 'qrcode';
import { q, qg, currentCompany } from './db.js';

const segredo = () => process.env.QR_SECRET || process.env.JWT_SECRET || 'dev-qr';
const assina = (c, s, n) => crypto.createHmac('sha256', segredo()).update(`ingresso:${c}:${s}:${n}`).digest('hex').slice(0, 12);

export const codigoIngresso = (company, sale, seq) => `TMI-${company}-${sale}-${seq}-${assina(company, sale, seq)}`;

export function lerCodigo(texto) {
  const m = String(texto ?? '').trim().match(/^TMI-(\d+)-(\d+)-(\d+)-([0-9a-f]{12})$/);
  if (!m) return null;
  const esperado = Buffer.from(assina(m[1], m[2], m[3])), veio = Buffer.from(m[4]);
  if (esperado.length !== veio.length || !crypto.timingSafeEqual(esperado, veio)) return null;
  return { company: Number(m[1]), sale: m[2], seq: Number(m[3]) };
}

export async function qrHtml(codigo, lado = 180) {
  const svg = await QRCode.toString(codigo, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return `<img alt="QR Code do ingresso" width="${lado}" height="${lado}" style="width:${lado}px;height:${lado}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
}

const OCUPAM = ['confirmed', 'attended'];
const dataBr = (d, tz) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '');

// Variáveis do ingresso de uma pessoa. Devolve { erro: [status, mensagem] } se a venda não existir ou estiver cancelada.
export async function variaveisDoIngresso(saleId, seq) {
  if (!/^\d+$/.test(String(saleId ?? ''))) return { erro: [400, 'Venda inválida'] };
  const n = Number(seq ?? 1);
  const s = (await q(
    `SELECT s.id, s.name, s.people, s.guests, s.status, s.table_name, s.tables, s.host_sale_id, sec.name AS sector,
            (SELECT h.name FROM shows_sales h WHERE h.id = s.host_sale_id) AS host_name,
            e.title, e.starts_at, e.doors_at, e.place
     FROM shows_sales s JOIN shows_sectors sec ON sec.id = s.sector_id LEFT JOIN events e ON e.id = s.event_id WHERE s.id = $1`, [saleId])).rows[0];
  if (!s) return { erro: [404, 'Venda não encontrada'] };
  if (!Number.isInteger(n) || n < 1 || n > s.people) return { erro: [404, 'Pessoa não encontrada nessa venda'] };
  if (!OCUPAM.includes(s.status)) return { erro: [409, 'Essa venda está cancelada'] };
  const a = (await q('SELECT name FROM shows_attendees WHERE sale_id=$1 AND seq=$2', [s.id, n])).rows[0] || {};
  const nomes = String(s.guests || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const nome = a.name || nomes[n - 1] || (n === 1 ? s.name : `Acompanhante de ${s.name}`);
  const tz = (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';
  const codigo = codigoIngresso(currentCompany(), s.id, n);
  return {
    nome,
    vars: {
      qrcode: await qrHtml(codigo), codigo, evento: s.title || '', evento_data: dataBr(s.starts_at, tz), abertura: dataBr(s.doors_at, tz), local: s.place || '',
      setor: s.sector, mesa: s.host_sale_id ? `Mesa de ${s.host_name}` : `${s.tables} × ${s.table_name}`, pessoa: `${n} de ${s.people}`,
    },
  };
}
