import React, { useEffect, useState } from 'react';
import { api, fmtDate, fmtPhone, fmtTime, money } from '../api.js';

const STATUS = { scheduled: 'Agendado', attended: 'Compareceu', no_show: 'Faltou', cancelled: 'Cancelado' };

export default function Clientes() {
  const [tab, setTab] = useState('');
  const [search, setSearch] = useState('');
  const [list, setList] = useState([]);
  const [detail, setDetail] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = () => api(`/customers?status=${tab}&search=${encodeURIComponent(search)}`).then(setList);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [tab, search]);

  const open = (id) => api('/customers/' + id).then(setDetail);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1>Clientes e Leads</h1><p className="muted">Lead = só conversou · Cliente = já compareceu</p></div>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Cadastrar cliente ou lead</button>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['', 'Todos'], ['lead', 'Leads'], ['client', 'Clientes']].map(([v, l]) => (
          <button key={v} className={'btn' + (tab === v ? ' primary' : '')} onClick={() => setTab(v)}>{l}</button>
        ))}
        <input placeholder="Buscar por nome ou telefone…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Nome</th><th>Telefone</th><th>Tipo</th><th>Origem</th><th>Última visita</th></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className="click" onClick={() => open(c.id)}>
                <td>{c.name || <span className="muted">Sem nome</span>}</td>
                <td>{fmtPhone(c.phone)}</td>
                <td><span className={'badge ' + c.status}>{c.status === 'client' ? 'Cliente' : 'Lead'}</span></td>
                <td>{c.source === 'ia' ? 'Agente IA' : 'Manual'}</td>
                <td>{fmtDate(c.last_visit_at)}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan="5" className="muted">Nada encontrado.</td></tr>}
          </tbody>
        </table>
      </div>
      {detail && <Detail c={detail} onClose={() => setDetail(null)} onSaved={() => { load(); open(detail.id); }} onDeleted={() => { setDetail(null); load(); }} />}
      {adding && <AddCustomer onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </>
  );
}

function Detail({ c, onClose, onSaved, onDeleted }) {
  const [f, setF] = useState({ name: c.name || '', phone: c.phone || '', status: c.status, notes: c.notes || '' });
  const [err, setErr] = useState('');
  const attended = c.history.filter((h) => h.status === 'attended');
  const future = c.history.filter((h) => h.status === 'scheduled' && new Date(h.starts_at) > new Date()).length;
  const save = async () => {
    setErr('');
    try { await api('/customers/' + c.id, { method: 'PUT', body: f }); onSaved(); } catch (e) { setErr(e.message); }
  };
  const remove = async () => {
    const extra = c.history.length ? ` Isso também apaga ${c.history.length} agendamento(s) do histórico${future ? ` (${future} ainda por vir)` : ''}.` : '';
    if (!confirm(`Excluir ${c.name || 'este contato'}?${extra} Não dá para desfazer.`)) return;
    try { await api('/customers/' + c.id, { method: 'DELETE' }); onDeleted(); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{c.name || 'Sem nome'}</h2><span className={'badge ' + c.status}>{c.status === 'client' ? 'Cliente' : 'Lead'}</span>
        </div>
        <p className="muted">{fmtPhone(c.phone)} · primeiro contato em {fmtDate(c.first_contact_at)} · {attended.length} visita(s) · gasto total {money(attended.reduce((s, h) => s + Number(h.price), 0))}</p>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>Nome</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="row">
          <div className="field" style={{ flex: 2 }}><label>Telefone (com DDD)</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div className="field"><label>Tipo</label>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="lead">Lead</option><option value="client">Cliente</option>
            </select></div>
        </div>
        <div className="field"><label>Observações</label><textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        <div className="row" style={{ marginBottom: 14 }}>
          <button className="btn primary" onClick={save}>Salvar</button>
          <a className="btn" href={'https://wa.me/' + c.phone} target="_blank" rel="noreferrer">WhatsApp</a>
          <button className="btn bad" style={{ marginLeft: 'auto' }} onClick={remove}>Excluir</button>
        </div>
        <h2>Histórico</h2>
        {c.history.length ? (
          <table><tbody>{c.history.map((h, i) => (
            <tr key={i}><td>{fmtDate(h.starts_at)} {fmtTime(h.starts_at)}</td><td>{h.service}</td><td>{h.barber}</td><td><span className={'badge ' + h.status}>{STATUS[h.status]}</span></td></tr>
          ))}</tbody></table>
        ) : <p className="muted">Sem agendamentos ainda.</p>}
      </div>
    </div>
  );
}

function AddCustomer({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', phone: '', status: 'client', notes: '' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    try { await api('/customers', { method: 'POST', body: { ...f, source: 'manual' } }); onSaved(); }
    catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Cadastrar cliente ou lead</h2>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>Nome</label><input value={f.name} onChange={set('name')} required /></div>
        <div className="field"><label>Telefone (com DDD)</label><input value={f.phone} onChange={set('phone')} required /></div>
        <div className="field"><label>Tipo</label>
          <select value={f.status} onChange={set('status')}><option value="client">Cliente</option><option value="lead">Lead</option></select></div>
        <div className="field"><label>Observações</label><textarea rows={2} value={f.notes} onChange={set('notes')} /></div>
        <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}
