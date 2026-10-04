import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Cardapio, EscolherItem, bip } from './Delivery.jsx';

const brl = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',');
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const minutosDesde = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const hojeISO = () => new Date().toLocaleDateString('en-CA');
const STATUS = { sent: 'Na fila', preparing: 'Preparando', ready: 'Pronto', served: 'Entregue', cancelled: 'Cancelado' };
const METODOS = { dinheiro: 'Dinheiro', pix: 'Pix', credito: 'Crédito', debito: 'Débito', outro: 'Outro' };
const opcoesTexto = (o) => (Array.isArray(o) && o.length ? o.map((x) => x.name).join(', ') : '');

// Atualiza sozinho de tempos em tempos (e quando a pessoa volta para a aba)
function useAuto(fn, ms, ativo = true) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    if (!ativo) return undefined;
    ref.current();
    const t = setInterval(() => { if (!document.hidden) ref.current(); }, ms);
    const v = () => { if (!document.hidden) ref.current(); };
    document.addEventListener('visibilitychange', v);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', v); };
  }, [ms, ativo]);
}

function Titulo({ t, sub }) {
  return <div style={{ marginBottom: 12 }}><h1>{t}</h1>{sub && <p className="muted">{sub}</p>}</div>;
}

function contaHtml(tab) {
  const linhas = tab.items.filter((i) => i.status !== 'cancelled').map((i) => `<tr><td>${i.qty}x ${i.name.replace(/</g, '&lt;')}</td><td style="text-align:right">${brl(i.total)}</td></tr>`).join('');
  const t = tab.totals;
  return `<html><head><meta charset="utf-8"><title>Conta</title><style>body{font:13px monospace;width:280px;margin:8px}table{width:100%}hr{border:0;border-top:1px dashed #000}</style></head><body>
    <strong>${(tab.table_name || tab.label || 'Comanda').replace(/</g, '&lt;')}</strong><br>${new Date().toLocaleString('pt-BR')}<hr><table>${linhas}</table><hr>
    <table><tr><td>Subtotal</td><td style="text-align:right">${brl(t.subtotal)}</td></tr>
    ${t.fee ? `<tr><td>Serviço (${tab.fee_pct}%)</td><td style="text-align:right">${brl(t.fee)}</td></tr>` : ''}
    ${t.discount ? `<tr><td>Desconto</td><td style="text-align:right">-${brl(t.discount)}</td></tr>` : ''}
    <tr><td><strong>Total</strong></td><td style="text-align:right"><strong>${brl(t.total)}</strong></td></tr></table>
    ${tab.people > 1 ? `<hr>${tab.people} pessoas: ${brl(t.per_person)} cada` : ''}</body></html>`;
}
function imprimirConta(tab) {
  const w = window.open('', '_blank', 'width=360,height=600'); if (!w) return;
  w.document.write(contaHtml(tab)); w.document.close(); w.focus(); setTimeout(() => w.print(), 200);
}

