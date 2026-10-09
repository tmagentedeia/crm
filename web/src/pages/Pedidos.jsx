import React, { useEffect, useRef, useState } from 'react';
import { api, fmtPhone, money } from '../api.js';
import { rotulosDe, minusc } from '../rotulos.js';
import { useSelecao, CelulaTodos, CelulaLinha, ApagarSelecionados, resumoApagado } from '../selecao.jsx';

const quando = (d) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const paraInput = (d) => { if (!d) return ''; const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const nomeDe = (o) => [o.customer_name, o.customer_last_name].filter(Boolean).join(' ') || fmtPhone(o.customer_phone);
const COBRANCA = { franchise: 'Franquia', paid: 'Pago', courtesy: 'Cortesia' };
const mesLabel = (m) => { const [y, mo] = m.split('-'); return new Date(+y, +mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); };
const mesAtual = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

const rotuloLive = (l) => `${l.title ? l.title + ' · ' : ''}${quando(l.starts_at)}${l.open ? '' : ' (encerrada)'}`;
const OpcoesLive = ({ lives }) => lives.map((l) => <option key={l.id} value={l.id}>{rotuloLive(l)}</option>);

export default function Pedidos({ company }) {
  const L = rotulosDe(company, 'pedidos');
  const g = minusc(L.group), i = minusc(L.item);
  const [tab, setTab] = useState('pedidos');
  const [lives, setLives] = useState([]);
  const [liveId, setLiveId] = useState('');
  const [orders, setOrders] = useState([]);
  const [fila, setFila] = useState([]);
  const [mes, setMes] = useState(mesAtual());
  const [resumo, setResumo] = useState(null);
  const [novo, setNovo] = useState(false);
  const [edit, setEdit] = useState(null);
  const [liveEdit, setLiveEdit] = useState(null);
  const [aviso, setAviso] = useState('');
  const selOrders = useSelecao(orders);
  const selFila = useSelecao(fila);
  const selLives = useSelecao(lives);

  const loadLives = () => api('/lives').then((l) => {
    setLives(l);
    setLiveId((cur) => (cur && l.some((x) => String(x.id) === String(cur))) ? cur
      : String((l.filter((x) => x.open).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0] || l[0])?.id || ''));
  });
  const loadFila = () => api('/orders?queue=1').then(setFila);
  const loadOrders = () => (liveId ? api('/orders?live_id=' + liveId).then(setOrders) : setOrders([]));
  const loadResumo = () => api('/orders/summary?month=' + mes).then(setResumo);
  const tudo = () => { loadLives(); loadFila(); };
  useEffect(() => { tudo(); }, []);
  useEffect(() => { loadOrders(); }, [liveId]);
  useEffect(() => { if (tab === 'resumo') loadResumo(); }, [tab, mes]);
  const recarrega = () => { tudo(); loadOrders(); if (tab === 'resumo') loadResumo(); };
  // Pergunta a cada poucos segundos se algo mudou e só então recarrega (pedidos novos aparecem sem recarregar a página).
  // Pausa com a aba escondida e enquanto uma janela de edição está aberta.
  const recRef = useRef(recarrega); recRef.current = recarrega;
  const ocupado = !!(novo || edit || liveEdit);
  useEffect(() => {
    if (ocupado) return undefined;
    let ultima = null;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const { sig } = await api('/orders/changes');
        if (ultima !== null && sig === ultima) return;   // nada mudou
        ultima = sig;
        recRef.current();
      } catch { /* tenta de novo no próximo */ }
    };
    const id = setInterval(tick, 5000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [ocupado]);

  const atender = async (o, v) => {
    try { await api('/orders/' + o.id, { method: 'PUT', body: { served: v } }); loadOrders(); } catch (e) { setAviso(e.message); }
  };
  const atenderTodos = async () => {
    try { await api('/orders/serve-all', { method: 'POST', body: { live_id: liveId } }); loadOrders(); } catch (e) { setAviso(e.message); }
  };
  const pendentes = orders.filter((o) => !o.served_at).length;
  const live = lives.find((l) => String(l.id) === String(liveId));
  const apagar = async (o) => {
    if (!confirm(`Apagar "${o.song}"?`)) return;
    try { await api('/orders/' + o.id, { method: 'DELETE' }); recarrega(); } catch (e) { setAviso(e.message); }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div><h1>{L.items}</h1><p className="muted">{L.items} por {g}, franquia do programa de assinaturas e resumo do mês.</p></div>
        <button className="btn primary" onClick={() => setNovo(true)}>+ Anotar {i}</button>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['pedidos', L.items], ['fila', `${L.queue}${fila.length ? ` (${fila.length})` : ''}`], ['sugestoes', 'Sugestões'], ['resumo', 'Resumo do mês'], ['lives', L.groups]].map(([v, l]) => (
          <button key={v} className={'btn' + (tab === v ? ' primary' : '')} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>
      {aviso && <div className="error">{aviso}</div>}

      {tab === 'pedidos' && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <select value={liveId} onChange={(e) => setLiveId(e.target.value)} style={{ maxWidth: 360 }}>
              {!lives.length && <option value="">Nada cadastrado ainda</option>}
              {lives.map((l) => <option key={l.id} value={l.id}>{quando(l.starts_at)}{l.title ? ' · ' + l.title : ''}{l.open ? '' : ' (encerrada)'}</option>)}
            </select>
            {pendentes > 0 && <button className="btn" onClick={atenderTodos}>Marcar todos como atendidos ({pendentes})</button>}
            {live && <span className="muted">{live.orders} registro(s) · {live.franchise_count} pela franquia · {live.courtesy_count > 0 ? live.courtesy_count + ' cortesia(s) · ' : ''}{live.paid_count} pago(s) · recebido {money(live.received)}{live.awaiting_count > 0 && <strong style={{ color: 'var(--bad)' }}> · {live.awaiting_count} aguardando pagamento</strong>}</span>}
          </div>
          <ApagarSelecionados s={selOrders} total={orders.length} rotulo="registro(s)" rota="/orders/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, 'registro(s)')); recarrega(); }} />
          <TabelaPedidos L={L} rows={orders} sel={selOrders} vazio="Nada registrado aqui." onEdit={setEdit} onDel={apagar} onServe={atender} />
        </>
      )}

      {tab === 'fila' && (
        <>
          <p className="muted" style={{ marginBottom: 8 }}>Registros anotados sem {g} marcada. Quando você marcar a próxima, eles entram nela automaticamente, na ordem de chegada, e a franquia é definida nessa hora.</p>
          <ApagarSelecionados s={selFila} total={fila.length} rotulo="registro(s) da fila" rota="/orders/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, 'registro(s)')); recarrega(); }} />
          <TabelaPedidos L={L} rows={fila} sel={selFila} fila vazio="Ninguém aguardando." onEdit={setEdit} onDel={apagar} />
        </>
      )}

      {tab === 'sugestoes' && <Sugestoes L={L} onErro={setAviso} />}

      {tab === 'resumo' && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <input type="month" value={mes} onChange={(e) => setMes(e.target.value || mesAtual())} style={{ maxWidth: 190 }} />
            <span className="muted">{mesLabel(mes)}</span>
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Cliente</th><th>Nível</th><th>Franquia</th><th>Usada</th><th>Restam</th><th>Pagos</th><th>Total pago</th></tr></thead>
              <tbody>
                {resumo?.rows.map((r) => (
                  <tr key={r.customer_id}>
                    <td>{[r.name, r.last_name].filter(Boolean).join(' ') || fmtPhone(r.phone)}</td>
                    <td>{r.level_name || <span className="muted">—</span>}</td>
                    <td>{r.franchise}</td><td>{r.used}</td><td>{r.remaining}</td><td>{r.paid_count}</td><td>{money(r.paid_total)}</td>
                  </tr>
                ))}
                {resumo && !resumo.rows.length && <tr><td colSpan="7" className="muted">Nada registrado neste mês.</td></tr>}
              </tbody>
              {resumo?.rows.length > 0 && (
                <tfoot><tr><th colSpan="3">Total do mês</th><th>{resumo.totals.franchise}</th><th></th><th>{resumo.totals.paid}</th><th>{money(resumo.totals.paid_total)}</th></tr></tfoot>
              )}
            </table>
          </div>
          {resumo?.rows.length > 0 && <p className="muted" style={{ marginTop: 6 }}>{resumo.totals.orders} registro(s) no mês: {resumo.totals.franchise} pela franquia e {resumo.totals.paid} pago(s).</p>}
        </>
      )}

      {tab === 'lives' && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="btn primary" onClick={() => setLiveEdit({ title: '', starts_at: '', ends_at: '' })}>+ Marcar {g}</button>
          </div>
          <ApagarSelecionados s={selLives} total={lives.length} rotulo={`${g}(s)`} rota="/lives/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, `${g}(s)`)); recarrega(); }}
            descreve={() => <p className="muted">O que já tem registros não é apagado; apague os registros antes.</p>} />
          <div className="card table-wrap">
            <table>
              <thead><tr><CelulaTodos s={selLives} /><th>Quando</th><th>Título</th><th>Situação</th><th>{L.items}</th><th>Franquia</th><th>Pagos</th><th>Recebido</th><th></th></tr></thead>
              <tbody>
                {lives.map((l) => (
                  <tr key={l.id}>
                    <CelulaLinha s={selLives} id={l.id} />
                    <td>{quando(l.starts_at)}</td><td>{l.title || <span className="muted">—</span>}</td>
                    <td><span className="badge">{l.open ? 'Aberta' : 'Encerrada'}</span></td><td>{l.orders}</td>
                    <td>{l.franchise_count}</td>
                    <td>{l.paid_count}{l.awaiting_count > 0 && <span className="muted"> ({l.awaiting_count} aguardando)</span>}</td>
                    <td>{money(l.received)}</td>
                    <td className="row">
                      <button className="btn" onClick={() => setLiveEdit({ id: l.id, title: l.title || '', starts_at: paraInput(l.starts_at), ends_at: paraInput(l.ends_at) })}>Editar</button>
                      {l.open
                        ? <button className="btn" onClick={() => api(`/lives/${l.id}/close`, { method: 'POST' }).then(recarrega)}>Encerrar</button>
                        : <button className="btn" onClick={() => api(`/lives/${l.id}/reopen`, { method: 'POST' }).then(recarrega)}>Reabrir</button>}
                      <button className="btn bad" onClick={async () => { if (!confirm('Apagar?')) return; try { await api('/lives/' + l.id, { method: 'DELETE' }); recarrega(); } catch (e) { setAviso(e.message); } }}>Apagar</button>
                    </td>
                  </tr>
                ))}
                {!lives.length && <tr><td colSpan="9" className="muted">Nada cadastrado ainda. Sem isso marcado, os registros ficam na fila.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>Fica aberto até o fim do dia (ou até o horário de fim, se você informar). Os registros novos entram na próxima que estiver aberta.</p>
        </>
      )}

      {novo && <NovoPedido L={L} lives={lives} onClose={() => setNovo(false)} onSaved={() => { recarrega(); }} />}
      {edit && <EditarPedido L={L} lives={lives} o={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); recarrega(); }} />}
      {liveEdit && <FormLive L={L} l={liveEdit} onClose={() => setLiveEdit(null)} onSaved={(r) => { setLiveEdit(null); setAviso(''); recarrega(); if (r?.attached?.length) alert(`${r.attached.length} registro(s) da fila entraram.`); }} />}
    </>
  );
}

