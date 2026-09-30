import React, { useEffect, useState } from 'react';
import { api, WEEKDAYS } from '../api.js';

const defaultSchedule = () => [1, 2, 3, 4, 5, 6].map((w) => ({
  weekday: w, on: w !== 0, start_time: '09:00', end_time: '18:00', break_start: '12:00', break_end: '13:00',
}));
const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

function toForm(b) {
  const map = Object.fromEntries((b.schedules || []).map((s) => [s.weekday, s]));
  return {
    ...b,
    sched: [0, 1, 2, 3, 4, 5, 6].map((w) => {
      const s = map[w];
      return s
        ? { weekday: w, on: true, start_time: hhmm(s.start_time), end_time: hhmm(s.end_time), break_start: hhmm(s.break_start), break_end: hhmm(s.break_end) }
        : { weekday: w, on: false, start_time: '09:00', end_time: '18:00', break_start: '', break_end: '' };
    }),
  };
}

export default function Barbeiros() {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const [max, setMax] = useState(null);
  const [services, setServices] = useState([]);
  const load = () => api('/barbers').then(setList);
  useEffect(() => { load(); api('/salon').then((s) => setMax(s.max_barbers)); api('/services').then((l) => setServices(l.filter((x) => x.active))); }, []);
  const ativos = list.filter((b) => b.active).length;
  const cheio = max !== null && ativos >= max;

  const openNew = () => setEdit({ name: '', color: '#2563eb', phone: '', service_ids: [], sched: [0, 1, 2, 3, 4, 5, 6].map((w) => defaultSchedule().find((d) => d.weekday === w) || { weekday: w, on: false, start_time: '09:00', end_time: '18:00', break_start: '', break_end: '' }) });

  async function save(e) {
    e.preventDefault(); setErr('');
    const schedules = edit.sched.filter((s) => s.on).map((s) => ({
      weekday: s.weekday, start_time: s.start_time, end_time: s.end_time,
      break_start: s.break_start || null, break_end: s.break_end || null,
    }));
    const body = { name: edit.name, color: edit.color, phone: edit.phone, google_calendar_id: edit.google_calendar_id || '', service_ids: edit.service_ids || [], schedules };
    try {
      if (edit.id) await api('/barbers/' + edit.id, { method: 'PUT', body });
      else await api('/barbers', { method: 'POST', body });
      setEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  const groups = Object.values(services.reduce((acc, sv) => {
    const k = sv.category || 'Sem categoria';
    (acc[k] = acc[k] || { name: k, items: [] }).items.push(sv);
    return acc;
  }, {}));
  const toggleSvc = (id) => {
    const cur = (edit.service_ids || []).map(String);
    const k = String(id);
    setEdit({ ...edit, service_ids: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] });
  };
  const setSched = (i, k, v) => setEdit({ ...edit, sched: edit.sched.map((s, j) => (j === i ? { ...s, [k]: v } : s)) });
  const toggle = (b) => api('/barbers/' + b.id, { method: 'PUT', body: { active: !b.active } }).then(load).catch((e) => alert(e.message));

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1>Barbeiros</h1><p className="muted">Cada profissional cadastrado ganha sua própria agenda{max !== null && ` · ${ativos} de ${max} profissionais ativos`}</p></div>
        <button className="btn primary" onClick={openNew} disabled={cheio} title={cheio ? 'Limite do plano atingido' : ''} style={cheio ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>+ Novo barbeiro</button>
      </div>
      <div className="grid cols-4">
        {list.map((b) => (
          <div className="card" key={b.id} style={{ opacity: b.active ? 1 : 0.5, borderTop: `4px solid ${b.color}` }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{b.name}</strong><span className="dot" style={{ background: b.color }} />
            </div>
            <p className="muted" style={{ margin: '6px 0' }}>
              {b.schedules.length
                ? b.schedules.map((s) => WEEKDAYS[s.weekday].slice(0, 3)).join(' · ')
                : 'Sem horários definidos'}
            </p>
            <p className="muted" style={{ margin: '0 0 6px' }}>
              {b.service_ids?.length ? services.filter((x) => b.service_ids.map(String).includes(String(x.id))).map((x) => x.name).join(', ') || 'Serviços selecionados' : 'Todos os serviços'}
            </p>
            <div className="row">
              <button className="btn sm" onClick={() => setEdit(toForm(b))}>Editar</button>
              <button className="btn sm" onClick={() => toggle(b)}>{b.active ? 'Desativar' : 'Ativar'}</button>
            </div>
          </div>
        ))}
        {!list.length && <p className="muted">Nenhum barbeiro cadastrado.</p>}
      </div>

      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{edit.id ? 'Editar barbeiro' : 'Novo barbeiro'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="row">
              <div className="field" style={{ flex: 3 }}><label>Nome</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></div>
              <div className="field"><label>Cor</label><input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} style={{ padding: 3, height: 40 }} /></div>
            </div>
            <div className="field"><label>Telefone (opcional)</label><input value={edit.phone || ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
            <div className="field"><label>ID da agenda Google (opcional)</label><input value={edit.google_calendar_id || ''} onChange={(e) => setEdit({ ...edit, google_calendar_id: e.target.value })} placeholder="ex.: nome@gmail.com ou xxxx@group.calendar.google.com" /></div>
            {services.length > 0 && (
              <div className="field">
                <label>Serviços que realiza <span className="muted">(nenhum marcado = faz todos)</span></label>
                {groups.map((g) => {
                  const ids = g.items.map((x) => String(x.id));
                  const sel = (edit.service_ids || []).map(String);
                  const all = ids.every((i) => sel.includes(i));
                  return (
                    <div key={g.name} style={{ marginBottom: 8 }}>
                      <label style={{ margin: 0, color: 'var(--text)', fontWeight: 600 }}>
                        <input type="checkbox" style={{ width: 'auto', marginRight: 6 }} checked={all}
                          onChange={() => setEdit({ ...edit, service_ids: all ? sel.filter((i) => !ids.includes(i)) : [...new Set([...sel, ...ids])] })} />
                        {g.name} <span className="muted" style={{ fontWeight: 400 }}>(marcar todos)</span>
                      </label>
                      <div className="row" style={{ flexWrap: 'wrap', gap: '4px 16px', paddingLeft: 22 }}>
                        {g.items.map((sv) => (
                          <label key={sv.id} style={{ margin: 0, color: 'var(--text)', fontWeight: 400 }}>
                            <input type="checkbox" style={{ width: 'auto', marginRight: 6 }} checked={sel.includes(String(sv.id))} onChange={() => toggleSvc(sv.id)} />
                            {sv.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <label>Horários de trabalho</label>
            <div className="sched-row muted"><span>Dia</span><span>Entrada</span><span>Saída</span><span>Pausa de</span><span>até</span></div>
            {edit.sched.map((s, i) => (
              <div className="sched-row" key={s.weekday} style={{ opacity: s.on ? 1 : 0.55 }}>
                <label style={{ margin: 0, color: 'var(--text)' }}>
                  <input type="checkbox" checked={s.on} onChange={(e) => setSched(i, 'on', e.target.checked)} style={{ width: 'auto', marginRight: 6 }} />
                  {WEEKDAYS[s.weekday].slice(0, 3)}
                </label>
                <input type="time" disabled={!s.on} value={s.start_time} onChange={(e) => setSched(i, 'start_time', e.target.value)} />
                <input type="time" disabled={!s.on} value={s.end_time} onChange={(e) => setSched(i, 'end_time', e.target.value)} />
                <input type="time" disabled={!s.on} value={s.break_start} onChange={(e) => setSched(i, 'break_start', e.target.value)} />
                <input type="time" disabled={!s.on} value={s.break_end} onChange={(e) => setSched(i, 'break_end', e.target.value)} />
              </div>
            ))}
            <div className="row" style={{ marginTop: 14 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}
