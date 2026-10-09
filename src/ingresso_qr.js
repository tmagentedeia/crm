// QR Code do ingresso: cada pessoa da lista do evento (venda + posição) tem um código próprio e assinado.
// Quem lê o QR na portaria dá baixa na entrada daquela pessoa. O código não revela nada além de "empresa-venda-posição";
// a assinatura impede inventar ingressos.
import crypto from 'crypto';
import QRCode from 'qrcode';
import { q, qg, currentCompany } from './db.js';

const segredo = () => process.env.QR_SECRET || process.env.JWT_SECRET || 'dev-qr';
const assina = (c, s, n, v = 0) => crypto.createHmac('sha256', segredo()).update(v ? `ingresso:${c}:${s}:${n}:v${v}` : `ingresso:${c}:${s}:${n}`).digest('hex').slice(0, 12);

// ver = versão do ingresso daquela pessoa (0 até o primeiro ingresso substituído; o código da versão 0 é o original)
export const codigoIngresso = (company, sale, seq, ver = 0) => (ver ? `TMI-${company}-${sale}-${seq}-v${ver}-${assina(company, sale, seq, ver)}` : `TMI-${company}-${sale}-${seq}-${assina(company, sale, seq)}`);

export function lerCodigo(texto) {
  const m = String(texto ?? '').trim().match(/^TMI-(\d+)-(\d+)-(\d+)(?:-v(\d+))?-([0-9a-f]{12})$/);
  if (!m) return null;
  const ver = m[4] ? Number(m[4]) : 0;
  if (m[4] && ver < 1) return null;
  const esperado = Buffer.from(assina(m[1], m[2], m[3], ver)), veio = Buffer.from(m[5]);
  if (esperado.length !== veio.length || !crypto.timingSafeEqual(esperado, veio)) return null;
  return { company: Number(m[1]), sale: m[2], seq: Number(m[3]), ver };
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
    `SELECT s.id, s.event_id, s.name, s.people, s.removed_seqs, s.guests, s.status, s.table_name, s.tables, s.host_sale_id, sec.name AS sector,
            (SELECT h.name FROM shows_sales h WHERE h.id = s.host_sale_id) AS host_name,
            e.title, e.starts_at, e.doors_at, e.place, s.seats_each,
            (SELECT v.address FROM shows_venues v WHERE v.id = sec.venue_id) AS venue_address,
            (SELECT v.name FROM shows_venues v WHERE v.id = sec.venue_id) AS venue_name
     FROM shows_sales s JOIN shows_sectors sec ON sec.id = s.sector_id LEFT JOIN events e ON e.id = s.event_id WHERE s.id = $1`, [saleId])).rows[0];
  if (!s) return { erro: [404, 'Venda não encontrada'] };
  if (!Number.isInteger(n) || n < 1 || n > s.people + s.removed_seqs.length || s.removed_seqs.includes(n)) return { erro: [404, 'Pessoa não encontrada nessa venda'] };
  if (!OCUPAM.includes(s.status)) return { erro: [409, 'Essa venda está cancelada'] };
  const a = (await q('SELECT name, qr_ver FROM shows_attendees WHERE sale_id=$1 AND seq=$2', [s.id, n])).rows[0] || {};
  const nomes = String(s.guests || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const nome = a.name || nomes[n - 1] || (n === 1 ? s.name : `Acompanhante de ${s.name}`);
  const tz = (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';
  const codigo = codigoIngresso(currentCompany(), s.id, n, a.qr_ver || 0);
  return {
    nome, event_id: s.event_id || null,
    vars: {
      qrcode: await qrHtml(codigo), codigo, evento: s.title || '', evento_data: dataBr(s.starts_at, tz), abertura: dataBr(s.doors_at, tz), local: s.place || s.venue_name || '', endereco: s.venue_address || '', lugares_mesa: String(s.seats_each || ''), comprador: s.host_sale_id ? (s.host_name || s.name) : s.name,
      setor: s.sector, mesa: s.host_sale_id ? `Mesa de ${s.host_name}` : `${s.tables} × ${s.table_name}`, pessoa: `${n} de ${s.people}`,
    },
  };
}
