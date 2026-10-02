import React, { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { useSelecao, CelulaTodos, CelulaLinha, ApagarSelecionados, resumoApagado } from '../selecao.jsx';

const quando = (d) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const mesAtual = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const SITUACAO = {
  accepted: ['Aceito', 'var(--ok)'], review: ['Em análise', '#c27c0e'], duplicate: ['Duplicado', 'var(--bad)'], old: ['Data antiga', 'var(--bad)'],
  wrong_key: ['Chave diferente', 'var(--bad)'], low_amount: ['Valor menor', 'var(--bad)'], rejected: ['Recusado', 'var(--bad)'],
};
const TIPOS = { email: 'E-mail', phone: 'Telefone', cpf: 'CPF', cnpj: 'CNPJ', random: 'Chave aleatória' };

export default function Financeiro() {
  const [aba, setAba] = useState('recebimentos');
  return (
    <>
      <div style={{ marginBottom: 12 }}><h1>Financeiro</h1><p className="muted">Chaves Pix que valem para a conferência e os comprovantes recebidos.</p></div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['recebimentos', 'Recebimentos'], ['chaves', 'Chaves Pix'], ['ajustes', 'Ajustes']].map(([v, l]) => (
          <button key={v} className={'btn' + (aba === v ? ' primary' : '')} onClick={() => setAba(v)}>{l}</button>
        ))}
      </div>
      {aba === 'recebimentos' && <Recebimentos />}
      {aba === 'chaves' && <Chaves />}
      {aba === 'ajustes' && <Ajustes />}
    </>
  );
}