function TabelaPedidos({ L, rows, sel, fila, vazio, onEdit, onDel, onServe }) {
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr><CelulaTodos s={sel} /><th>Cliente</th><th>{L.song}</th><th>{L.dedication}</th><th>Nível</th>{!fila && <th>Cobrança</th>}<th>Anotado em</th><th></th></tr></thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} style={!fila && !o.served_at ? { background: 'color-mix(in srgb, var(--primary-soft) 45%, transparent)', boxShadow: 'inset 3px 0 0 var(--primary)' } : (!fila ? { opacity: .6 } : undefined)}>
              <CelulaLinha s={sel} id={o.id} />
              <td>{nomeDe(o)}</td><td>{o.song}</td><td>{o.dedication || <span className="muted">—</span>}</td>
              <td>{o.level_name || <span className="muted">—</span>}</td>
              {!fila && <td><span className="badge">{o.kind === 'paid' && o.amount_paid == null ? 'Aguardando pagamento' : (COBRANCA[o.kind] || '—') + (o.kind === 'paid' ? ' · ' + money(o.amount_paid) : '')}</span></td>}
              <td>{quando(o.created_at)}</td>
              <td className="row">{!fila && onServe && (o.served_at ? <button className="btn" title="Clique para desmarcar" onClick={() => onServe(o, false)}>✓ Atendido</button> : <button className="btn primary" onClick={() => onServe(o, true)}>Atendido</button>)}<button className="btn" onClick={() => onEdit(o)}>Editar</button><button className="btn bad" onClick={() => onDel(o)}>Apagar</button></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan="8" className="muted">{vazio}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// Em qual chave Pix o valor entrou (todo lançamento financeiro tem chave)
