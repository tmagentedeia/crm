import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import ImportarAqui from '../ImportarAqui.jsx';

const brl = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',');
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const minutosDesde = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const ETAPAS = { new: 'Novo', confirmed: 'Confirmado', preparing: 'Em preparo', ready: 'Pronto', out_for_delivery: 'Saiu para entrega', delivered: 'Entregue', cancelled: 'Cancelado' };
const PAGTO = { pix: 'Pix', cash: 'Dinheiro', card: 'Cartão na entrega' };
const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const hojeISO = () => new Date().toLocaleDateString('en-CA');
const PROXIMA = (o) => ({
  new: { para: 'confirmed', texto: 'Confirmar' },
  confirmed: { para: 'preparing', texto: 'Iniciar preparo' },
  preparing: { para: 'ready', texto: 'Marcar pronto' },
  ready: o.kind === 'pickup' ? { para: 'delivered', texto: 'Retirado' } : { para: 'out_for_delivery', texto: 'Saiu para entrega' },
  out_for_delivery: { para: 'delivered', texto: 'Entregue' },
}[o.status] || null);

// Pequeno aviso sonoro quando chega pedido novo
export function bip() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
    const c = new Ctx(); const o = c.createOscillator(); const g = c.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(c.destination); o.start(); setTimeout(() => { o.stop(); c.close(); }, 250);
  } catch { /* sem áudio */ }
}

export default function Delivery() {
  const [aba, setAba] = useState('pedidos');
  const abas = [['pedidos', 'Pedidos'], ['cardapio', 'Cardápio'], ['entrega', 'Entrega e pagamento'], ['cupons', 'Cupons'], ['entregadores', 'Entregadores'], ['relatorio', 'Relatórios']];
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h1>Delivery</h1>
        <p className="muted">Pedidos de entrega e retirada, cardápio, taxas por bairro, cupons e entregadores. O atendente também lança pedidos por aqui.</p>
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {abas.map(([k, n]) => <button key={k} className={'btn sm' + (aba === k ? ' primary' : '')} onClick={() => setAba(k)}>{n}</button>)}
      </div>
      {aba === 'pedidos' && <Pedidos />}
      {aba === 'cardapio' && <Cardapio />}
      {aba === 'entrega' && <Configuracao />}
      {aba === 'cupons' && <Cupons />}
      {aba === 'entregadores' && <Entregadores />}
      {aba === 'relatorio' && <Relatorio />}
    </>
  );
}

