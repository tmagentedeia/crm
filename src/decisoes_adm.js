// Decisões que dependem do responsável (administrador) e chegam a ele pelo WhatsApp: comprovante em análise, pedido de cancelamento...
// Cada módulo registra o seu tipo; a resposta "sim"/"não" do responsável é entregue aqui, a um só lugar.
import { qg, currentCompany } from './db.js';
import { normPhone } from './phone.js';
import { conexaoWhats, postarWhats } from './lista_evento.js';

// tipo -> { pendentes(): [{ ref, quando, resumo, client_phone, client_name }], decidir(ref, aprova): { ok, message, decision, ... } }
export const provedores = new Map();

// Manda uma mensagem ao celular do administrador da empresa (nunca ao número da empresa, que é o da própria atendente).
export async function avisarAdm(texto) {
  const cid = currentCompany();
  const c = (await qg('SELECT admin_phone FROM companies WHERE id=$1', [cid])).rows[0];
  const dest = normPhone(c?.admin_phone);
  const con = await conexaoWhats(cid);
  if (!dest || !con) return false;
  await postarWhats(con, '/send/text', { number: dest, text: texto });
  return true;
}

const SIM = ['sim', 's', 'aprovo', 'aprovar', 'aprovado', 'confirmado', 'confirmada', 'confirmo', 'liberado', 'liberar', 'pode liberar', 'libera', 'cancela', 'cancelar', 'pode cancelar'];
const NAO = ['nao', 'n', 'recuso', 'recusar', 'recusado', 'negado', 'nao libera', 'nao liberar', 'nao cancela', 'nao cancelar', 'manter', 'mantem'];

// Devolve { handled:false } se a mensagem não é resposta a um aviso pendente.
export async function responderAviso(texto) {
  const t0 = String(texto ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9# ]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = t0.match(new RegExp('^(' + [...SIM, ...NAO].join('|') + ')(?: #?(c?\\d{1,12}))?$'));
  if (!m) return { handled: false };
  const aprova = SIM.includes(m[1]);
  const pend = [];
  for (const [tipo, p] of provedores) for (const x of await p.pendentes()) pend.push({ ...x, tipo });
  pend.sort((a, b) => new Date(b.quando) - new Date(a.quando));
  if (!pend.length) return { handled: false };
  let alvo;
  if (m[2]) {
    alvo = pend.find((x) => String(x.ref).toLowerCase() === m[2]);
    if (!alvo) return { handled: true, ok: false, message: `Não achei o aviso #${m[2].toUpperCase()} aguardando decisão.` };
  } else if (pend.length === 1) alvo = pend[0];
  else return { handled: true, ok: false, message: `Há ${pend.length} avisos aguardando. Responda com o número, por exemplo "${aprova ? 'sim' : 'não'} #${pend[0].ref}". Pendentes: ${pend.map((x) => `#${x.ref} ${x.resumo}`).join('; ')}.` };
  const out = await provedores.get(alvo.tipo).decidir(alvo.ref, aprova);
  return { handled: true, kind: alvo.tipo, client_phone: alvo.client_phone || null, client_name: alvo.client_name || null, ...out };
}
