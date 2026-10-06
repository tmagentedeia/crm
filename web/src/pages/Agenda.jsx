import React, { useEffect, useState, useCallback } from 'react';
import { Nome } from '../menu.jsx';
import { api, fmtTime, money } from '../api.js';
import { useSelecao, ApagarSelecionados, resumoApagado } from '../selecao.jsx';

const STATUS = { pending: 'Aguardando confirmação', scheduled: 'Agendado', attended: 'Compareceu', no_show: 'Faltou', cancelled: 'Cancelado' };
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const shift = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export default function Agenda() {
  const [date, setDate] = useState(todayStr());
  const [professionals, setProfessionals] = useState([]);
  const [appts, setAppts] = useState([]);
  const [modal, setModal] = useState(null);
  const sel = useSelecao(appts);
  const [aviso, setAviso] = useState('');

  const load = useCallback(async () => {
    const from = new Date(date + 'T00:00:00').toISOString();
    const to = new Date(shift(date, 1) + 'T00:00:00').toISOString();
    const [b, a] = await Promise.all([api('/professionals'), api(`/appointments?from=${from}&to=${to}`)]);
    setProfessionals(b.filter((x) => x.active));
    setAppts(a);
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (id, status) => { await api(`/appointments/${id}/status`, { method: 'PATCH', body: { status } }); load(); };
  const responder = async (id, decision) => {
    try { await api(`/appointments/${id}/respond`, { method: 'POST', body: { decision } }); } catch (e) { alert(e.data?.ja_respondido ? 'Esse horário já foi respondido (pelo WhatsApp ou por outra pessoa). A agenda foi atualizada.' : e.message); }
    load();
  };
  const remove = async (id) => { if (confirm('Excluir este agendamento?')) { await api('/appointments/' + id, { method: 'DELETE' }); load(); } };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1><Nome id="agenda">Agenda</Nome></h1><p className="muted">Uma agenda individual por profissional</p></div>
        <div className="row">
          <button className="btn" onClick={() => setDate(shift(date, -1))}>←</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 'auto' }} />
          <button className="btn" onClick={() => setDate(shift(date, 1))}>→</button>
          <button className="btn" onClick={() => setDate(todayStr())}>Hoje</button>
          <button className="btn primary" onClick={() => setModal({ professional_id: professionals[0]?.id })}>+ Agendar</button>
        </div>
      </div>
      {aviso && <p className="muted" style={{ marginBottom: 8 }}>{aviso}</p>}
      {appts.length > 0 && (
        <label className="row" style={{ gap: 8, marginBottom: 8 }}>
          <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={sel.todos} onChange={sel.alternarTodos} />
          <span className="muted">Selecionar todos os agendamentos deste dia</span>
        </label>
      )}
      <ApagarSelecionados s={sel} total={appts.length} rotulo="agendamento(s)" rota="/appointments/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, 'agendamento(s)')); load(); }}
        descreve={() => <p>Os horários ficam livres e, se houver fila de espera, o primeiro da fila é avisado.</p>} />
      {!professionals.length && <div className="card muted">Cadastre um profissional para começar a usar a agenda.</div>}
      <div className="agenda">
        {professionals.map((b) => {
          const mine = appts.filter((a) => a.professional_id === b.id);
          return (
            <div className="card" key={b.id} style={{ borderTop: `4px solid ${b.color}` }}>
              <div className="col-head"><span className="dot" style={{ background: b.color }} />{b.name}
                <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setModal({ professional_id: b.id })}>+</button>
              </div>
              {mine.map((a) => (
                <div key={a.id} className={'appt' + (a.status !== 'scheduled' && a.status !== 'pending' ? ' done' : '')} style={{ borderLeftColor: b.color }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={sel.has(a.id)} onChange={() => sel.toggle(a.id)} aria-label="Selecionar" />
                    <span className="t">{fmtTime(a.starts_at)}–{fmtTime(a.ends_at)}</span>
                    <span className={'badge ' + a.status}>{STATUS[a.status]}</span>
                    {a.reminder_sent_at && <span title="Lembrete enviado ao cliente">🔔</span>}
                  </div>
                  <div>{a.customer_name || a.customer_phone}</div>
                  <div className="muted">{a.service_name} · {money(a.price)}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    {a.status === 'pending' && <><button className="btn sm ok" onClick={() => responder(a.id, 'confirm')}>Confirmar</button><button className="btn sm bad" onClick={() => responder(a.id, 'reject')}>Recusar</button></>}
                    {a.status === 'scheduled' && <button className="btn sm" onClick={() => setStatus(a.id, 'cancelled')}>Cancelar</button>}
                    {a.status !== 'pending' && a.status !== 'attended' && <button className="btn sm ok" onClick={() => setStatus(a.id, 'attended')}>Compareceu</button>}
                    {a.status !== 'pending' && a.status !== 'no_show' && <button className="btn sm bad" onClick={() => setStatus(a.id, 'no_show')}>Faltou</button>}
                    {a.status !== 'pending' && a.status !== 'scheduled' && <button className="btn sm" onClick={() => setStatus(a.id, 'scheduled')}>Reabrir</button>}
                    <button className="btn sm" onClick={() => remove(a.id)}>Excluir</button>
                  </div>
                </div>
              ))}
              {!mine.length && <p className="muted">Sem agendamentos neste dia.</p>}
            </div>
          );
        })}
      </div>
      {modal && <NewAppointment init={modal} date={date} professionals={professionals} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    </>
  );
}