function ChavePix({ value, onChange, obrigatoria, vazio }) {
  const [chaves, setChaves] = useState([]);
  useEffect(() => { api('/finance/keys').then((k) => setChaves(k.filter((x) => x.active))).catch(() => {}); }, []);
  return (
    <div className="field"><label>Chave Pix que recebeu{obrigatoria ? ' *' : ''}</label>
      <select value={value} onChange={onChange} required={obrigatoria}>
        <option value="">{vazio || 'Escolha a chave'}</option>
        {chaves.map((k) => <option key={k.id} value={k.id}>{k.key}{k.beneficiary ? ` · ${k.beneficiary}` : ''}</option>)}
      </select></div>
  );
}

function NovoPedido({ L, lives, onClose, onSaved }) {
  const [f, setF] = useState({ phone: '', name: '', song: '', dedication: '', amount_paid: '', kind: '', live_id: '', pix_key_id: '' });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setErr(''); setOk(null);
    try {
      const r = await api('/orders', { method: 'POST', body: { ...f, amount_paid: f.amount_paid === '' || f.kind === 'franchise' || f.kind === 'courtesy' ? null : f.amount_paid } });
      setOk(r); onSaved(); setF({ ...f, song: '', dedication: '', amount_paid: '', pix_key_id: '' });
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Anotar {minusc(L.item)}</h2>
        {err && <div className="error">{err}</div>}
        {ok && (
          <p className="muted" style={{ marginBottom: 8 }}>
            {ok.status === 'queued' ? 'Anotado na fila: nada marcado ainda.'
              : `Anotado para ${quando(ok.live.starts_at)} · ${ok.kind === 'franchise' ? 'pela franquia' : ok.kind === 'courtesy' ? 'cortesia' : 'pago'}.`}
            {ok.balance.franchise > 0 ? ` Franquia do mês: ${ok.balance.used} de ${ok.balance.franchise}.` : ''}
          </p>
        )}
        <div className="field"><label>Telefone (com DDD)</label><input value={f.phone} onChange={set('phone')} /></div>
        <div className="field"><label>{f.phone.trim() ? 'Nome (se for cliente novo)' : 'Nome *'}</label><input value={f.name} onChange={set('name')} required={!f.phone.trim()} /></div>
        <div className="field"><label>{L.song} *</label><input value={f.song} onChange={set('song')} required /></div>
        <div className="field"><label>{L.dedication}</label><input value={f.dedication} onChange={set('dedication')} /></div>
        <div className="field"><label>{L.group}</label>
          <select value={f.live_id} onChange={set('live_id')}>
            <option value="">Automático (próxima que ainda não terminou; sem nenhuma, fica na fila)</option>
            <OpcoesLive lives={lives} />
          </select></div>
        <div className="field"><label>Modo de pagamento</label>
          <select value={f.kind} onChange={set('kind')}>
            <option value="">Automático (franquia, se tiver; senão pago)</option>
            <option value="franchise">Pela franquia</option>
            <option value="paid">Pago</option>
            <option value="courtesy">Cortesia</option>
          </select></div>
        {f.kind !== 'franchise' && f.kind !== 'courtesy' && (
          <div className="field"><label>Valor pago (R$)</label><input inputMode="decimal" value={f.amount_paid} onChange={set('amount_paid')} placeholder="só se for cobrado" /></div>
        )}
        {f.kind !== 'franchise' && f.kind !== 'courtesy' && Number(String(f.amount_paid).replace(',', '.')) > 0 && <ChavePix value={f.pix_key_id} onChange={set('pix_key_id')} obrigatoria />}
        <div className="row"><button className="btn primary">Anotar</button><button type="button" className="btn" onClick={onClose}>Fechar</button></div>
      </form>
    </div>
  );
}