// ======================= SALÃO (garçom) =======================
export function RstSalao() {
  const [mesas, setMesas] = useState(null);
  const [prontos, setProntos] = useState([]);
  const [tab, setTab] = useState(null);
  const [abrir, setAbrir] = useState(null);
  const [err, setErr] = useState('');
  const antes = useRef(0);
  const carregar = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([api('/restaurant/tables'), api('/restaurant/ready')]);
      setMesas(m); setProntos(p);
      if (p.length > antes.current) bip();
      antes.current = p.length;
      setErr('');
    } catch (e) { setErr(e.message); }
  }, []);
  useAuto(carregar, 8000, !tab);
  async function entregar(i) { try { await api(`/restaurant/items/${i.id}/status`, { method: 'POST', body: { status: 'served' } }); carregar(); } catch (e) { setErr(e.message); } }
  async function criar(e) {
    e.preventDefault(); setErr('');
    try {
      const t = await api('/restaurant/tabs', { method: 'POST', body: { table_id: abrir.table?.id || undefined, label: abrir.label || undefined, people: Number(abrir.people) || 1 } });
      setAbrir(null); setTab(t.id);
    } catch (e2) { setErr(e2.message); }
  }
  if (tab) return <Comanda id={tab} voltar={() => { setTab(null); carregar(); }} />;
  if (!mesas) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  return (
    <>
      <Titulo t="Salão" sub="Toque numa mesa livre para abrir a comanda, ou na sua para lançar pedidos." />
      {err && <div className="error">{err}</div>}
      {prontos.length > 0 && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--primary, #4caf50)' }}>
          <strong>Prontos para levar</strong>
          {prontos.map((i) => (
            <div key={i.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span><strong>{i.where}</strong> · {i.qty}× {i.name}{i.note ? <span className="muted"> ({i.note})</span> : ''}</span>
              <button className="btn sm primary" onClick={() => entregar(i)}>Entregue</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {mesas.tables.map((m) => {
          const t = m.tab;
          const minha = t?.mine;
          return (
            <button key={m.id} className="card" style={{ textAlign: 'left', cursor: 'pointer', opacity: t && !minha ? 0.65 : 1, borderColor: t?.ready ? 'var(--primary, #4caf50)' : undefined }}
              onClick={() => (t ? (minha ? setTab(t.id) : setErr(`${m.name} é de ${t.waiter_name}`)) : setAbrir({ table: m, people: 2, label: '' }))}>
              <strong>{m.name}</strong>
              <div className="muted" style={{ fontSize: 13 }}>{t ? `${t.waiter_name} · ${brl(t.subtotal)}` : `Livre · ${m.seats} lugares`}</div>
              {t?.ready > 0 && <div style={{ fontSize: 12 }}>{t.ready} pronto(s) para levar</div>}
            </button>
          );
        })}
      </div>
      {mesas.loose.length > 0 && <h3 style={{ marginTop: 16 }}>Comandas avulsas</h3>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {mesas.loose.map((t) => (
          <button key={t.id} className="card" style={{ textAlign: 'left', cursor: 'pointer', opacity: t.mine ? 1 : 0.65 }} onClick={() => (t.mine ? setTab(t.id) : setErr(`Esta comanda é de ${t.waiter_name}`))}>
            <strong>{t.label}</strong><div className="muted" style={{ fontSize: 13 }}>{t.waiter_name} · {brl(t.subtotal)}</div>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 14 }}><button className="btn" onClick={() => setAbrir({ table: null, people: 1, label: '' })}>+ Comanda avulsa (balcão, viagem)</button></div>
      {abrir && (
        <div className="modal-bg" onClick={() => setAbrir(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={criar} style={{ maxWidth: 360 }}>
            <h3>{abrir.table ? abrir.table.name : 'Comanda avulsa'}</h3>
            {!abrir.table && <div className="field"><label>Nome da comanda</label><input value={abrir.label} onChange={(e) => setAbrir({ ...abrir, label: e.target.value })} placeholder="Balcão, viagem, nome do cliente" required autoFocus /></div>}
            <div className="field"><label>Pessoas</label><input type="number" min="1" max="99" value={abrir.people} onChange={(e) => setAbrir({ ...abrir, people: e.target.value })} /></div>
            <div className="row"><button className="btn primary">Abrir comanda</button><button type="button" className="btn" onClick={() => setAbrir(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}

// ======================= COMANDA (garçom e caixa) =======================
function Comanda({ id, voltar, caixa = false }) {
  const [tab, setTab] = useState(null);
  const [err, setErr] = useState('');
  const [lancar, setLancar] = useState(false);
  const [pg, setPg] = useState({ method: 'pix', amount: '' });
  const [ajuste, setAjuste] = useState(null);
  const carregar = useCallback(() => api('/restaurant/tabs/' + id).then((t) => { setTab(t); setErr(''); }).catch((e) => setErr(e.message)), [id]);
  useAuto(carregar, 6000, !lancar);
  const agir = async (fn) => { setErr(''); try { await fn(); await carregar(); } catch (e) { setErr(e.message); } };
  if (!tab) return <>{err && <div className="error">{err}</div>}<button className="btn" onClick={voltar}>← Voltar</button></>;
  const aberta = tab.status === 'open';
  const t = tab.totals;
  const status = (i, s, extra) => agir(() => api(`/restaurant/items/${i.id}/status`, { method: 'POST', body: { status: s, ...extra } }));
  const cancelar = (i) => {
    const motivo = i.status === 'sent' && !caixa ? 'Cancelado pelo garçom' : window.prompt(`Motivo do cancelamento de "${i.name}":`);
    if (motivo) status(i, 'cancelled', { reason: motivo });
  };
  const pagar = (e) => { e.preventDefault(); agir(async () => { const v = pg.amount === '' ? t.remaining : pg.amount; await api(`/restaurant/tabs/${id}/payments`, { method: 'POST', body: { method: pg.method, amount: v } }); setPg({ ...pg, amount: '' }); }); };
  const encerrar = () => agir(async () => {
    try { await api(`/restaurant/tabs/${id}/close`, { method: 'POST', body: {} }); }
    catch (e) { if (/cozinha ou no bar/.test(e.message) && window.confirm(e.message)) await api(`/restaurant/tabs/${id}/close`, { method: 'POST', body: { force: true } }); else throw e; }
  });
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <button className="btn" onClick={voltar}>← Voltar</button>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => imprimirConta(tab)}>Imprimir conta</button>
          {aberta && <button className="btn primary" onClick={() => setLancar(true)}>+ Adicionar itens</button>}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{tab.table_name || tab.label || 'Comanda'}{tab.table_name && tab.label ? <span className="muted"> · {tab.label}</span> : ''}</h2>
        <div className="muted">Garçom: {tab.waiter_name} · aberta às {hora(tab.opened_at)} · {tab.people} pessoa(s){!aberta ? ` · ${tab.status === 'closed' ? 'encerrada' : 'cancelada'}` : ''}</div>
        {aberta && (
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button className="btn sm" onClick={() => { const n = Number(window.prompt('Quantas pessoas?', tab.people)); if (n) agir(() => api('/restaurant/tabs/' + id, { method: 'PUT', body: { people: n } })); }}>Mudar pessoas</button>
            <button className="btn sm" onClick={() => { const n = window.prompt('Nome da comanda:', tab.label || ''); if (n !== null) agir(() => api('/restaurant/tabs/' + id, { method: 'PUT', body: { label: n } })); }}>Nome</button>
          </div>
        )}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        {tab.items.length === 0 && <p className="muted">Nenhum item lançado ainda.</p>}
        {tab.items.map((i) => (
          <div key={i.id} className="row" style={{ justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)', opacity: i.status === 'cancelled' ? 0.5 : 1 }}>
            <div style={{ flex: 1 }}>
              <span style={{ textDecoration: i.status === 'cancelled' ? 'line-through' : 'none' }}><strong>{i.qty}×</strong> {i.name}</span> <span className="muted">{brl(i.total)}</span>
              {(opcoesTexto(i.options) || i.note) && <div className="muted" style={{ fontSize: 12 }}>{[opcoesTexto(i.options), i.note].filter(Boolean).join(' · ')}</div>}
              <div style={{ fontSize: 12 }}>{STATUS[i.status]}{i.cancel_reason ? ` — ${i.cancel_reason}` : ''}</div>
            </div>
            {aberta && (
              <div className="row" style={{ gap: 4, alignItems: 'flex-start' }}>
                {i.status === 'ready' && <button className="btn sm primary" onClick={() => status(i, 'served')}>Entregue</button>}
                {i.status !== 'cancelled' && (caixa || i.status === 'sent') && <button className="btn sm" onClick={() => cancelar(i)}>Cancelar</button>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><span>Subtotal</span><span>{brl(t.subtotal)}</span></div>
        <div className="row" style={{ justifyContent: 'space-between' }}><span>Serviço ({tab.fee_pct}%)</span><span>{brl(t.fee)}</span></div>
        {t.discount > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>Desconto</span><span>- {brl(t.discount)}</span></div>}
        <div className="row" style={{ justifyContent: 'space-between', fontSize: 18 }}><strong>Total</strong><strong>{brl(t.total)}</strong></div>
        {tab.people > 1 && <div className="muted">{tab.people} pessoas: {brl(t.per_person)} cada</div>}
        {t.paid > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>Pago</span><span>{brl(t.paid)}</span></div>}
        {caixa && aberta && t.remaining > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><strong>Falta</strong><strong>{brl(t.remaining)}</strong></div>}
      </div>
      {caixa && aberta && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <h3>Taxa de serviço e desconto</h3>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="field" style={{ width: 110 }}><label>Serviço (%)</label><input value={ajuste?.fee ?? tab.fee_pct} onChange={(e) => setAjuste({ ...(ajuste || {}), fee: e.target.value, desc: ajuste?.desc ?? tab.discount })} /></div>
              <div className="field" style={{ width: 130 }}><label>Desconto (R$)</label><input value={ajuste?.desc ?? tab.discount} onChange={(e) => setAjuste({ ...(ajuste || {}), desc: e.target.value, fee: ajuste?.fee ?? tab.fee_pct })} /></div>
              <button className="btn" disabled={!ajuste} onClick={() => agir(async () => { await api('/restaurant/tabs/' + id, { method: 'PUT', body: { fee_pct: ajuste.fee, discount: ajuste.desc } }); setAjuste(null); })}>Aplicar</button>
            </div>
          </div>
          <div className="card" style={{ marginBottom: 12 }}>
            <h3>Pagamento</h3>
            {tab.payments.map((p) => (
              <div key={p.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{METODOS[p.method]} · {brl(p.amount)}</span>
                <button className="btn sm" onClick={() => agir(() => api('/restaurant/payments/' + p.id, { method: 'DELETE' }))}>Remover</button>
              </div>
            ))}
            {t.remaining > 0 && (
              <form onSubmit={pagar} className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 6 }}>
                <div className="field"><label>Forma</label><select value={pg.method} onChange={(e) => setPg({ ...pg, method: e.target.value })}>{Object.entries(METODOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div className="field" style={{ width: 130 }}><label>Valor</label><input value={pg.amount} onChange={(e) => setPg({ ...pg, amount: e.target.value })} placeholder={t.remaining.toFixed(2).replace('.', ',')} /></div>
                {tab.people > 1 && <button type="button" className="btn sm" onClick={() => setPg({ ...pg, amount: String(Math.min(t.per_person, t.remaining)).replace('.', ',') })}>1 pessoa ({brl(Math.min(t.per_person, t.remaining))})</button>}
                <button className="btn primary">Registrar</button>
              </form>
            )}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button className="btn primary" disabled={t.remaining > 0.004} onClick={encerrar}>Encerrar comanda</button>
              {tab.payments.length === 0 && <button className="btn" onClick={() => { const m = window.prompt('Motivo do cancelamento da comanda:'); if (m) agir(async () => { await api(`/restaurant/tabs/${id}/cancel`, { method: 'POST', body: { reason: m } }); voltar(); }); }}>Cancelar comanda</button>}
            </div>
          </div>
        </>
      )}
      {lancar && <Lancar id={id} fechar={() => { setLancar(false); carregar(); }} />}
    </>
  );
}

// Escolha de itens do cardápio para lançar na comanda
function Lancar({ id, fechar }) {
  const [menu, setMenu] = useState(null);
  const [cat, setCat] = useState('');
  const [busca, setBusca] = useState('');
  const [carrinho, setCarrinho] = useState([]);
  const [escolher, setEscolher] = useState(null);
  const [err, setErr] = useState('');
  const [enviando, setEnviando] = useState(false);
  useEffect(() => { api('/restaurant/menu').then((m) => { setMenu(m); setCat(m.categories[0]?.id ?? ''); }).catch((e) => setErr(e.message)); }, []);
  if (!menu) return <div className="modal-bg"><div className="modal">{err ? <div className="error">{err}</div> : 'Carregando…'}</div></div>;
  const todos = menu.categories.flatMap((c) => c.items);
  const lista = busca.trim() ? todos.filter((i) => i.name.toLowerCase().includes(busca.trim().toLowerCase())) : (menu.categories.find((c) => c.id === cat)?.items || []);
  const soma = (l) => l.reduce((a, x) => a + (x.item.price + x.item.option_groups.flatMap((g) => g.options).filter((o) => x.options.includes(o.id)).reduce((b, o) => b + o.price_delta, 0)) * x.qty, 0);
  const tocar = (item) => {
    if (item.sold_out) return;
    if (item.option_groups.length) return setEscolher(item);
    const i = carrinho.findIndex((x) => x.item.id === item.id && !x.note && !x.options.length);
    setCarrinho(i >= 0 ? carrinho.map((x, k) => (k === i ? { ...x, qty: Math.min(99, x.qty + 1) } : x)) : [...carrinho, { item, qty: 1, options: [], note: '' }]);
  };
  const mudar = (k, d) => setCarrinho(carrinho.map((x, j) => (j === k ? { ...x, qty: x.qty + d } : x)).filter((x) => x.qty > 0));
  async function enviar() {
    setEnviando(true); setErr('');
    try { await api(`/restaurant/tabs/${id}/items`, { method: 'POST', body: { items: carrinho.map((x) => ({ item_id: x.item.id, qty: x.qty, options: x.options, note: x.note })) } }); fechar(); }
    catch (e) { setErr(e.message); setEnviando(false); }
  }
  return (
    <div className="modal-bg">
      <div className="modal" style={{ maxWidth: 560, maxHeight: '92vh', overflow: 'auto' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>Adicionar itens</h3><button className="btn sm" onClick={fechar}>Fechar</button></div>
        {err && <div className="error">{err}</div>}
        <input placeholder="Buscar item…" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ margin: '8px 0' }} />
        {!busca && <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>{menu.categories.map((c) => <button key={c.id ?? 'x'} className={'btn sm' + (cat === c.id ? ' primary' : '')} onClick={() => setCat(c.id)}>{c.name}</button>)}</div>}
        {lista.map((i) => (
          <button key={i.id} className="card" disabled={i.sold_out} onClick={() => tocar(i)} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 6, textAlign: 'left', cursor: 'pointer', opacity: i.sold_out ? 0.5 : 1 }}>
            <span>{i.name}{i.sold_out ? ' · esgotado' : ''}</span><span className="muted">{brl(i.price)}</span>
          </button>
        ))}
        {lista.length === 0 && <p className="muted">Nada encontrado.</p>}
        {carrinho.length > 0 && (
          <div className="card" style={{ marginTop: 10 }}>
            <strong>Para enviar</strong>
            {carrinho.map((x, k) => (
              <div key={k} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{x.qty}× {x.item.name}{(x.options.length || x.note) ? <span className="muted" style={{ fontSize: 12 }}> ({[x.item.option_groups.flatMap((g) => g.options).filter((o) => x.options.includes(o.id)).map((o) => o.name).join(', '), x.note].filter(Boolean).join(' · ')})</span> : ''}</span>
                <span className="row" style={{ gap: 4 }}><button className="btn sm" onClick={() => mudar(k, -1)}>−</button><button className="btn sm" onClick={() => mudar(k, 1)}>+</button></span>
              </div>
            ))}
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <strong>{brl(soma(carrinho))}</strong>
              <button className="btn primary" disabled={enviando} onClick={enviar}>Enviar pedido</button>
            </div>
          </div>
        )}
      </div>
      {escolher && <EscolherItem item={escolher} fechar={() => setEscolher(null)} ok={(x) => { setCarrinho([...carrinho, x]); setEscolher(null); }} />}
    </div>
  );
}

// ======================= COZINHA / BAR =======================
export function RstCozinha() {
  const [fila, setFila] = useState(null);
  const [est, setEst] = useState('');
  const [err, setErr] = useState('');
  const novos = useRef(0);
  const carregar = useCallback(async () => {
    try { const f = await api('/restaurant/kitchen' + (est ? '?station=' + est : '')); setFila(f); setErr(''); const n = f.filter((i) => i.status === 'sent').length; if (n > novos.current) bip(); novos.current = n; }
    catch (e) { setErr(e.message); }
  }, [est]);
  useAuto(carregar, 5000);
  const mover = async (i, status) => { try { await api(`/restaurant/items/${i.id}/status`, { method: 'POST', body: { status } }); carregar(); } catch (e) { setErr(e.message); } };
  const col = (status, titulo, proximo) => {
    const itens = (fila || []).filter((i) => i.status === status);
    return (
      <div style={{ flex: 1, minWidth: 260 }}>
        <h3>{titulo} <span className="muted">({itens.length})</span></h3>
        {itens.map((i) => {
          const min = minutosDesde(i.added_at);
          return (
            <div key={i.id} className="card" style={{ marginBottom: 8, borderColor: status !== 'ready' && min >= 15 ? '#c0392b' : undefined }}>
              <div className="row" style={{ justifyContent: 'space-between' }}><strong>{i.where}</strong><span className="muted" style={{ fontSize: 12 }}>{min} min · {i.waiter_name}</span></div>
              <div style={{ fontSize: 17, margin: '4px 0' }}><strong>{i.qty}×</strong> {i.name} {i.station === 'bar' && <span className="muted" style={{ fontSize: 12 }}>(bar)</span>}</div>
              {opcoesTexto(i.options) && <div className="muted">{opcoesTexto(i.options)}</div>}
              {i.note && <div style={{ fontWeight: 600 }}>⚠ {i.note}</div>}
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                {proximo.map(([s, txt, prim]) => <button key={s} className={'btn sm' + (prim ? ' primary' : '')} onClick={() => mover(i, s)}>{txt}</button>)}
              </div>
            </div>
          );
        })}
        {itens.length === 0 && <p className="muted">Nada aqui.</p>}
      </div>
    );
  };
  return (
    <>
      <Titulo t="Cozinha" sub="Os pedidos chegam sozinhos. Atualiza a cada poucos segundos." />
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {[['', 'Tudo'], ['cozinha', 'Cozinha'], ['bar', 'Bar']].map(([v, t]) => <button key={v} className={'btn sm' + (est === v ? ' primary' : '')} onClick={() => setEst(v)}>{t}</button>)}
      </div>
      {err && <div className="error">{err}</div>}
      {!fila ? <p className="muted">Carregando…</p> : (
        <div className="row" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {col('sent', 'Novos', [['preparing', 'Começar', false], ['ready', 'Pronto', true]])}
          {col('preparing', 'Preparando', [['ready', 'Pronto', true]])}
          {col('ready', 'Prontos', [['preparing', 'Voltar', false]])}
        </div>
      )}
    </>
  );
}

// ======================= CAIXA =======================
export function RstCaixa() {
  const [aba, setAba] = useState('abertas');
  const [lista, setLista] = useState(null);
  const [tab, setTab] = useState(null);
  const [de, setDe] = useState(hojeISO());
  const [err, setErr] = useState('');
  const carregar = useCallback(() => api(aba === 'abertas' ? '/restaurant/tabs' : `/restaurant/tabs?status=closed&from=${de}&to=${de}`).then((l) => { setLista(l); setErr(''); }).catch((e) => setErr(e.message)), [aba, de]);
  useAuto(carregar, 8000, !tab);
  if (tab) return <Comanda id={tab.id} caixa={tab.aberta} voltar={() => { setTab(null); carregar(); }} />;
  return (
    <>
      <Titulo t="Caixa" sub="Fechamento das contas: divisão entre pessoas, taxa de serviço, desconto e formas de pagamento." />
      <div className="row" style={{ gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={'btn sm' + (aba === 'abertas' ? ' primary' : '')} onClick={() => { setLista(null); setAba('abertas'); }}>Abertas</button>
        <button className={'btn sm' + (aba === 'fechadas' ? ' primary' : '')} onClick={() => { setLista(null); setAba('fechadas'); }}>Encerradas</button>
        {aba === 'fechadas' && <input type="date" value={de} onChange={(e) => { setLista(null); setDe(e.target.value); }} style={{ width: 'auto' }} />}
      </div>
      {err && <div className="error">{err}</div>}
      {!lista ? <p className="muted">Carregando…</p> : lista.length === 0 ? <p className="muted">{aba === 'abertas' ? 'Nenhuma comanda aberta.' : 'Nenhuma comanda encerrada neste dia.'}</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
          {lista.map((t) => (
            <button key={t.id} className="card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setTab({ id: t.id, aberta: aba === 'abertas' })}>
              <strong>{t.table_name || t.label || 'Comanda'}</strong>
              <div className="muted" style={{ fontSize: 13 }}>{t.waiter_name} · {t.people} pessoa(s)</div>
              <div>{brl(t.totals.total)}{aba === 'abertas' && t.totals.paid > 0 ? <span className="muted"> · falta {brl(t.totals.remaining)}</span> : ''}</div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ======================= GESTÃO =======================
export function RstGestao() {
  const [aba, setAba] = useState('cardapio');
  const abas = [['cardapio', 'Cardápio'], ['mesas', 'Mesas'], ['config', 'Taxa e comissão'], ['relatorio', 'Relatório']];
  return (
    <>
      <Titulo t="Gestão" sub="Cardápio, mesas, taxa de serviço, comissão dos garçons e relatório. O cardápio é o mesmo do Delivery." />
      <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {abas.map(([k, t]) => <button key={k} className={'btn sm' + (aba === k ? ' primary' : '')} onClick={() => setAba(k)}>{t}</button>)}
      </div>
      {aba === 'cardapio' && <Cardapio />}
      {aba === 'mesas' && <Mesas />}
      {aba === 'config' && <Config />}
      {aba === 'relatorio' && <Relatorio />}
    </>
  );
}

function Mesas() {
  const [lista, setLista] = useState(null);
  const [f, setF] = useState({ name: '', seats: 4 });
  const [lote, setLote] = useState({ prefix: 'Mesa', from: 1, to: 10, seats: 4 });
  const [err, setErr] = useState('');
  const carregar = () => api('/restaurant/table-defs').then(setLista).catch((e) => setErr(e.message));
  useEffect(() => { carregar(); }, []);
  const agir = async (fn) => { setErr(''); try { await fn(); carregar(); } catch (e) { setErr(e.message); } };
  return (
    <>
      {err && <div className="error">{err}</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Criar várias de uma vez</h3>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 120 }}><label>Nome</label><input value={lote.prefix} onChange={(e) => setLote({ ...lote, prefix: e.target.value })} /></div>
          <div className="field" style={{ width: 80 }}><label>De</label><input type="number" value={lote.from} onChange={(e) => setLote({ ...lote, from: e.target.value })} /></div>
          <div className="field" style={{ width: 80 }}><label>Até</label><input type="number" value={lote.to} onChange={(e) => setLote({ ...lote, to: e.target.value })} /></div>
          <div className="field" style={{ width: 90 }}><label>Lugares</label><input type="number" value={lote.seats} onChange={(e) => setLote({ ...lote, seats: e.target.value })} /></div>
          <button className="btn primary" onClick={() => agir(() => api('/restaurant/table-defs', { method: 'POST', body: { ...lote, from: Number(lote.from), to: Number(lote.to), seats: Number(lote.seats) } }))}>Criar mesas</button>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1 }}><label>Uma mesa (ex.: Varanda 1)</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field" style={{ width: 90 }}><label>Lugares</label><input type="number" value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} /></div>
          <button className="btn" onClick={() => agir(async () => { await api('/restaurant/table-defs', { method: 'POST', body: { name: f.name, seats: Number(f.seats) } }); setF({ name: '', seats: 4 }); })}>Adicionar</button>
        </div>
      </div>
      <div className="card">
        {!lista ? 'Carregando…' : lista.length === 0 ? <p className="muted">Nenhuma mesa ainda.</p> : lista.map((m) => (
          <div key={m.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', opacity: m.active ? 1 : 0.5 }}>
            <span>{m.name} <span className="muted">· {m.seats} lugares{m.active ? '' : ' · fora de uso'}</span></span>
            <span className="row" style={{ gap: 4 }}>
              <button className="btn sm" onClick={() => { const n = window.prompt('Novo nome:', m.name); if (n && n !== m.name) agir(() => api('/restaurant/table-defs/' + m.id, { method: 'PUT', body: { name: n } })); }}>Renomear</button>
              {m.active ? <button className="btn sm" onClick={() => window.confirm(`Tirar "${m.name}" de uso?`) && agir(() => api('/restaurant/table-defs/' + m.id, { method: 'DELETE' }))}>Remover</button>
                : <button className="btn sm" onClick={() => agir(() => api('/restaurant/table-defs/' + m.id, { method: 'PUT', body: { active: true } }))}>Reativar</button>}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Config() {
  const [c, setC] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('/restaurant/settings').then(setC).catch((e) => setErr(e.message)); }, []);
  if (!c) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  async function salvar(e) {
    e.preventDefault(); setErr(''); setMsg('');
    try { setC(await api('/restaurant/settings', { method: 'PUT', body: c })); setMsg('Salvo'); } catch (e2) { setErr(e2.message); }
  }
  return (
    <form className="card" onSubmit={salvar} style={{ maxWidth: 460 }}>
      {err && <div className="error">{err}</div>}{msg && <p>{msg}</p>}
      <div className="field"><label>Taxa de serviço padrão (%)</label><input value={c.service_fee_pct} onChange={(e) => setC({ ...c, service_fee_pct: e.target.value })} /></div>
      <p className="muted" style={{ marginTop: -4 }}>Entra em cada comanda nova. O caixa pode mudar ou tirar numa conta específica.</p>
      <div className="field"><label>Comissão do garçom (%)</label><input value={c.commission_pct} onChange={(e) => setC({ ...c, commission_pct: e.target.value })} /></div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, marginBottom: 10 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={c.commission_on_fee} onChange={(e) => setC({ ...c, commission_on_fee: e.target.checked })} /> A comissão também vale sobre a taxa de serviço
      </label>
      <button className="btn primary">Salvar</button>
    </form>
  );
}

function Relatorio() {
  const [de, setDe] = useState(hojeISO());
  const [ate, setAte] = useState(hojeISO());
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const carregar = useCallback(() => api(`/restaurant/report?from=${de}&to=${ate}`).then((x) => { setR(x); setErr(''); }).catch((e) => { setErr(e.message); setR(null); }), [de, ate]);
  useEffect(() => { carregar(); }, [carregar]);
  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field"><label>De</label><input type="date" value={de} onChange={(e) => setDe(e.target.value)} /></div>
        <div className="field"><label>Até</label><input type="date" value={ate} onChange={(e) => setAte(e.target.value)} /></div>
      </div>
      {err && <div className="error">{err}</div>}
      {r && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
            {[['Comandas', r.tabs], ['Vendas', brl(r.sales)], ['Taxa de serviço', brl(r.fee)], ['Descontos', brl(r.discounts)], ['Total recebido', brl(r.total)], ['Ticket médio', brl(r.average_ticket)], ['Comissões', brl(r.commission_total)]].map(([t, v]) => (
              <div key={t} className="card"><div className="muted" style={{ fontSize: 12 }}>{t}</div><strong style={{ fontSize: 18 }}>{v}</strong></div>
            ))}
          </div>
          <div className="card" style={{ marginBottom: 12 }}>
            <h3>Garçons</h3>
            {r.by_waiter.length === 0 ? <p className="muted">Sem vendas no período.</p> : (
              <table className="table"><thead><tr><th>Garçom</th><th>Comandas</th><th>Vendas</th><th>Serviço</th><th>Comissão ({r.settings.commission_pct}%)</th></tr></thead>
                <tbody>{r.by_waiter.map((w) => <tr key={w.waiter_id ?? w.name}><td>{w.name}</td><td>{w.tabs}</td><td>{brl(w.sales)}</td><td>{brl(w.fee)}</td><td>{brl(w.commission)}</td></tr>)}</tbody></table>
            )}
          </div>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div className="card" style={{ flex: 1, minWidth: 240 }}><h3>Formas de pagamento</h3>{r.by_method.length ? r.by_method.map((m) => <div key={m.method} className="row" style={{ justifyContent: 'space-between' }}><span>{m.name}</span><span>{brl(m.total)}</span></div>) : <p className="muted">—</p>}</div>
            <div className="card" style={{ flex: 1, minWidth: 240 }}><h3>Mais vendidos</h3>{r.top_items.length ? r.top_items.map((i) => <div key={i.name} className="row" style={{ justifyContent: 'space-between' }}><span>{i.qty}× {i.name}</span><span>{brl(i.total)}</span></div>) : <p className="muted">—</p>}</div>
            <div className="card" style={{ flex: 1, minWidth: 240 }}><h3>Por dia</h3>{r.by_day.length ? r.by_day.map((d) => <div key={d.day} className="row" style={{ justifyContent: 'space-between' }}><span>{d.day.split('-').reverse().join('/')} · {d.tabs} comanda(s)</span><span>{brl(d.total)}</span></div>) : <p className="muted">—</p>}</div>
          </div>
        </>
      )}
    </>
  );
}