function NewAppointment({ init, date, professionals, onClose, onSaved }) {
  const [customers, setCustomers] = useState([]);
  const [services, setServices] = useState([]);
  const [f, setF] = useState({ professional_id: init.professional_id, customer_id: '', service_id: '', time: '09:00', name: '', phone: '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/customers').then(setCustomers);
    api('/services').then((s) => setServices(s.filter((x) => x.active)));
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function save(e) {
    e.preventDefault(); setErr('');
    try {
      let customer_id = f.customer_id;
      if (customer_id === 'new') {
        const c = await api('/customers', { method: 'POST', body: { name: f.name, phone: f.phone, source: 'manual' } });
        customer_id = c.id;
      }
      const starts_at = new Date(`${date}T${f.time}:00`).toISOString();
      await api('/appointments', { method: 'POST', body: { professional_id: Number(f.professional_id), customer_id: Number(customer_id), service_id: Number(f.service_id), starts_at } });
      onSaved();
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Novo agendamento</h2>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>Profissional</label>
          <select value={f.professional_id} onChange={set('professional_id')} required>{professionals.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="field"><label>Serviço</label>
          <select value={f.service_id} onChange={set('service_id')} required><option value="">Selecione…</option>
            {services.filter((s) => { const b = professionals.find((x) => String(x.id) === String(f.professional_id)); return !b || (b.does_service_ids || []).map(String).includes(String(s.id)); }).map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.price)} ({s.duration_min} min)</option>)}</select></div>
        <div className="field"><label>Cliente</label>
          <select value={f.customer_id} onChange={set('customer_id')} required><option value="">Selecione…</option>
            <option value="new">➕ Novo cliente (presencial)</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{[c.name, c.last_name].filter(Boolean).join(' ') || 'Sem nome'} — {c.phone}</option>)}</select></div>
        {f.customer_id === 'new' && (
          <div className="row">
            <div className="field"><label>Nome</label><input value={f.name} onChange={set('name')} required /></div>
            <div className="field"><label>Telefone (com DDD)</label><input value={f.phone} onChange={set('phone')} required /></div>
          </div>
        )}
        <div className="field"><label>Horário ({date.split('-').reverse().join('/')})</label><input type="time" value={f.time} onChange={set('time')} required /></div>
        <div className="row"><button className="btn primary">Agendar</button><button type="button" className="btn" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}