function EditarPedido({ L, lives, o, onClose, onSaved }) {
  const [f, setF] = useState({ song: o.song, dedication: o.dedication || '', amount_paid: o.amount_paid ?? '', kind: o.kind || '', live_id: o.live_id ? String(o.live_id) : '', pix_key_id: '' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setErr('');
    try {
      const body = { song: f.song, dedication: f.dedication, amount_paid: f.amount_paid === '' ? null : f.amount_paid };
      const moveu = f.live_id && String(f.live_id) !== String(o.live_id || '');
      if (moveu) body.live_id = f.live_id;
      if (f.pix_key_id) body.pix_key_id = f.pix_key_id;
      if (o.live_id && f.kind && f.kind !== o.kind) body.kind = f.kind;
      await api('/orders/' + o.id, { method: 'PUT', body }); onSaved();
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Editar {minusc(L.item)}</h2>
        <p className="muted">{nomeDe(o)}</p>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>{L.song}</label><input value={f.song} onChange={set('song')} required /></div>
        <div className="field"><label>{L.dedication}</label><input value={f.dedication} onChange={set('dedication')} /></div>
        <div className="field"><label>{L.group}</label>
          <select value={f.live_id} onChange={set('live_id')}>
            {!o.live_id && <option value="">Continuar na fila</option>}
            <OpcoesLive lives={lives} />
          </select>
          {!o.live_id && <span className="muted">Escolha {minusc(L.group)} para tirar da fila; a cobrança é definida por ela.</span>}
        </div>
        {o.live_id && (
          <div className="row">
            <div className="field"><label>Cobrança</label>
              <select value={f.kind} onChange={set('kind')}><option value="franchise">Franquia</option><option value="courtesy">Cortesia</option><option value="paid">Pago</option></select></div>
            <div className="field"><label>Valor pago (R$)</label><input inputMode="decimal" value={f.amount_paid} onChange={set('amount_paid')} /></div>
          </div>
        )}
        {o.live_id && f.kind === 'paid' && Number(String(f.amount_paid).replace(',', '.')) > 0 && <ChavePix value={f.pix_key_id} onChange={set('pix_key_id')} vazio="Manter a atual" />}
        <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}

function FormLive({ L, l, onClose, onSaved }) {
  const [f, setF] = useState(l);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setErr('');
    try {
      const body = { title: f.title, starts_at: f.starts_at ? new Date(f.starts_at).toISOString() : '', ends_at: f.ends_at ? new Date(f.ends_at).toISOString() : null };
      const r = f.id ? await api('/lives/' + f.id, { method: 'PUT', body }) : await api('/lives', { method: 'POST', body });
      onSaved(r);
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{f.id ? 'Editar' : 'Marcar'} {minusc(L.group)}</h2>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>Título (opcional)</label><input value={f.title} onChange={set('title')} /></div>
        <div className="field"><label>Começa em *</label><input type="datetime-local" value={f.starts_at} onChange={set('starts_at')} required /></div>
        <div className="field"><label>Termina em (opcional)</label><input type="datetime-local" value={f.ends_at} onChange={set('ends_at')} /></div>
        <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}

function Sugestoes({ L, onErro }) {
  const [lista, setLista] = useState([]);
  const [musica, setMusica] = useState('');
  const [aviso, setAviso] = useState('');
  const sel = useSelecao(lista);
  const carrega = () => api('/suggestions').then(setLista).catch((e) => onErro(e.message));
  useEffect(() => { carrega(); }, []);
  async function adicionar(e) {
    e.preventDefault();
    if (!musica.trim()) return;
    try { await api('/suggestions', { method: 'POST', body: { song: musica } }); setMusica(''); setAviso(''); carrega(); onErro(''); } catch (e2) { setAviso(e2.message); }
  }
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <p className="muted">Digite uma música por vez. Ela entra na lista de sugestões e fica lá, junto com as anteriores, até alguém pedir. Quem pedir sugestão recebe uma de cada vez; a que for escolhida vira pedido e sai daqui.</p>
        <form className="row" onSubmit={adicionar} style={{ gap: 8 }}>
          <input style={{ flex: 1 }} value={musica} onChange={(e) => { setMusica(e.target.value); setAviso(''); }} placeholder="Nome da música" maxLength={200} />
          <button className="btn primary">Adicionar</button>
        </form>
        {aviso && <p className="error" style={{ marginTop: 6 }}>{aviso}</p>}
      </div>
      <ApagarSelecionados s={sel} total={lista.length} rotulo="sugestão(ões)" rota="/suggestions/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, 'sugestão(ões)')); carrega(); }} />
      <div className="card table-wrap">
        <table>
          <thead><tr><CelulaTodos s={sel} /><th>Sugestão</th><th>Já oferecida</th><th></th></tr></thead>
          <tbody>
            {lista.map((x) => (
              <tr key={x.id}><CelulaLinha s={sel} id={x.id} /><td>{x.song}</td><td>{x.offered}x</td>
                <td><button className="btn bad" onClick={() => api('/suggestions/' + x.id, { method: 'DELETE' }).then(carrega).catch((e) => onErro(e.message))}>Tirar</button></td></tr>
            ))}
            {!lista.length && <tr><td colSpan="4" className="muted">Nenhuma sugestão cadastrada.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