// ================= PEDIDOS =================
function Pedidos() {
  const [lista, setLista] = useState(null);
  const [encerrados, setEncerrados] = useState([]);
  const [loja, setLoja] = useState(null);
  const [aberto, setAberto] = useState(null);       // pedido aberto no detalhe
  const [novo, setNovo] = useState(false);
  const [som, setSom] = useState(() => { try { return localStorage.getItem('dlv_som') !== '0'; } catch { return true; } });
  const [err, setErr] = useState('');
  const [, tic] = useState(0);
  const antes = useRef(null);

  const carregar = useCallback(async () => {
    try {
      const [a, e, s] = await Promise.all([api('/delivery/orders?active=1'), api(`/delivery/orders?status=delivered,cancelled&from=${hojeISO()}&to=${hojeISO()}`), api('/delivery/settings')]);
      const novos = a.filter((o) => o.status === 'new').length;
      if (antes.current !== null && novos > antes.current && som) bip();
      antes.current = novos;
      setLista(a); setEncerrados(e); setLoja(s);
    } catch (e2) { setErr(e2.message); }
  }, [som]);
  useEffect(() => { carregar(); const t = setInterval(carregar, 20000); const r = setInterval(() => tic((x) => x + 1), 30000); return () => { clearInterval(t); clearInterval(r); }; }, [carregar]);

  async function modoLoja(modo) { try { await api('/delivery/settings', { method: 'PUT', body: { open_mode: modo } }); carregar(); } catch (e) { setErr(e.message); } }
  async function avancar(o, para) {
    setErr('');
    if (para === 'out_for_delivery') { setAberto(o); return; }       // precisa escolher o entregador
    try { await api(`/delivery/orders/${o.id}/status`, { method: 'POST', body: { status: para } }); carregar(); } catch (e) { setErr(e.message); }
  }
  if (!lista || !loja) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  const colunas = ['new', 'confirmed', 'preparing', 'ready', 'out_for_delivery'];
  return (
    <>
      {err && <div className="error">{err}</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <strong style={{ fontSize: 16 }}>{loja.open_now ? 'Loja aberta' : 'Loja fechada'}</strong>
          <span className="muted">{loja.open_mode === 'auto' ? 'seguindo os horários' : loja.open_mode === 'open' ? 'aberta à força' : 'fechada à força'}</span>
          <span className="spacer" />
          {[['auto', 'Pelos horários'], ['open', 'Abrir agora'], ['closed', 'Fechar agora']].map(([k, n]) => <button key={k} className={'btn sm' + (loja.open_mode === k ? ' primary' : '')} onClick={() => modoLoja(k)}>{n}</button>)}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={som} onChange={(e) => { setSom(e.target.checked); try { localStorage.setItem('dlv_som', e.target.checked ? '1' : '0'); } catch { /* sem armazenamento */ } }} /> Som de pedido novo
          </label>
          <button className="btn primary" onClick={() => setNovo(true)}>Novo pedido</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10, alignItems: 'start' }}>
        {colunas.map((c) => {
          const itens = lista.filter((o) => o.status === c);
          return (
            <div key={c} className="card" style={{ padding: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}><strong>{ETAPAS[c]}</strong><span className="muted">{itens.length}</span></div>
              {itens.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Nenhum pedido</p>}
              {itens.map((o) => {
                const prox = PROXIMA(o);
                const atraso = c !== 'out_for_delivery' && minutosDesde(o.created_at) > (o.eta_minutes || 45);
                return (
                  <div key={o.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, marginBottom: 8, borderLeft: atraso ? '4px solid var(--bad)' : undefined }}>
                    <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setAberto(o)}>
                      <strong>#{o.id}</strong><span className="muted" style={{ fontSize: 12 }}>{o.scheduled_for ? `p/ ${dataHora(o.scheduled_for)}` : `${minutosDesde(o.created_at)} min`}</span>
                    </div>
                    <div style={{ cursor: 'pointer', fontSize: 14 }} onClick={() => setAberto(o)}>
                      {o.customer_name || o.phone || 'Cliente'}<br />
                      <span className="muted" style={{ fontSize: 12 }}>{o.kind === 'pickup' ? 'Retirada' : `Entrega${o.neighborhood ? ' · ' + o.neighborhood : ''}`} · {o.items.reduce((a, i) => a + i.qty, 0)} item(ns)</span><br />
                      <strong>{brl(o.total)}</strong> <span className="muted" style={{ fontSize: 12 }}>{PAGTO[o.payment_method]}{o.paid ? ' · pago' : ''}</span>
                    </div>
                    {prox && <button className="btn sm primary" style={{ marginTop: 6, width: '100%' }} onClick={() => avancar(o, prox.para)}>{prox.texto}</button>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {encerrados.length > 0 && (
        <div className="card table-wrap" style={{ marginTop: 12 }}>
          <h3>Encerrados hoje</h3>
          <table><tbody>{encerrados.map((o) => (
            <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setAberto(o)}>
              <td>#{o.id}</td><td>{o.customer_name || o.phone}</td><td>{ETAPAS[o.status]}</td><td>{brl(o.total)}</td><td className="muted">{hora(o.created_at)}</td>
            </tr>
          ))}</tbody></table>
        </div>
      )}
      {aberto && <Detalhe pedido={aberto} fechar={() => { setAberto(null); carregar(); }} />}
      {novo && <NovoPedido fechar={(criou) => { setNovo(false); if (criou) carregar(); }} />}
    </>
  );
}

function ticketHtml(o) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const linhas = o.items.map((i) => `<tr><td>${i.qty}x ${esc(i.name)}${i.options.length ? '<br><small>' + i.options.map((x) => esc(x.name)).join(', ') + '</small>' : ''}${i.note ? '<br><small>Obs: ' + esc(i.note) + '</small>' : ''}</td><td style="text-align:right">${brl(i.total)}</td></tr>`).join('');
  const end = o.kind === 'delivery' ? `${esc(o.street)}, ${esc(o.number)}${o.complement ? ' - ' + esc(o.complement) : ''}<br>${esc(o.neighborhood || '')}${o.reference ? '<br>Ref.: ' + esc(o.reference) : ''}` : 'RETIRADA NO LOCAL';
  return `<html><head><meta charset="utf-8"><title>Pedido ${o.id}</title><style>body{font-family:monospace;width:300px;margin:8px auto;font-size:13px}table{width:100%}hr{border:0;border-top:1px dashed #000}</style></head><body>
    <h2>Pedido #${o.id}</h2><div>${dataHora(o.created_at)}</div><hr>
    <b>${esc(o.customer_name || '')}</b><br>${esc(o.phone || '')}<br>${end}<hr>
    <table>${linhas}</table><hr>
    <table><tr><td>Subtotal</td><td style="text-align:right">${brl(o.subtotal)}</td></tr>
    ${o.fee ? `<tr><td>Taxa de entrega</td><td style="text-align:right">${brl(o.fee)}</td></tr>` : ''}
    ${o.discount ? `<tr><td>Desconto ${esc(o.coupon_code || '')}</td><td style="text-align:right">-${brl(o.discount)}</td></tr>` : ''}
    <tr><td><b>TOTAL</b></td><td style="text-align:right"><b>${brl(o.total)}</b></td></tr></table><hr>
    ${PAGTO[o.payment_method]}${o.paid ? ' (PAGO)' : ''}${o.change_for ? `<br>Troco para ${brl(o.change_for)}` : ''}
    ${o.note ? `<hr>Obs: ${esc(o.note)}` : ''}<script>window.onload=function(){window.print()}</script></body></html>`;
}

function Detalhe({ pedido, fechar }) {
  const [o, setO] = useState(null);
  const [ents, setEnts] = useState([]);
  const [cour, setCour] = useState('');
  const [err, setErr] = useState('');
  const recarregar = () => api(`/delivery/orders/${pedido.id}`).then((x) => { setO(x); setCour(x.courier_id || ''); }).catch((e) => setErr(e.message));
  useEffect(() => { recarregar(); api('/delivery/couriers').then((l) => setEnts(l.filter((c) => c.active))).catch(() => {}); }, []);
  if (!o) return <div className="modal-bg" onClick={() => fechar()}><div className="modal" onClick={(e) => e.stopPropagation()}>{err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>}</div></div>;
  const final = ['delivered', 'cancelled'].includes(o.status);
  const prox = PROXIMA(o);
  async function ir(para, extra = {}) {
    setErr('');
    try { await api(`/delivery/orders/${o.id}/status`, { method: 'POST', body: { status: para, ...extra } }); await recarregar(); } catch (e) { setErr(e.message); }
  }
  async function cancelar() {
    const motivo = window.prompt('Motivo do cancelamento (o cliente recebe este texto):', '');
    if (motivo === null) return;
    ir('cancelled', { reason: motivo });
  }
  async function pagar() { try { await api(`/delivery/orders/${o.id}`, { method: 'PUT', body: { paid: !o.paid } }); await recarregar(); } catch (e) { setErr(e.message); } }
  async function trocarEntregador(v) { setCour(v); try { await api(`/delivery/orders/${o.id}`, { method: 'PUT', body: { courier_id: v || null } }); } catch (e) { setErr(e.message); } }
  function imprimir() { const w = window.open('', '_blank', 'width=360,height=640'); if (w) { w.document.write(ticketHtml(o)); w.document.close(); } }
  const fone = (o.phone || '').replace(/\D/g, '');
  return (
    <div className="modal-bg" onClick={() => fechar()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h2>Pedido #{o.id} · {ETAPAS[o.status]}</h2>
        {err && <div className="error">{err}</div>}
        <p><strong>{o.customer_name || 'Cliente'}</strong> {fone && <a href={`https://wa.me/${fone}`} target="_blank" rel="noopener noreferrer">{o.phone}</a>}<br />
          <span className="muted">{dataHora(o.created_at)}{o.scheduled_for ? ` · agendado para ${dataHora(o.scheduled_for)}` : ''} · {o.source === 'ia' ? 'pelo atendente' : 'lançado no painel'}</span></p>
        <p>{o.kind === 'pickup' ? <strong>Retirada no local</strong> : <>{o.street}, {o.number}{o.complement ? ` - ${o.complement}` : ''}<br />{o.neighborhood}{o.reference ? ` · Ref.: ${o.reference}` : ''}</>}</p>
        <table><tbody>
          {o.items.map((i, k) => <tr key={k}><td>{i.qty}x {i.name}{i.options.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{i.options.map((x) => x.name).join(', ')}</div>}{i.note && <div className="muted" style={{ fontSize: 12 }}>Obs: {i.note}</div>}</td><td style={{ textAlign: 'right' }}>{brl(i.total)}</td></tr>)}
          <tr><td className="muted">Subtotal</td><td style={{ textAlign: 'right' }}>{brl(o.subtotal)}</td></tr>
          {o.fee > 0 && <tr><td className="muted">Taxa de entrega</td><td style={{ textAlign: 'right' }}>{brl(o.fee)}</td></tr>}
          {o.discount > 0 && <tr><td className="muted">Desconto {o.coupon_code}</td><td style={{ textAlign: 'right' }}>-{brl(o.discount)}</td></tr>}
          <tr><td><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>{brl(o.total)}</strong></td></tr>
        </tbody></table>
        <p>{PAGTO[o.payment_method]} · {o.paid ? 'pago' : 'a receber'}{o.change_for ? ` · troco para ${brl(o.change_for)}` : ''}</p>
        {o.note && <p><strong>Observação:</strong> {o.note}</p>}
        {o.cancel_reason && <p><strong>Motivo do cancelamento:</strong> {o.cancel_reason}</p>}
        {!final && o.kind === 'delivery' && (
          <div className="field"><label>Entregador</label>
            <select value={cour} onChange={(e) => trocarEntregador(e.target.value)}>
              <option value="">Sem entregador</option>{ents.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
        )}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {!final && prox && <button className="btn primary" onClick={() => ir(prox.para, prox.para === 'out_for_delivery' && cour ? { courier_id: cour } : {})}>{prox.texto}</button>}
          {!final && <button className="btn" onClick={pagar}>{o.paid ? 'Desmarcar pago' : 'Marcar como pago'}</button>}
          <button className="btn" onClick={imprimir}>Imprimir</button>
          {!final && <button className="btn" onClick={cancelar}>Cancelar pedido</button>}
          <button className="btn" onClick={() => fechar()}>Fechar</button>
        </div>
        {o.events?.length > 0 && <p className="muted" style={{ fontSize: 12 }}>{o.events.map((e) => `${ETAPAS[e.status]} ${hora(e.at)}`).join(' → ')}</p>}
      </div>
    </div>
  );
}

// ---------- pedido feito no balcão / por telefone ----------
function NovoPedido({ fechar }) {
  const [menu, setMenu] = useState(null);
  const [zonas, setZonas] = useState([]);
  const [f, setF] = useState({ name: '', phone: '', kind: 'delivery', street: '', number: '', complement: '', neighborhood: '', reference: '', payment_method: 'pix', change_for: '', coupon: '', note: '', scheduled_for: '' });
  const [carrinho, setCarrinho] = useState([]);     // { item, qty, options: [id], note }
  const [escolhendo, setEscolhendo] = useState(null);
  const [calc, setCalc] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/delivery/menu').then(setMenu).catch((e) => setErr(e.message)); api('/delivery/zones').then((z) => setZonas(z.filter((x) => x.active))).catch(() => {}); }, []);
  const corpo = useMemo(() => ({
    ...f, force: true, scheduled_for: f.scheduled_for ? new Date(f.scheduled_for).toISOString() : undefined, change_for: f.payment_method === 'cash' && f.change_for ? f.change_for : undefined,
    coupon: f.coupon || undefined, items: carrinho.map((c) => ({ item_id: c.item.id, qty: c.qty, options: c.options, note: c.note || undefined })),
  }), [f, carrinho]);
  useEffect(() => {
    if (!carrinho.length) { setCalc(null); return; }
    const t = setTimeout(() => api('/delivery/quote', { method: 'POST', body: corpo }).then((r) => { setCalc(r); setErr(''); }).catch((e) => { setCalc(null); setErr(e.message); }), 400);
    return () => clearTimeout(t);
  }, [corpo, carrinho.length]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function salvar() {
    setErr('');
    try { await api('/delivery/orders', { method: 'POST', body: corpo }); fechar(true); } catch (e) { setErr(e.message); }
  }
  if (!menu) return <div className="modal-bg"><div className="modal">{err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>}</div></div>;
  return (
    <div className="modal-bg" onClick={() => fechar(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, maxHeight: '92vh', overflow: 'auto' }}>
        <h2>Novo pedido</h2>
        {err && <div className="error">{err}</div>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="field"><label>Nome</label><input value={f.name} onChange={set('name')} /></div>
          <div className="field"><label>WhatsApp</label><input value={f.phone} onChange={set('phone')} placeholder="32 99999-9999" /></div>
          <div className="field"><label>Tipo</label><select value={f.kind} onChange={set('kind')}><option value="delivery">Entrega</option><option value="pickup">Retirada</option></select></div>
        </div>
        {f.kind === 'delivery' && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: 2 }}><label>Rua</label><input value={f.street} onChange={set('street')} /></div>
            <div className="field" style={{ width: 90 }}><label>Número</label><input value={f.number} onChange={set('number')} /></div>
            <div className="field"><label>Complemento</label><input value={f.complement} onChange={set('complement')} /></div>
            <div className="field"><label>Bairro</label><input list="dlv-bairros" value={f.neighborhood} onChange={set('neighborhood')} /><datalist id="dlv-bairros">{zonas.map((z) => <option key={z.id} value={z.name} />)}</datalist></div>
            <div className="field" style={{ flex: 1 }}><label>Referência</label><input value={f.reference} onChange={set('reference')} /></div>
          </div>
        )}
        <h3>Itens</h3>
        <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 6, marginBottom: 8 }}>
          {menu.categories.map((c) => (
            <div key={c.id ?? 'x'}><strong style={{ fontSize: 13 }}>{c.name}</strong>
              {c.items.map((i) => (
                <div key={i.id} className="row" style={{ justifyContent: 'space-between', padding: '2px 0', opacity: i.sold_out ? 0.5 : 1 }}>
                  <span>{i.name} <span className="muted">{brl(i.price)}{i.sold_out ? ' · esgotado' : ''}</span></span>
                  <button className="btn sm" onClick={() => setEscolhendo(i)}>Adicionar</button>
                </div>
              ))}
            </div>
          ))}
          {menu.categories.length === 0 && <p className="muted">Cadastre o cardápio primeiro.</p>}
        </div>
        {carrinho.map((c, k) => (
          <div key={k} className="row" style={{ justifyContent: 'space-between' }}>
            <span>{c.qty}x {c.item.name}{c.options.length > 0 && <span className="muted"> ({c.item.option_groups.flatMap((g) => g.options).filter((o) => c.options.includes(o.id)).map((o) => o.name).join(', ')})</span>}</span>
            <button className="btn sm" onClick={() => setCarrinho(carrinho.filter((_, j) => j !== k))}>Remover</button>
          </div>
        ))}
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <div className="field"><label>Pagamento</label><select value={f.payment_method} onChange={set('payment_method')}>{Object.entries(PAGTO).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></div>
          {f.payment_method === 'cash' && <div className="field"><label>Troco para</label><input value={f.change_for} onChange={set('change_for')} placeholder="opcional" /></div>}
          <div className="field"><label>Cupom</label><input value={f.coupon} onChange={set('coupon')} /></div>
          <div className="field"><label>Agendar para (opcional)</label><input type="datetime-local" value={f.scheduled_for} onChange={set('scheduled_for')} /></div>
        </div>
        <div className="field"><label>Observação</label><input value={f.note} onChange={set('note')} /></div>
        {calc && <p><strong>Total {brl(calc.total)}</strong> <span className="muted">(itens {brl(calc.subtotal)}{calc.delivery_fee ? ` + entrega ${brl(calc.delivery_fee)}` : ''}{calc.discount ? ` − desconto ${brl(calc.discount)}` : ''}) · previsão {calc.eta_minutes} min</span></p>}
        <div className="row"><button className="btn primary" disabled={!carrinho.length || !calc} onClick={salvar}>Lançar pedido</button><button className="btn" onClick={() => fechar(false)}>Cancelar</button></div>
        {escolhendo && <EscolherItem item={escolhendo} fechar={() => setEscolhendo(null)} ok={(c) => { setCarrinho([...carrinho, c]); setEscolhendo(null); }} />}
      </div>
    </div>
  );
}

export function EscolherItem({ item, fechar, ok }) {
  const [qty, setQty] = useState(1);
  const [sel, setSel] = useState([]);
  const [nota, setNota] = useState('');
  const [err, setErr] = useState('');
  const alterna = (g, o) => {
    const doGrupo = sel.filter((id) => g.options.some((x) => x.id === id));
    if (sel.includes(o.id)) return setSel(sel.filter((id) => id !== o.id));
    if (g.max_select === 1) return setSel([...sel.filter((id) => !doGrupo.includes(id)), o.id]);
    if (doGrupo.length >= g.max_select) return;
    setSel([...sel, o.id]);
  };
  function confirmar() {
    for (const g of item.option_groups) {
      const n = sel.filter((id) => g.options.some((x) => x.id === id)).length;
      if (n < g.min_select) { setErr(`Escolha ${g.min_select > 1 ? `pelo menos ${g.min_select} opções de ` : ''}"${g.name}"`); return; }
    }
    ok({ item, qty, options: sel, note: nota });
  }
  return (
    <div className="modal-bg" onClick={(e) => { e.stopPropagation(); fechar(); }} style={{ zIndex: 60 }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <h3>{item.name} <span className="muted">{brl(item.price)}</span></h3>
        {err && <div className="error">{err}</div>}
        {item.option_groups.map((g) => (
          <div key={g.id} style={{ marginBottom: 8 }}>
            <strong>{g.name}</strong> <span className="muted" style={{ fontSize: 12 }}>{g.min_select > 0 ? 'obrigatório' : 'opcional'} · até {g.max_select}</span>
            {g.options.map((o) => (
              <label key={o.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 'normal' }}>
                <input type={g.max_select === 1 ? 'radio' : 'checkbox'} style={{ width: 'auto' }} checked={sel.includes(o.id)} onChange={() => alterna(g, o)} />
                {o.name} {o.price_delta > 0 && <span className="muted">+ {brl(o.price_delta)}</span>}
              </label>
            ))}
          </div>
        ))}
        <div className="row"><div className="field" style={{ width: 90 }}><label>Quantidade</label><input type="number" min="1" max="99" value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} /></div>
          <div className="field" style={{ flex: 1 }}><label>Observação do item</label><input value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} /></div></div>
        <div className="row"><button className="btn primary" onClick={confirmar}>Adicionar</button><button className="btn" onClick={fechar}>Cancelar</button></div>
      </div>
    </div>
  );
}

// ================= CARDÁPIO =================
export function Cardapio() {
  const [menu, setMenu] = useState(null);
  const [editando, setEditando] = useState(null);     // item (ou {} para novo)
  const [nomeCat, setNomeCat] = useState('');
  const [err, setErr] = useState('');
  const carregar = () => api('/delivery/menu?all=1').then(setMenu).catch((e) => setErr(e.message));
  useEffect(() => { carregar(); }, []);
  async function nova(e) { e.preventDefault(); setErr(''); try { await api('/delivery/categories', { method: 'POST', body: { name: nomeCat } }); setNomeCat(''); carregar(); } catch (e2) { setErr(e2.message); } }
  async function renomear(c) { const n = window.prompt('Novo nome da categoria:', c.name); if (!n || n === c.name) return; try { await api(`/delivery/categories/${c.id}`, { method: 'PUT', body: { name: n } }); carregar(); } catch (e) { setErr(e.message); } }
  async function apagarCat(c) { if (!window.confirm(`Apagar a categoria "${c.name}"? Os itens ficam em "Outros".`)) return; try { await api(`/delivery/categories/${c.id}`, { method: 'DELETE' }); carregar(); } catch (e) { setErr(e.message); } }
  async function alternar(i, campo) { try { await api(`/delivery/items/${i.id}`, { method: 'PUT', body: { [campo]: !i[campo] } }); carregar(); } catch (e) { setErr(e.message); } }
  if (!menu) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  const categorias = menu.categories.filter((c) => c.id);
  return (
    <>
      {err && <div className="error">{err}</div>}
      <form className="card row" onSubmit={nova} style={{ marginBottom: 12, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}><label>Nova categoria</label><input value={nomeCat} onChange={(e) => setNomeCat(e.target.value)} placeholder="Ex.: Pizzas, Bebidas, Sobremesas" required /></div>
        <button className="btn">Adicionar categoria</button>
        <ImportarAqui tipo="menu" onFeito={carregar} />
        <button type="button" className="btn primary" onClick={() => setEditando({})}>Novo item</button>
      </form>
      {menu.categories.length === 0 && <div className="card muted">Cardápio vazio. Crie uma categoria e cadastre os itens.</div>}
      {menu.categories.map((c) => (
        <div key={c.id ?? 'outros'} className="card table-wrap" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>{c.name}</h3>
            {c.id && <span><button className="btn sm" onClick={() => renomear(c)}>Renomear</button> <button className="btn sm" onClick={() => apagarCat(c)}>Apagar</button></span>}
          </div>
          <table><tbody>{c.items.map((i) => (
            <tr key={i.id} style={{ opacity: i.active ? 1 : 0.5 }}>
              <td><strong>{i.name}</strong>{i.description && <div className="muted" style={{ fontSize: 12 }}>{i.description}</div>}{i.option_groups.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{i.option_groups.map((g) => g.name).join(' · ')}</div>}</td>
              <td>{brl(i.price)}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button className={'btn sm' + (i.sold_out ? ' primary' : '')} onClick={() => alternar(i, 'sold_out')}>{i.sold_out ? 'Esgotado' : 'Marcar esgotado'}</button>{' '}
                <button className="btn sm" onClick={() => alternar(i, 'active')}>{i.active ? 'Ocultar' : 'Mostrar'}</button>{' '}
                <button className="btn sm" onClick={() => setEditando(i)}>Editar</button>
              </td>
            </tr>
          ))}</tbody></table>
        </div>
      ))}
      {editando && <EditarItem item={editando} categorias={categorias} fechar={() => { setEditando(null); carregar(); }} />}
    </>
  );
}

function EditarItem({ item, categorias, fechar }) {
  const [id, setId] = useState(item.id || null);
  const [f, setF] = useState({ name: item.name || '', description: item.description || '', price: item.price ?? '', category_id: item.category_id || '', station: item.station || 'cozinha' });
  const [grupos, setGrupos] = useState(item.option_groups || []);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const recarregar = async (iid) => { const m = await api('/delivery/menu?all=1'); const it = m.categories.flatMap((c) => c.items).find((x) => x.id === iid); if (it) setGrupos(it.option_groups); };
  async function salvar() {
    setErr(''); setMsg('');
    try {
      const corpo = { ...f, category_id: f.category_id || null };
      if (id) await api(`/delivery/items/${id}`, { method: 'PUT', body: corpo });
      else { const r = await api('/delivery/items', { method: 'POST', body: corpo }); setId(r.id); }
      setMsg('Item salvo');
    } catch (e) { setErr(e.message); }
  }
  async function apagar() { if (!window.confirm(`Apagar "${f.name}"?`)) return; try { await api(`/delivery/items/${id}`, { method: 'DELETE' }); fechar(); } catch (e) { setErr(e.message); } }
  async function novoGrupo() {
    const nome = window.prompt('Nome do grupo de opções (ex.: Borda, Tamanho, Extras):'); if (!nome) return;
    const obrig = window.confirm('A escolha é obrigatória? (OK = sim, Cancelar = opcional)');
    const max = Number(window.prompt('Quantas opções o cliente pode escolher, no máximo?', '1')) || 1;
    try { await api(`/delivery/items/${id}/groups`, { method: 'POST', body: { name: nome, min_select: obrig ? 1 : 0, max_select: Math.max(max, obrig ? 1 : 1) } }); await recarregar(id); } catch (e) { setErr(e.message); }
  }
  async function apagarGrupo(g) { if (!window.confirm(`Apagar o grupo "${g.name}" e suas opções?`)) return; try { await api(`/delivery/groups/${g.id}`, { method: 'DELETE' }); await recarregar(id); } catch (e) { setErr(e.message); } }
  async function novaOpcao(g) {
    const nome = window.prompt(`Nova opção em "${g.name}":`); if (!nome) return;
    const valor = window.prompt('Quanto soma no preço? (0 se não cobra a mais)', '0');
    try { await api(`/delivery/groups/${g.id}/options`, { method: 'POST', body: { name: nome, price_delta: valor || 0 } }); await recarregar(id); } catch (e) { setErr(e.message); }
  }
  async function opcao(o, acao) {
    try { if (acao === 'apagar') await api(`/delivery/options/${o.id}`, { method: 'DELETE' }); else await api(`/delivery/options/${o.id}`, { method: 'PUT', body: { active: !o.active } }); await recarregar(id); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="modal-bg" onClick={fechar}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620, maxHeight: '92vh', overflow: 'auto' }}>
        <h2>{id ? 'Editar item' : 'Novo item'}</h2>
        {err && <div className="error">{err}</div>}{msg && <p>{msg}</p>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 1 }}><label>Nome</label><input value={f.name} onChange={set('name')} /></div>
          <div className="field" style={{ width: 120 }}><label>Preço</label><input value={f.price} onChange={set('price')} placeholder="39,90" /></div>
          <div className="field"><label>Categoria</label><select value={f.category_id} onChange={set('category_id')}><option value="">Sem categoria</option>{categorias.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        </div>
        <div className="field"><label>Descrição</label><input value={f.description} onChange={set('description')} maxLength={400} /></div>
        <div className="field"><label>Onde é preparado (restaurante)</label><select value={f.station} onChange={set('station')}><option value="cozinha">Cozinha</option><option value="bar">Bar</option><option value="direto">Sai direto, sem preparo</option></select></div>
        <div className="row"><button className="btn primary" onClick={salvar}>Salvar item</button>{id && <button className="btn" onClick={apagar}>Apagar item</button>}<button className="btn" onClick={fechar}>Fechar</button></div>
        {id && (
          <>
            <h3 style={{ marginTop: 14 }}>Opções e complementos</h3>
            <p className="muted">Tamanho, borda, extras… Cada grupo define quantas escolhas o cliente faz.</p>
            {grupos.map((g) => (
              <div key={g.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}><strong>{g.name}</strong><span className="muted" style={{ fontSize: 12 }}>{g.min_select > 0 ? 'obrigatório' : 'opcional'} · até {g.max_select}</span></div>
                {g.options.map((o) => (
                  <div key={o.id} className="row" style={{ justifyContent: 'space-between', opacity: o.active ? 1 : 0.5 }}>
                    <span>{o.name} {o.price_delta > 0 && <span className="muted">+ {brl(o.price_delta)}</span>}</span>
                    <span><button className="btn sm" onClick={() => opcao(o, 'alternar')}>{o.active ? 'Ocultar' : 'Mostrar'}</button> <button className="btn sm" onClick={() => opcao(o, 'apagar')}>Apagar</button></span>
                  </div>
                ))}
                <div className="row" style={{ marginTop: 6 }}><button className="btn sm" onClick={() => novaOpcao(g)}>Adicionar opção</button><button className="btn sm" onClick={() => apagarGrupo(g)}>Apagar grupo</button></div>
              </div>
            ))}
            <button className="btn" onClick={novoGrupo}>Novo grupo de opções</button>
          </>
        )}
        {!id && <p className="muted" style={{ marginTop: 10 }}>Salve o item para poder adicionar opções e complementos.</p>}
      </div>
    </div>
  );
}

// ================= ENTREGA E PAGAMENTO =================
function Configuracao() {
  const [s, setS] = useState(null);
  const [zonas, setZonas] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const carregarZonas = () => api('/delivery/zones').then(setZonas).catch((e) => setErr(e.message));
  useEffect(() => { api('/delivery/settings').then(setS).catch((e) => setErr(e.message)); carregarZonas(); }, []);
  if (!s) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  const set = (k, v) => setS({ ...s, [k]: v });
  const hora = (d) => s.hours?.[d] || null;
  const setHora = (d, campo, v) => { const h = { ...(s.hours || {}) }; h[d] = { open: '18:00', close: '23:00', ...(h[d] || {}), [campo]: v }; set('hours', h); };
  const fecharDia = (d) => { const h = { ...(s.hours || {}) }; delete h[d]; set('hours', h); };
  async function salvar() {
    setErr(''); setMsg('');
    try {
      const r = await api('/delivery/settings', { method: 'PUT', body: {
        delivery_enabled: s.delivery_enabled, pickup_enabled: s.pickup_enabled, use_zones: s.use_zones, default_fee: s.default_fee, min_order: s.min_order, free_above: s.free_above === '' ? null : s.free_above,
        prep_minutes: s.prep_minutes, delivery_minutes: s.delivery_minutes, pay_pix: s.pay_pix, pay_cash: s.pay_cash, pay_card: s.pay_card, pix_key: s.pix_key || '',
        auto_accept: s.auto_accept, accept_scheduled: s.accept_scheduled, notify: s.notify, closed_message: s.closed_message || '', hours: s.hours || {}, messages: s.messages || {},
      } });
      setS({ ...s, ...r }); setMsg('Configurações salvas');
    } catch (e) { setErr(e.message); }
  }
  async function novaZona() {
    const nome = window.prompt('Nome do bairro:'); if (!nome) return;
    const taxa = window.prompt('Taxa de entrega para esse bairro (R$):', '0'); if (taxa === null) return;
    try { await api('/delivery/zones', { method: 'POST', body: { name: nome, fee: taxa } }); carregarZonas(); } catch (e) { setErr(e.message); }
  }
  async function zona(z, acao) {
    try {
      if (acao === 'apagar') { if (!window.confirm(`Apagar o bairro ${z.name}?`)) return; await api(`/delivery/zones/${z.id}`, { method: 'DELETE' }); }
      else if (acao === 'taxa') { const t = window.prompt(`Taxa para ${z.name} (R$):`, String(z.fee)); if (t === null) return; await api(`/delivery/zones/${z.id}`, { method: 'PUT', body: { fee: t } }); }
      else if (acao === 'minimo') { const t = window.prompt(`Pedido mínimo para ${z.name} (R$, vazio = o geral):`, z.min_order ?? ''); if (t === null) return; await api(`/delivery/zones/${z.id}`, { method: 'PUT', body: { min_order: t } }); }
      else if (acao === 'tempo') { const t = window.prompt(`Minutos extras de entrega para ${z.name}:`, String(z.extra_minutes)); if (t === null) return; await api(`/delivery/zones/${z.id}`, { method: 'PUT', body: { extra_minutes: t } }); }
      else await api(`/delivery/zones/${z.id}`, { method: 'PUT', body: { active: !z.active } });
      carregarZonas();
    } catch (e) { setErr(e.message); }
  }
  const caixa = (k, rotulo) => <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 'normal' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!s[k]} onChange={(e) => set(k, e.target.checked)} /> {rotulo}</label>;
  return (
    <>
      {err && <div className="error">{err}</div>}{msg && <p>{msg}</p>}
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Horário de funcionamento</h3>
        <p className="muted">Fora desses horários a loja fecha sozinha (você pode abrir ou fechar à força na tela de Pedidos). Dá para fechar depois da meia-noite, por exemplo das 18:00 à 01:00.</p>
        {DIAS.map((nome, d) => (
          <div key={d} className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 80 }}>{nome}</span>
            {hora(d) ? (
              <>
                <input type="time" value={hora(d).open} onChange={(e) => setHora(d, 'open', e.target.value)} style={{ width: 120 }} /> às
                <input type="time" value={hora(d).close} onChange={(e) => setHora(d, 'close', e.target.value)} style={{ width: 120 }} />
                <button className="btn sm" onClick={() => fecharDia(d)}>Fechado neste dia</button>
              </>
            ) : <><span className="muted">Fechado</span><button className="btn sm" onClick={() => setHora(d, 'open', '18:00')}>Abrir neste dia</button></>}
          </div>
        ))}
        <div className="field" style={{ marginTop: 8 }}><label>Mensagem quando a loja está fechada</label><input value={s.closed_message || ''} maxLength={300} onChange={(e) => set('closed_message', e.target.value)} placeholder="Ex.: Estamos fechados. Abrimos às 18h!" /></div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Entrega e retirada</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 20 }}>{caixa('delivery_enabled', 'Fazemos entrega')}{caixa('pickup_enabled', 'Aceitamos retirada no local')}{caixa('accept_scheduled', 'Aceitamos pedidos agendados')}</div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="field"><label>Pedido mínimo (R$)</label><input value={s.min_order} onChange={(e) => set('min_order', e.target.value)} style={{ width: 110 }} /></div>
          <div className="field"><label>Preparo (min)</label><input type="number" min="0" value={s.prep_minutes} onChange={(e) => set('prep_minutes', e.target.value)} style={{ width: 90 }} /></div>
          <div className="field"><label>Entrega (min)</label><input type="number" min="0" value={s.delivery_minutes} onChange={(e) => set('delivery_minutes', e.target.value)} style={{ width: 90 }} /></div>
          <div className="field"><label>Frete grátis acima de (R$)</label><input value={s.free_above ?? ''} onChange={(e) => set('free_above', e.target.value)} style={{ width: 130 }} placeholder="sem frete grátis" /></div>
        </div>
        {caixa('use_zones', 'Cobrar a taxa por bairro (só entrega nos bairros cadastrados)')}
        {!s.use_zones && <div className="field"><label>Taxa de entrega única (R$)</label><input value={s.default_fee} onChange={(e) => set('default_fee', e.target.value)} style={{ width: 110 }} /></div>}
        {s.use_zones && (
          <>
            <table><tbody>{zonas.map((z) => (
              <tr key={z.id} style={{ opacity: z.active ? 1 : 0.5 }}>
                <td><strong>{z.name}</strong></td><td>{brl(z.fee)}</td><td className="muted">{z.min_order !== null ? `mínimo ${brl(z.min_order)}` : ''}{z.extra_minutes ? ` · +${z.extra_minutes} min` : ''}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => zona(z, 'taxa')}>Taxa</button> <button className="btn sm" onClick={() => zona(z, 'minimo')}>Mínimo</button> <button className="btn sm" onClick={() => zona(z, 'tempo')}>Tempo</button>{' '}
                  <button className="btn sm" onClick={() => zona(z, 'ativo')}>{z.active ? 'Pausar' : 'Ativar'}</button> <button className="btn sm" onClick={() => zona(z, 'apagar')}>Apagar</button>
                </td>
              </tr>
            ))}</tbody></table>
            <button className="btn" onClick={novaZona}>Adicionar bairro</button>
          </>
        )}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Pagamento</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 20 }}>{caixa('pay_pix', 'Pix')}{caixa('pay_cash', 'Dinheiro na entrega')}{caixa('pay_card', 'Cartão na entrega')}</div>
        <div className="field"><label>Chave Pix (o atendente passa ao cliente)</label><input value={s.pix_key || ''} onChange={(e) => set('pix_key', e.target.value)} /></div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Atendimento e avisos</h3>
        {caixa('auto_accept', 'Confirmar sozinho os pedidos feitos pelo atendente')}
        {caixa('notify', 'Avisar o cliente no WhatsApp a cada etapa do pedido')}
        {!s.notifications_available && <p className="muted">O envio de avisos ainda não está ligado neste servidor. Os pedidos funcionam normalmente.</p>}
        {s.notify && (
          <>
            <p className="muted">Textos dos avisos. Use {'{nome}'}, {'{pedido}'}, {'{total}'}, {'{eta}'}, {'{entregador}'} e {'{motivo}'}. Em branco vale o texto padrão.</p>
            {[['confirmed', 'Pedido confirmado'], ['out_for_delivery', 'Saiu para entrega'], ['ready', 'Pronto para retirada'], ['delivered', 'Entregue'], ['cancelled', 'Cancelado']].map(([k, n]) => (
              <div className="field" key={k}><label>{n}</label>
                <input value={s.messages?.[k] || ''} placeholder={s.default_messages?.[k]} maxLength={400} onChange={(e) => set('messages', { ...(s.messages || {}), [k]: e.target.value })} /></div>
            ))}
          </>
        )}
      </div>
      <button className="btn primary" onClick={salvar}>Salvar configurações</button>
    </>
  );
}