function Recebimentos() {
  const [mes, setMes] = useState(mesAtual());
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [aviso, setAviso] = useState('');
  const sel = useSelecao(rows);
  const load = () => {
    api(`/payments?month=${mes}${status ? '&status=' + status : ''}`).then(setRows).catch((e) => setAviso(e.message));
    api('/payments/summary?month=' + mes).then(setResumo).catch(() => {});
  };
  useEffect(() => { load(); }, [mes, status]);
  const acao = async (p, nome, texto) => {
    if (texto && !confirm(texto)) return;
    setAviso('');
    try { await api(`/payments/${p.id}/${nome}`, { method: 'POST', body: {} }); load(); } catch (e) { setAviso(e.message); }
  };
  return (
    <>
      <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <input type="month" value={mes} onChange={(e) => setMes(e.target.value || mesAtual())} style={{ maxWidth: 190 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">Todas as situações</option>
          {Object.entries(SITUACAO).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {resumo && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ gap: 22, flexWrap: 'wrap' }}>
            <div><div className="muted" style={{ fontSize: 12 }}>Recebido no mês</div><strong style={{ fontSize: 20 }}>{money(resumo.total)}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Aceitos</div><strong>{resumo.aceitos}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Em análise</div><strong style={{ color: resumo.em_analise ? '#c27c0e' : undefined }}>{resumo.em_analise}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Recusados</div><strong>{resumo.recusados}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Aceitos sem pedido ligado</div><strong>{resumo.sem_pedido}</strong></div>
          </div>
          {resumo.keys.length > 0 && (
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>Chave</th><th>Beneficiário</th><th>Recebimentos</th><th>Total</th></tr></thead>
              <tbody>
                {resumo.keys.map((k) => (
                  <tr key={k.id}><td>{k.key}{!k.active && <span className="muted"> (desativada)</span>}</td><td>{k.beneficiary || <span className="muted">—</span>}</td><td>{k.qtd}</td><td>{money(k.total)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {aviso && <div className="error">{aviso}</div>}
      <ApagarSelecionados s={sel} total={rows.length} rotulo="recebimento(s)" rota="/payments/bulk-delete"
        descreve={() => <p className="muted">Os pedidos já marcados como pagos continuam como estão; só o registro do comprovante é apagado.</p>}
        onDone={(r) => { setAviso(resumoApagado(r, 'recebimento(s)')); load(); }} />
      <div className="card table-wrap">
        <table>
          <thead><tr><CelulaTodos s={sel} /><th>Registrado em</th><th>Pagador</th><th>Valor</th><th>Chave</th><th>Cliente / pedido</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const [rot, cor] = SITUACAO[p.status] || [p.status, undefined];
              return (
                <tr key={p.id}>
                  <CelulaLinha s={sel} id={p.id} />
                  <td>{quando(p.created_at)}<div className="muted" style={{ fontSize: 12 }}>pago em {quando(p.paid_at)}</div></td>
                  <td>{p.payer_name || <span className="muted">—</span>}</td>
                  <td>{money(p.amount)}</td>
                  <td>{p.key_registered || p.key_text || <span className="muted">—</span>}{p.beneficiary ? <div className="muted" style={{ fontSize: 12 }}>{p.beneficiary}</div> : null}</td>
                  <td>{[p.customer_name, p.customer_last_name].filter(Boolean).join(' ') || <span className="muted">—</span>}{p.order_song ? <div className="muted" style={{ fontSize: 12 }}>{p.order_song}</div> : null}</td>
                  <td><span style={{ color: cor, fontWeight: 600 }}>{rot}</span>{p.reason && <div className="muted" style={{ fontSize: 12 }}>{p.reason}</div>}</td>
                  <td className="row">
                    {p.status !== 'accepted' && <button className="btn" onClick={() => acao(p, 'approve', 'Aceitar este comprovante mesmo assim?')}>Aceitar</button>}
                    {!['accepted', 'rejected'].includes(p.status) && <button className="btn bad" onClick={() => acao(p, 'reject')}>Recusar</button>}
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan="8" className="muted">Nenhum recebimento neste período.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Chaves() {
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const [aviso, setAviso] = useState('');
  const load = () => api('/finance/keys').then(setRows).catch((e) => setAviso(e.message));
  useEffect(() => { load(); }, []);
  const alternar = async (k) => { setAviso(''); try { await api('/finance/keys/' + k.id, { method: 'PUT', body: { active: !k.active } }); load(); } catch (e) { setAviso(e.message); } };
  const apagar = async (k) => {
    if (!confirm(`Apagar a chave ${k.key}? Os recebimentos já registrados continuam na lista. Se for só para não usar agora, prefira Desativar.`)) return;
    try { await api('/finance/keys/' + k.id, { method: 'DELETE' }); load(); } catch (e) { setAviso(e.message); }
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <p className="muted" style={{ margin: 0 }}>Só comprovantes pagos para uma chave <strong>ativa</strong> são aceitos. Sem nenhuma chave cadastrada, a chave não é conferida.</p>
        <button className="btn primary" onClick={() => setEdit({ key_type: 'email', key: '', beneficiary: '', note: '' })}>+ Nova chave</button>
      </div>
      {aviso && <div className="error">{aviso}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Chave</th><th>Tipo</th><th>Beneficiário</th><th>Anotação</th><th>Recebido</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.id} style={k.active ? undefined : { opacity: 0.6 }}>
                <td><strong>{k.key}</strong></td><td>{TIPOS[k.key_type]}</td>
                <td>{k.beneficiary || <span className="muted">—</span>}</td><td>{k.note || <span className="muted">—</span>}</td>
                <td>{money(k.received)}</td>
                <td><label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 'normal' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={k.active} onChange={() => alternar(k)} />{k.active ? 'Ativa' : 'Desativada'}</label></td>
                <td className="row">
                  <button className="btn" onClick={() => setEdit({ id: k.id, key_type: k.key_type, key: k.key, beneficiary: k.beneficiary || '', note: k.note || '' })}>Editar</button>
                  <button className="btn bad" onClick={() => apagar(k)}>Apagar</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="7" className="muted">Nenhuma chave cadastrada.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && <FormChave k={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setAviso(''); load(); }} />}
    </>
  );
}

function FormChave({ k, onClose, onSaved }) {
  const [f, setF] = useState(k);
  const [err, setErr] = useState('');
  const set = (c) => (e) => setF({ ...f, [c]: e.target.value });
  async function save(e) {
    e.preventDefault(); setErr('');
    try { await api(f.id ? '/finance/keys/' + f.id : '/finance/keys', { method: f.id ? 'PUT' : 'POST', body: { key_type: f.key_type, key: f.key, beneficiary: f.beneficiary, note: f.note } }); onSaved(); } catch (x) { setErr(x.message); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{f.id ? 'Editar chave Pix' : 'Nova chave Pix'}</h2>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>Tipo da chave *</label>
          <select value={f.key_type} onChange={set('key_type')}>{Object.entries(TIPOS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field"><label>Chave *</label><input value={f.key} maxLength={120} onChange={set('key')} required autoFocus /></div>
        <div className="field"><label>Beneficiário (quem recebe)</label><input value={f.beneficiary} maxLength={80} onChange={set('beneficiary')} /></div>
        <div className="field"><label>Anotação (opcional)</label><input value={f.note} maxLength={200} onChange={set('note')} placeholder="ex.: chave do show de sábado" /></div>
        <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}

function Ajustes() {
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('/finance/settings').then((s) => setF({ max_age_hours: s.max_age_hours, min_amount: s.min_amount ?? '' })).catch((e) => setErr(e.message)); }, []);
  const salvar = async () => {
    setErr(''); setMsg('');
    try { await api('/finance/settings', { method: 'PUT', body: { max_age_hours: Number(f.max_age_hours), min_amount: f.min_amount } }); setMsg('Ajustes salvos'); } catch (e) { setErr(e.message); }
  };
  if (!f) return err ? <div className="error">{err}</div> : null;
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      {err && <div className="error">{err}</div>}
      {msg && <div style={{ color: 'var(--ok)', marginBottom: 8 }}>{msg}</div>}
      <div className="field"><label>Idade máxima do comprovante (horas)</label>
        <input type="number" min="1" max="720" value={f.max_age_hours} onChange={(e) => setF({ ...f, max_age_hours: e.target.value })} style={{ maxWidth: 140 }} />
        <p className="muted" style={{ margin: '4px 0 0' }}>Comprovantes mais antigos que isso são recusados.</p></div>
      <div className="field"><label>Valor mínimo aceito (R$, opcional)</label>
        <input inputMode="decimal" value={f.min_amount} onChange={(e) => setF({ ...f, min_amount: e.target.value })} style={{ maxWidth: 140 }} placeholder="qualquer valor" />
        <p className="muted" style={{ margin: '4px 0 0' }}>Pagamentos abaixo desse valor são recusados.</p></div>
      <button className="btn primary" onClick={salvar}>Salvar</button>
    </div>
  );
}
