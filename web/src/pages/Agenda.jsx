import React, { useEffect, useState, useCallback } from 'react';
import { api, fmtTime, money } from '../api.js';

const STATUS = { scheduled: 'Agendado', attended: 'Compareceu', no_show: 'Faltou', cancelled: 'Cancelado' };
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const shift = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export default function Agenda() {
  const [date, setDate] = useState(todayStr());
  const [barbers, setBarbers] = useState([]);
  const [appts, setAppts] = useState([]);
  const [modal, setModal] = useState(null);

  const load = useCallback(async () => {
    const from = new Date(date + 'T00:00:00').toISOString();
    const to = new Date(shift(date, 1) + 'T00:00:00').toISOString();
    const [b, a] = await Promise.all([api('/barbers'), api(`/appointments?from=${from}&to=${to}`)]);
    setBarbers(b.filter((x) => x.active));
    setAppts(a);
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (id, status) => { await api(`/appointments/${id}/status`, { method: 'PATCH', body: { status } }); load(); };
  const remove = async (id) => { if (confirm('Excluir este agendamento?')) { await api('/appointments/' + id, { method: 'DELETE' }); load(); } };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1>Agenda</h1><p className="muted">Uma agenda individual por profissional</p></div>
        <div className="row">
          <button className="btn" onClick={() => setDate(shift(date, -1))}>←</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 'auto' }} />
          <button className="btn" onClick={() => setDate(shift(date, 1))}>→</button>
          <button className="btn" onClick={() => setDate(todayStr())}>Hoje</button>
          <button className="btn primary" onClick={() => setModal({ barber_id: barbers[0]?.id })}>+ Agendar</button>
        </div>
      </div>
      {!barbers.length && <div className="card muted">Cadastre um profissional para começar a usar a agenda.</div>}
      <div className="agenda">
        {barbers.map((b) => {
          const mine = appts.filter((a) => a.barber_id === b.id);
          return (
            <div className="card" key={b.id} style={{ borderTop: `4px solid ${b.color}` }}>
              <div className="col-head"><span className="dot" style={{ background: b.color }} />{b.name}
                <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setModal({ barber_id: b.id })}>+</button>
              </div>
              {mine.map((a) => (
                <div key={a.id} className={'appt' + (a.status !== 'scheduled' ? ' done' : '')} style={{ borderLeftColor: b.color }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="t">{fmtTime(a.starts_at)}–{fmtTime(a.ends_at)}</span>
                    <span className={'badge ' + a.status}>{STATUS[a.status]}</span>
                    {a.reminder_sent_at && <span title="Lembrete enviado ao cliente">🔔</span>}
                  </div>
                  <div>{a.customer_name || a.customer_phone}</div>
                  <div className="muted">{a.service_name} · {money(a.price)}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    {a.status === 'scheduled' && <button className="btn sm" onClick={() => setStatus(a.id, 'cancelled')}>Cancelar</button>}
                    {a.status !== 'attended' && <button className="btn sm ok" onClick={() => setStatus(a.id, 'attended')}>Compareceu</button>}
                    {a.status !== 'no_show' && <button className="btn sm bad" onClick={() => setStatus(a.id, 'no_show')}>Faltou</button>}
                    {a.status !== 'scheduled' && <button className="btn sm" onClick={() => setStatus(a.id, 'scheduled')}>Reabrir</button>}
                    <button className="btn sm" onClick={() => remove(a.id)}>Excluir</button>
                  </div>
                </div>
              ))}
              {!mine.length && <p className="muted">Sem agendamentos neste dia.</p>}
            </div>
          );
        })}
      </div>
      {modal && <NewAppointment init={modal} date={date} barbers={barbers} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    </>
  );
}

function NewAppointment({ init, date, barbers, onClose, onSaved }) {
  const [customers, setCustomers] = useState([]);
  const [services, setServices] = useState([]);
  const [f, setF] = useState({ barber_id: init.barber_id, customer_id: '', service_id: '', time: '09:00', name: '', phone: '' });
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
      await api('/appointments', { method: 'POST', body: { barber_id: Number(f.barber_id), customer_id: Number(customer_id), service_id: Number(f.service_id), starts_at } });
      onSaved();
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Novo agendamento</h2>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>Profissional</label>
          <select value={f.barber_id} onChange={set('barber_id')} required>{barbers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="field"><label>Serviço</label>
          <select value={f.service_id} onChange={set('service_id')} required><option value="">Selecione…</option>
            {services.filter((s) => { const b = barbers.find((x) => String(x.id) === String(f.barber_id)); return !b?.service_ids?.length || b.service_ids.map(String).includes(String(s.id)); }).map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.price)} ({s.duration_min} min)</option>)}</select></div>
        <div className="field"><label>Cliente</label>
          <select value={f.customer_id} onChange={set('customer_id')} required><option value="">Selecione…</option>
            <option value="new">➕ Novo cliente (presencial)</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name || 'Sem nome'} — {c.phone}</option>)}</select></div>
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
