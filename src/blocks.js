// Contatos bloqueados: o painel enxerga e altera os mesmos bloqueios que o atendente usa.
// Cada bloqueio é uma chave no Redis da plataforma (REDIS_URL), no formato
//   <prefixo da empresa>ia_forced:<instância>:<número>    bloqueio geral (comando "off", loop, bloqueio manual)
//   <prefixo da empresa>ia_blocked:<instância>:<número>   pausa (o responsável assumiu a conversa)
// A validade da chave diz se é temporário ou para sempre. A empresa só enxerga chaves do próprio prefixo + instância.
import Redis from 'ioredis';

const DIA = 86400;
export const PERMANENTE_ACIMA_DE = 30 * DIA;   // validade maior que 30 dias = para sempre
export const TEMPORARIO = DIA;                 // bloqueio manual "por 24 horas"
export const PARA_SEMPRE = 315360000;          // 10 anos, igual ao comando "off" do atendente

let client = null;
export const redisDisponivel = () => !!process.env.REDIS_URL;
function redis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: 5000 });
    client.on('error', (e) => console.error('Redis:', e.message));
  }
  return client;
}
export async function fechaRedis() { if (client) { await client.quit().catch(() => {}); client = null; } }

// instância e prefixo só aceitam caracteres comuns: nada de curingas nem espaços
export const nomeValido = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(s);
export const prefixoValido = (s) => s === '' || nomeValido(s);

// WhatsApp/UAZAPI entrega o número como 55 + DDD + 8 dígitos (sem o 9 extra do celular)
export function numeroDoContato(entrada) {
  const d = String(entrada || '').replace(/\D/g, '');
  if (d.length === 11 && d[2] === '9') return '55' + d.slice(0, 2) + d.slice(3);
  if (d.length === 10 || d.length === 11) return '55' + d.slice(0, 2) + d.slice(-8);
  if (d.length === 12 || d.length === 13) return d.length === 13 && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d;
  return null;
}

const chave = (cfg, tipo, id) => `${cfg.prefixo}ia_${tipo}:${cfg.instancia}:${id}`;

// Lê as chaves da empresa e junta pelo contato.
export async function listar(cfg) {
  const r = redis();
  if (!r) throw Object.assign(new Error('indisponivel'), { code: 'SEM_REDIS' });
  const out = new Map();
  for (const tipo of ['forced', 'blocked']) {
    const padrao = `${cfg.prefixo}ia_${tipo}:${cfg.instancia}:*`;
    const base = `${cfg.prefixo}ia_${tipo}:${cfg.instancia}:`;
    let cursor = '0';
    const chaves = [];
    do {
      const [next, ks] = await r.scan(cursor, 'MATCH', padrao, 'COUNT', 1000);
      cursor = next; chaves.push(...ks);
    } while (cursor !== '0');
    if (!chaves.length) continue;
    const p = r.multi();
    for (const k of chaves) { p.ttl(k); p.get(k); }
    const res = await p.exec();
    chaves.forEach((k, i) => {
      const ttl = res[i * 2][1], valor = res[i * 2 + 1][1];
      if (ttl === -2 || valor === null) return; // sumiu no meio do caminho
      const id = k.slice(base.length);
      const item = out.get(id) || { id, geral: null, pausa: null };
      const info = { segundos: ttl === -1 ? null : ttl, valor };
      if (tipo === 'forced') item.geral = info; else item.pausa = info;
      out.set(id, item);
    });
  }
  return [...out.values()].map((i) => {
    // vale o bloqueio que dura mais; sem validade (-1) conta como para sempre
    const dura = (x) => (x ? (x.segundos === null ? Infinity : x.segundos) : -1);
    const principal = dura(i.geral) >= dura(i.pausa) ? i.geral : i.pausa;
    const permanente = principal.segundos === null || principal.segundos > PERMANENTE_ACIMA_DE;
    // motivo: bloqueio geral com valor "1" = comando ou bloqueio manual; outro valor = bloqueio automático por repetição
    const motivo = principal === i.pausa && i.pausa && principal !== i.geral ? 'pausa'
      : principal.valor === '1' ? 'manual' : 'automatico';
    return { id: i.id, permanente, segundos: permanente ? null : principal.segundos, motivo };
  }).sort((a, b) => Number(b.permanente) - Number(a.permanente) || (b.segundos ?? 0) - (a.segundos ?? 0) || a.id.localeCompare(b.id));
}

export async function bloquear(cfg, id, duracao) {
  const r = redis();
  if (!r) throw Object.assign(new Error('indisponivel'), { code: 'SEM_REDIS' });
  await r.set(chave(cfg, 'forced', id), '1', 'EX', duracao === 'sempre' ? PARA_SEMPRE : TEMPORARIO);
}

// Libera de verdade: apaga o bloqueio geral e a pausa do contato.
export async function liberar(cfg, id) {
  const r = redis();
  if (!r) throw Object.assign(new Error('indisponivel'), { code: 'SEM_REDIS' });
  return r.del(chave(cfg, 'forced', id), chave(cfg, 'blocked', id));
}