// ================= CUPONS =================
function Cupons() {
  const [l, setL] = useState(null);
  const [f, setF] = useState({ code: '', kind: 'percent', value: '', min_order: '', max_uses: '', valid_until: '' });
  const [err, setErr] = useState('');
  const carregar = () => api('/delivery/coupons').then(setL).catch((e) => setErr(e.message));
  useEffect(() => { carregar(); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function criar(e) {
    e.preventDefault(); setErr('');
    try { await api('/delivery/coupons', { method: 'POST', body: { ...f, min_order: f.min_order || undefined, max_uses: f.max_uses || undefined, valid_until: f.valid_until || undefined } }); setF({ code: '', kind: 'percent', value: '', min_order: '', max_uses: '', valid_until: '' }); carregar(); }
    catch (e2) { setErr(e2.message); }
  }
  async function alternar(c) { try { await api(`/delivery/coupons/${c.id}`, { method: 'PUT', body: { active: !c.active } }); carregar(); } catch (e) { setErr(e.message); } }
  async function apagar(c) { if (!window.confirm(`Apagar o cupom ${c.code}?`)) return; try { await api(`/delivery/coupons/${c.id}`, { method: 'DELETE' }); carregar(); } catch (e) { setErr(e.message); } }
  return (
    <>
      {err && <div className="error">{err}</div>}
      <form className="card" onSubmit={criar} style={{ marginBottom: 12 }}>
        <h3>Novo cupom</h3>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field"><label>Código</label><input value={f.code} onChange={set('code')} placeholder="BEMVINDO10" required style={{ textTransform: 'uppercase' }} /></div>
          <div className="field"><label>Tipo</label><select value={f.kind} onChange={set('kind')}><option value="percent">Porcentagem</option><option value="fixed">Valor fixo (R$)</option></select></div>
          <div className="field"><label>{f.kind === 'percent' ? 'Desconto (%)' : 'Desconto (R$)'}</label><input value={f.value} onChange={set('value')} style={{ width: 90 }} required /></div>
          <div className="field"><label>Pedido mínimo (R$)</label><input value={f.min_order} onChange={set('min_order')} style={{ width: 110 }} /></div>
          <div className="field"><label>Limite de usos</label><input type="number" min="1" value={f.max_uses} onChange={set('max_uses')} style={{ width: 100 }} /></div>
          <div className="field"><label>Vale até</label><input type="date" value={f.valid_until} onChange={set('valid_until')} /></div>
          <button className="btn primary">Criar cupom</button>
        </div>
      </form>
      {l && l.length > 0 ? (
        <div className="card table-wrap"><table>
          <thead><tr><th>Código</th><th>Desconto</th><th>Mínimo</th><th>Usos</th><th>Validade</th><th></th></tr></thead>
          <tbody>{l.map((c) => (
            <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
              <td><strong>{c.code}</strong></td><td>{c.kind === 'percent' ? `${c.value}%` : brl(c.value)}</td><td>{c.min_order ? brl(c.min_order) : '—'}</td>
              <td>{c.used}{c.max_uses ? ` / ${c.max_uses}` : ''}</td><td>{c.valid_until ? new Date(c.valid_until + 'T12:00:00').toLocaleDateString('pt-BR') : '—'}</td>
              <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => alternar(c)}>{c.active ? 'Pausar' : 'Ativar'}</button> <button className="btn sm" onClick={() => apagar(c)}>Apagar</button></td>
            </tr>
          ))}</tbody></table></div>
      ) : l && <div className="card muted">Nenhum cupom criado.</div>}
    </>
  );
}

// ================= ENTREGADORES =================
function Entregadores() {
  const [l, setL] = useState(null);
  const [f, setF] = useState({ name: '', phone: '' });
  const [err, setErr] = useState('');
  const carregar = () => api('/delivery/couriers').then(setL).catch((e) => setErr(e.message));
  useEffect(() => { carregar(); }, []);
  async function criar(e) { e.preventDefault(); setErr(''); try { await api('/delivery/couriers', { method: 'POST', body: f }); setF({ name: '', phone: '' }); carregar(); } catch (e2) { setErr(e2.message); } }
  async function alternar(c) { try { await api(`/delivery/couriers/${c.id}`, { method: 'PUT', body: { active: !c.active } }); carregar(); } catch (e) { setErr(e.message); } }
  async function apagar(c) { if (!window.confirm(`Apagar ${c.name}? Os pedidos antigos continuam, sem o nome.`)) return; try { await api(`/delivery/couriers/${c.id}`, { method: 'DELETE' }); carregar(); } catch (e) { setErr(e.message); } }
  return (
    <>
      {err && <div className="error">{err}</div>}
      <form className="card row" onSubmit={criar} style={{ marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field"><label>Nome</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
        <div className="field"><label>WhatsApp (opcional)</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="32 99999-9999" /></div>
        <button className="btn primary">Adicionar entregador</button>
      </form>
      {l && l.length > 0 ? (
        <div className="card table-wrap"><table><tbody>{l.map((c) => (
          <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}><td><strong>{c.name}</strong></td><td className="muted">{c.phone || '—'}</td>
            <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => alternar(c)}>{c.active ? 'Pausar' : 'Ativar'}</button> <button className="btn sm" onClick={() => apagar(c)}>Apagar</button></td></tr>
        ))}</tbody></table></div>
      ) : l && <div className="card muted">Nenhum entregador cadastrado.</div>}
    </>
  );
}

// ================= RELATÓRIOS =================
function Relatorio() {
  const [de, setDe] = useState(() => new Date(Date.now() - 29 * 86400000).toLocaleDateString('en-CA'));
  const [ate, setAte] = useState(hojeISO());
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const carregar = useCallback(() => { setErr(''); api(`/delivery/report?from=${de}&to=${ate}`).then(setR).catch((e) => setErr(e.message)); }, [de, ate]);
  useEffect(() => { carregar(); }, [carregar]);
  const maxHora = Math.max(1, ...(r?.by_hour || []).map((h) => h.orders));
  const Tabela = ({ titulo, linhas, rotulo }) => (
    <div className="card table-wrap"><h3>{titulo}</h3>{linhas.length === 0 ? <p className="muted">Sem dados no período.</p> : (
      <table><tbody>{linhas.map((x) => <tr key={x.key}><td>{rotulo ? rotulo(x.key) : x.key}</td><td>{x.orders ?? x.qty}{x.qty !== undefined ? ' un.' : ' pedido(s)'}</td><td style={{ textAlign: 'right' }}>{brl(x.revenue)}</td></tr>)}</tbody></table>)}</div>
  );
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="field"><label>De</label><input type="date" value={de} onChange={(e) => setDe(e.target.value)} /></div>
        <div className="field"><label>Até</label><input type="date" value={ate} onChange={(e) => setAte(e.target.value)} /></div>
      </div>
      {err && <div className="error">{err}</div>}
      {r && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
            {[['Pedidos', r.summary.orders], ['Faturamento', brl(r.summary.revenue)], ['Ticket médio', brl(r.summary.avg_ticket)], ['Entregues', r.summary.delivered], ['Cancelados', r.summary.cancelled], ['Taxas de entrega', brl(r.summary.fees)], ['Descontos', brl(r.summary.discounts)], ['Tempo médio', r.summary.avg_minutes ? `${Math.round(r.summary.avg_minutes)} min` : '—']].map(([n, v]) => (
              <div key={n} className="card stat"><div className="muted" style={{ fontSize: 12 }}>{n}</div><div style={{ fontSize: 20, fontWeight: 700 }}>{v}</div></div>
            ))}
          </div>
          <div className="card" style={{ marginBottom: 12 }}>
            <h3>Pedidos por hora</h3>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 90 }}>
              {Array.from({ length: 24 }, (_, h) => { const x = r.by_hour.find((y) => y.key === h); const n = x?.orders || 0; return <div key={h} title={`${h}h: ${n} pedido(s)`} style={{ flex: 1, height: `${(n / maxHora) * 100}%`, minHeight: n ? 3 : 1, background: n ? 'var(--primary)' : 'var(--line)', borderRadius: 2 }} />; })}
            </div>
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 11 }} ><span className="muted">0h</span><span className="muted">12h</span><span className="muted">23h</span></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
            <Tabela titulo="Itens mais pedidos" linhas={r.top_items} />
            <Tabela titulo="Por forma de pagamento" linhas={r.by_payment} rotulo={(k) => PAGTO[k] || k} />
            <Tabela titulo="Entrega ou retirada" linhas={r.by_kind} rotulo={(k) => (k === 'pickup' ? 'Retirada' : 'Entrega')} />
            <Tabela titulo="Bairros" linhas={r.by_neighborhood} />
            <Tabela titulo="Por dia" linhas={[...r.by_day].reverse().slice(0, 15)} rotulo={(k) => new Date(k + 'T12:00:00').toLocaleDateString('pt-BR')} />
          </div>
        </>
      )}
    </>
  );
}
