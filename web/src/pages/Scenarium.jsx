import React, { useEffect, useState } from 'react';
import { api, fmtPhone } from '../api.js';

const SITUACAO = { confirmed: 'Confirmada', attended: 'Compareceu', cancelled: 'Cancelada', no_show: 'Não veio' };
const BADGE = { confirmed: 'pending', attended: 'attended', cancelled: 'cancelled', no_show: 'no_show' };
const n1 = (v) => String(Math.round(Number(v) * 100) / 100).replace('.', ',');
const quando = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const dia = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR');
const paraInput = (d) => { if (!d) return ''; const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const vir = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
const hoje = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

export default function Scenarium() {
  const [aba, setAba] = useState('reservas');
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h1>Scenarium</h1>
        <p className="muted">Reservas de mesa por setor. Cada setor tem um espaço, e cada tipo de mesa ocupa uma parte dele.</p>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['reservas', 'Reservas'], ['setores', 'Setores'], ['mesas', 'Mesas']].map(([v, l]) => (
          <button key={v} className={'btn' + (aba === v ? ' primary' : '')} onClick={() => setAba(v)}>{l}</button>
        ))}
      </div>
      {aba === 'reservas' && <Reservas />}
      {aba === 'setores' && <Setores />}
      {aba === 'mesas' && <Mesas />}
    </>
  );
}

// ---------------------------------------------------------------- reservas
function Reservas() {
  const [eventos, setEventos] = useState([]);
  const [passados, setPassados] = useState([]);
  const [oc, setOc] = useState(''); // id do evento, ou 'data'
  const [data, setData] = useState(hoje());
  const [disp, setDisp] = useState(null);
  const [lista, setLista] = useState([]);
  const [setores, setSetores] = useState([]);
  const [tipos, setTipos] = useState([]);
  const [edit, setEdit] = useState(null);
  const [ajuste, setAjuste] = useState(null);
  const [extras, setExtras] = useState([]);
  const [novaExtra, setNovaExtra] = useState(null);
  const [cond, setCond] = useState(null);
  const [codigos, setCodigos] = useState([]);
  const [novoCod, setNovoCod] = useState({ word: '', kind: 'percent', value: '', max_uses: '', note: '' });
  const [dup, setDup] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/events?quando=proximos').then((l) => { setEventos(l); setOc(l[0] ? String(l[0].id) : 'data'); }).catch(() => setOc('data'));
    api('/events?quando=passados').then((l) => setPassados(l.slice(0, 60))).catch(() => {});
    api('/scenarium/sectors').then(setSetores).catch(() => {});
    api('/scenarium/table-types').then(setTipos).catch(() => {});
  }, []);
  const filtro = oc === 'data' ? 'date=' + data : 'event_id=' + oc;
  const load = () => {
    if (!oc) return;
    setErr('');
    api('/scenarium/availability?' + filtro).then(setDisp).catch((e) => setErr(e.message));
    api('/scenarium/reservations?' + filtro).then(setLista).catch((e) => setErr(e.message));
    api('/scenarium/extras?' + filtro).then(setExtras).catch(() => {});
  };
  useEffect(() => { load(); }, [oc, data]);

  const novo = () => {
    setErr('');
    setEdit({ name: '', phone: '', sector_id: setores.find((s) => s.active)?.id || '', people: 2, table_type_id: '', tables: '', status: 'confirmed', guests: '', note: '', code: '', birthday: '', unit_price: '' });
  };
  const editar = (v) => { setErr(''); setEdit({ id: v.id, name: v.name, phone: v.phone ? fmtPhone(v.phone) : '', sector_id: v.sector_id, people: v.people, table_type_id: v.table_type_id || '', tables: v.tables, status: v.status, guests: v.guests || '', note: v.note || '', code: '', birthday: '', unit_price: v.unit_price === null ? '' : String(v.unit_price).replace('.', ','), unit_price_antes: v.unit_price === null ? '' : String(v.unit_price).replace('.', ',') }); };
  async function salvar(e) {
    e.preventDefault(); setErr('');
    const body = {
      name: edit.name, phone: edit.phone, sector_id: edit.sector_id, people: Number(edit.people), status: edit.status, guests: edit.guests, note: edit.note,
      ...(oc === 'data' ? { date: data } : { event_id: oc }),
    };
    if (edit.table_type_id) { body.table_type_id = edit.table_type_id; if (edit.tables) body.tables = Number(edit.tables); }
    if (edit.code.trim()) body.code = edit.code.trim();
    if (edit.birthday.trim()) body.birthday = edit.birthday.trim();
    if (edit.id ? edit.unit_price !== edit.unit_price_antes : edit.unit_price !== '') body.unit_price = edit.unit_price;
    try {
      if (edit.id) await api('/scenarium/reservations/' + edit.id, { method: 'PUT', body });
      else await api('/scenarium/reservations', { method: 'POST', body });
      setEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  const mudar = async (v, status) => {
    try { await api('/scenarium/reservations/' + v.id, { method: 'PUT', body: { status } }); load(); } catch (e) { setErr(e.message); }
  };
  const apagar = async (v) => {
    if (!confirm(`Apagar a reserva de ${v.name}? Não dá para desfazer.`)) return;
    try { await api('/scenarium/reservations/' + v.id, { method: 'DELETE' }); load(); } catch (e) { setErr(e.message); }
  };
  async function salvarExtra(e) {
    e.preventDefault(); setErr('');
    try {
      await api('/scenarium/extras', { method: 'POST', body: { ...(oc === 'data' ? { date: data } : { event_id: oc }), sector_id: novaExtra.sector_id, table_type_id: novaExtra.table_type_id, quantity: Number(novaExtra.quantity) || 1, note: novaExtra.note } });
      setNovaExtra(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  const fecharExtra = async (x) => {
    if (!confirm(`Fechar a mesa extra (${x.quantity} × ${x.table_name}) do ${x.sector_name}?`)) return;
    try { await api('/scenarium/extras/' + x.id, { method: 'DELETE' }); load(); } catch (e) { setErr(e.message); }
  };
  async function abrirCond() {
    setErr('');
    try {
      const [c, k] = await Promise.all([api(`/scenarium/events/${oc}/conditions`), api(`/scenarium/events/${oc}/codes`)]);
      setCond({ price: vir(c.price), door_price: vir(c.door_price), price_until: paraInput(c.price_until), instructions: c.instructions || '' });
      setCodigos(k);
      setNovoCod({ word: '', kind: 'percent', value: '', max_uses: '', note: '' });
    } catch (e) { setErr(e.message); }
  }
  async function salvarCond(e) {
    e.preventDefault(); setErr('');
    try {
      await api(`/scenarium/events/${oc}/conditions`, { method: 'PUT', body: { price: cond.price, door_price: cond.door_price, price_until: cond.price_until ? new Date(cond.price_until).toISOString() : null, instructions: cond.instructions } });
      setCond(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  async function addCodigo() {
    setErr('');
    try {
      await api(`/scenarium/events/${oc}/codes`, { method: 'POST', body: { word: novoCod.word, kind: novoCod.kind, value: novoCod.value, max_uses: novoCod.max_uses || null, note: novoCod.note } });
      setCodigos(await api(`/scenarium/events/${oc}/codes`));
      setNovoCod({ word: '', kind: 'percent', value: '', max_uses: '', note: '' });
    } catch (e) { setErr(e.message); }
  }
  async function apagarCodigo(k) {
    if (!confirm(`Apagar a palavra "${k.word}"?`)) return;
    try { await api('/scenarium/codes/' + k.id, { method: 'DELETE' }); setCodigos(codigos.filter((x) => x.id !== k.id)); } catch (e) { setErr(e.message); }
  }
  function abrirDup() {
    const ev = [...eventos, ...passados].find((x) => String(x.id) === String(oc));
    setErr(''); setDup({ title: ev?.title || '', starts_at: '' });
  }
  async function salvarDup(e) {
    e.preventDefault(); setErr('');
    try {
      const r = await api(`/scenarium/events/${oc}/duplicate`, { method: 'POST', body: { title: dup.title, starts_at: new Date(dup.starts_at).toISOString() } });
      const l = await api('/events?quando=proximos');
      setEventos(l); setOc(String(r.event.id)); setDup(null);
    } catch (e2) { setErr(e2.message); }
  }
  async function abrirAjuste() {
    if (!disp) return;
    setAjuste(disp.sectors.map((s) => ({ sector_id: s.sector_id, name: s.name, base: s.base_space, space: s.custom_space ? String(s.space) : '' })));
  }
  async function salvarAjuste(e) {
    e.preventDefault();
    try {
      await api(`/scenarium/events/${oc}/sectors`, { method: 'PUT', body: { sectors: ajuste.map((a) => ({ sector_id: a.sector_id, space: a.space === '' ? null : a.space })) } });
      setAjuste(null); load();
    } catch (e2) { setErr(e2.message); }
  }

  const tiposAtivos = tipos.filter((t) => t.active);
  const setorSel = setores.find((x) => String(x.id) === String(edit?.sector_id));
  const tiposDoSetor = setorSel?.tables?.length ? tiposAtivos.filter((t) => setorSel.tables.some((g) => String(g.table_type_id) === String(t.id))) : tiposAtivos;
  const tipoSel = tiposDoSetor.find((t) => String(t.id) === String(edit?.table_type_id));
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="row">
          <select value={oc} onChange={(e) => setOc(e.target.value)} style={{ maxWidth: 320 }}>
            {eventos.map((ev) => <option key={ev.id} value={ev.id}>{ev.title} · {quando(ev.starts_at)}</option>)}
            {passados.length > 0 && <optgroup label="Eventos anteriores">{passados.map((ev) => <option key={ev.id} value={ev.id}>{ev.title} · {quando(ev.starts_at)}</option>)}</optgroup>}
            <option value="data">Outra data…</option>
          </select>
          {oc === 'data' && <input type="date" value={data} onChange={(e) => setData(e.target.value || hoje())} style={{ maxWidth: 170 }} />}
          {oc !== 'data' && <button className="btn" onClick={abrirAjuste}>Ajustar espaço deste evento</button>}
          {oc !== 'data' && <button className="btn" onClick={abrirCond}>Preço e descontos</button>}
          {oc !== 'data' && <button className="btn" onClick={abrirDup}>Duplicar evento</button>}
          <button className="btn" disabled={!setores.some((s) => s.active) || !tiposAtivos.length} onClick={() => { setErr(''); setNovaExtra({ sector_id: setores.find((x) => x.active)?.id || '', table_type_id: tiposAtivos[0]?.id || '', quantity: 1, note: '' }); }}>+ Mesa extra</button>
        </div>
        <button className="btn primary" onClick={novo} disabled={!setores.some((s) => s.active) || !tiposAtivos.length}>+ Nova reserva</button>
      </div>
      {(!setores.some((s) => s.active) || !tiposAtivos.length) && <p className="muted">Antes de reservar, cadastre ao menos um setor (aba Setores) e um tipo de mesa (aba Mesas).</p>}
      {err && !edit && !ajuste && <div className="error">{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, marginBottom: 14 }}>
        {(disp?.sectors || []).map((s) => {
          const p = s.space > 0 ? Math.min(100, (s.used / s.space) * 100) : 100;
          return (
            <div className="card" key={s.sector_id} style={{ padding: 12 }}>
              <strong>{s.name}</strong>{s.custom_space && <span className="muted"> · ajustado</span>}{s.extra_tables > 0 && <span className="muted"> · +{s.extra_tables} extra</span>}
              <div style={{ height: 6, background: 'var(--line)', borderRadius: 4, margin: '8px 0' }}>
                <div style={{ width: p + '%', height: '100%', background: p >= 100 ? 'var(--bad)' : 'var(--primary)', borderRadius: 4 }} />
              </div>
              <div className="muted">{n1(s.used)} de {n1(s.space)} · restam {n1(s.free)}</div>
              <div className="muted">{s.reservations} reserva(s) · {s.people} pessoa(s)</div>
            </div>
          );
        })}
        {disp && !disp.sectors.length && <p className="muted">Nenhum setor ativo.</p>}
      </div>

      {extras.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 14 }}>
          <strong>Mesas extras abertas</strong>
          {extras.map((x) => (
            <div className="row" key={x.id} style={{ justifyContent: 'space-between', marginTop: 6 }}>
              <span>{x.quantity} × {x.table_name} no {x.sector_name}{x.note && <span className="muted"> · {x.note}</span>}</span>
              <button className="btn sm" onClick={() => fecharExtra(x)}>Fechar</button>
            </div>
          ))}
        </div>
      )}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Setor</th><th>Nome</th><th>Telefone</th><th>Pessoas</th><th>Mesa</th><th>Valor</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {lista.map((v) => (
              <tr key={v.id}>
                <td>{v.sector_name}</td>
                <td>{v.name}{v.guests && <div className="muted" style={{ whiteSpace: 'pre-line', fontSize: 12 }}>{v.guests}</div>}</td>
                <td>{v.phone ? fmtPhone(v.phone) : <span className="muted">—</span>}</td>
                <td>{v.people}</td>
                <td>{v.tables} × {v.table_name}</td>
                <td>{v.total !== null ? n1(v.total) : <span className="muted">—</span>}{v.code_word && <div className="muted" style={{ fontSize: 12 }}>{v.code_word}</div>}</td>
                <td><span className={'badge ' + BADGE[v.status]}>{SITUACAO[v.status]}</span></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {v.status === 'confirmed' && <button className="btn sm" onClick={() => mudar(v, 'attended')}>Compareceu</button>}{' '}
                  {v.status === 'confirmed' && <button className="btn sm" onClick={() => mudar(v, 'cancelled')}>Cancelar</button>}{' '}
                  <button className="btn sm" onClick={() => editar(v)}>Editar</button>{' '}
                  <button className="btn sm" onClick={() => apagar(v)}>Apagar</button>
                </td>
              </tr>
            ))}
            {!lista.length && <tr><td colSpan="8" className="muted">Nenhuma reserva {oc === 'data' ? `em ${dia(data)}` : 'neste evento'}.</td></tr>}
          </tbody>
        </table>
      </div>

      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={salvar}>
            <h2>{edit.id ? 'Editar reserva' : 'Nova reserva'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome de quem reserva *</label><input value={edit.name} maxLength={120} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></div>
            <div className="field"><label>Telefone (WhatsApp)</label><input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} placeholder="(32) 99999-9999" /></div>
            <div className="row">
              <div className="field"><label>Setor *</label>
                <select value={edit.sector_id} onChange={(e) => setEdit({ ...edit, sector_id: e.target.value })} required>
                  {setores.filter((s) => s.active || String(s.id) === String(edit.sector_id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select></div>
              <div className="field"><label>Pessoas *</label><input type="number" min="1" max="1000" value={edit.people} onChange={(e) => setEdit({ ...edit, people: e.target.value })} required /></div>
            </div>
            <div className="row">
              <div className="field"><label>Mesa</label>
                <select value={edit.table_type_id} onChange={(e) => setEdit({ ...edit, table_type_id: e.target.value, tables: '' })}>
                  <option value="">{edit.id ? 'Manter a atual' : 'Escolher automaticamente (a que ocupa menos espaço)'}</option>
                  {tiposDoSetor.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.seats} lugar(es)</option>)}
                </select></div>
              {tipoSel && <div className="field"><label>Quantas mesas</label><input type="number" min="1" max="100" value={edit.tables} placeholder={String(Math.ceil((Number(edit.people) || 1) / tipoSel.seats))} onChange={(e) => setEdit({ ...edit, tables: e.target.value })} /></div>}
            </div>
            {edit.id && (
              <div className="field"><label>Situação</label>
                <select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                  {Object.entries(SITUACAO).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>
            )}
            <div className="row">
              <div className="field"><label>Palavra-chave de desconto</label><input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} placeholder="Opcional" /></div>
              <div className="field"><label>Valor por pessoa (R$)</label><input value={edit.unit_price} onChange={(e) => setEdit({ ...edit, unit_price: e.target.value })} placeholder="Automático pelo evento" /></div>
            </div>
            <div className="field"><label>Aniversário de quem reserva (dd/mm ou dd/mm/aaaa)</label><input value={edit.birthday} onChange={(e) => setEdit({ ...edit, birthday: e.target.value })} placeholder="Opcional — só preenche a ficha se estiver vazia" /></div>
            <div className="field"><label>Lista de nomes (um por linha)</label><textarea rows="3" value={edit.guests} maxLength={2000} onChange={(e) => setEdit({ ...edit, guests: e.target.value })} /></div>
            <div className="field"><label>Anotação (opcional)</label><input value={edit.note} maxLength={300} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></div>
            <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}

      {cond && (
        <div className="modal-bg" onClick={() => setCond(null)}>
          <form className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()} onSubmit={salvarCond}>
            <h2>Preço e descontos do evento</h2>
            {err && <div className="error">{err}</div>}
            <div className="row">
              <div className="field"><label>Ingresso por pessoa (R$)</label><input value={cond.price} onChange={(e) => setCond({ ...cond, price: e.target.value })} /></div>
              <div className="field"><label>Na portaria (R$)</label><input value={cond.door_price} onChange={(e) => setCond({ ...cond, door_price: e.target.value })} /></div>
            </div>
            <div className="field"><label>O preço normal vale até</label><input type="datetime-local" value={cond.price_until} onChange={(e) => setCond({ ...cond, price_until: e.target.value })} /></div>
            <div className="field"><label>Instrução para o atendente (descontos excepcionais, avisos…)</label>
              <textarea rows="3" maxLength="2000" value={cond.instructions} onChange={(e) => setCond({ ...cond, instructions: e.target.value })} placeholder="Ex.: quem disser que é amigo da Rafa paga R$ 25." /></div>
            <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setCond(null)}>Fechar</button></div>
            <h3 style={{ marginTop: 18 }}>Palavras-chave de desconto</h3>
            <p className="muted">O atendente pergunta ao painel se a palavra dita pelo cliente vale; ele nunca vê a lista.</p>
            {codigos.map((k) => (
              <div className="row" key={k.id} style={{ justifyContent: 'space-between', marginTop: 4 }}>
                <span>{k.word} · {k.kind === 'percent' ? n1(k.value) + '%' : 'paga R$ ' + n1(k.value)} · {k.uses}{k.max_uses ? ' de ' + k.max_uses : ''} uso(s){k.note && <span className="muted"> · {k.note}</span>}</span>
                <button type="button" className="btn sm" onClick={() => apagarCodigo(k)}>Apagar</button>
              </div>
            ))}
            {!codigos.length && <p className="muted">Nenhuma palavra cadastrada.</p>}
            <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: 2 }}><label>Palavra</label><input value={novoCod.word} maxLength="40" onChange={(e) => setNovoCod({ ...novoCod, word: e.target.value })} /></div>
              <div className="field"><label>Tipo</label>
                <select value={novoCod.kind} onChange={(e) => setNovoCod({ ...novoCod, kind: e.target.value })}>
                  <option value="percent">% de desconto</option><option value="price">Preço fixo</option>
                </select></div>
              <div className="field"><label>{novoCod.kind === 'percent' ? '%' : 'R$'}</label><input value={novoCod.value} onChange={(e) => setNovoCod({ ...novoCod, value: e.target.value })} /></div>
              <div className="field"><label>Limite de usos</label><input type="number" min="1" value={novoCod.max_uses} onChange={(e) => setNovoCod({ ...novoCod, max_uses: e.target.value })} placeholder="Sem limite" /></div>
              <button type="button" className="btn" onClick={addCodigo} disabled={!novoCod.word || !novoCod.value}>Adicionar</button>
            </div>
          </form>
        </div>
      )}

      {dup && (
        <div className="modal-bg" onClick={() => setDup(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={salvarDup}>
            <h2>Duplicar evento</h2>
            <p className="muted">O novo evento leva o preço, as palavras-chave e o espaço dos setores. A lista de reservas e as mesas extras começam vazias, e os prazos acompanham a nova data.</p>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome do novo evento</label><input value={dup.title} maxLength="120" onChange={(e) => setDup({ ...dup, title: e.target.value })} required /></div>
            <div className="field"><label>Data e hora de início *</label><input type="datetime-local" value={dup.starts_at} onChange={(e) => setDup({ ...dup, starts_at: e.target.value })} required /></div>
            <div className="row"><button className="btn primary">Duplicar</button><button type="button" className="btn" onClick={() => setDup(null)}>Cancelar</button></div>
          </form>
        </div>
      )}

      {novaExtra && (
        <div className="modal-bg" onClick={() => setNovaExtra(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={salvarExtra}>
            <h2>Abrir mesa extra</h2>
            <p className="muted">Vale só para {oc === 'data' ? `o dia ${dia(data)}` : 'este evento'}. A mesa já aparece como disponível para o atendente, mesmo que o setor esteja lotado ou não aceite esse tipo de mesa.</p>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Setor *</label>
              <select value={novaExtra.sector_id} onChange={(e) => setNovaExtra({ ...novaExtra, sector_id: e.target.value })} required>
                {setores.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select></div>
            <div className="row">
              <div className="field"><label>Mesa *</label>
                <select value={novaExtra.table_type_id} onChange={(e) => setNovaExtra({ ...novaExtra, table_type_id: e.target.value })} required>
                  {tiposAtivos.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.seats} lugar(es)</option>)}
                </select></div>
              <div className="field"><label>Quantas</label><input type="number" min="1" max="100" value={novaExtra.quantity} onChange={(e) => setNovaExtra({ ...novaExtra, quantity: e.target.value })} /></div>
            </div>
            <div className="field"><label>Anotação (opcional)</label><input value={novaExtra.note} maxLength={300} onChange={(e) => setNovaExtra({ ...novaExtra, note: e.target.value })} placeholder="Ex.: espaço aberto na pista" /></div>
            <div className="row"><button className="btn primary">Abrir mesa</button><button type="button" className="btn" onClick={() => setNovaExtra(null)}>Cancelar</button></div>
          </form>
        </div>
      )}

      {ajuste && (
        <div className="modal-bg" onClick={() => setAjuste(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={salvarAjuste}>
            <h2>Espaço dos setores neste evento</h2>
            <p className="muted">Deixe em branco para usar o espaço padrão do setor.</p>
            {err && <div className="error">{err}</div>}
            {ajuste.map((a, i) => (
              <div className="field" key={a.sector_id}><label>{a.name} (padrão {n1(a.base)})</label>
                <input value={a.space} onChange={(e) => setAjuste(ajuste.map((x, j) => (j === i ? { ...x, space: e.target.value } : x)))} placeholder={n1(a.base)} /></div>
            ))}
            <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setAjuste(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}


// ---------------------------------------------------------------- mapa e fotos
// Reduz a imagem no próprio navegador (mais leve para enviar e para o cliente abrir no WhatsApp)
async function reduzirImagem(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, er) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => er(new Error('Não consegui abrir essa imagem')); i.src = url; });
    const esc = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * esc); c.height = Math.round(img.height * esc);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

function MapaDoEspaco() {
  const [m, setM] = useState(undefined);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api('/scenarium/media').then((r) => setM(r.map)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  async function enviar(e) {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    setErr(''); setBusy(true);
    try { await api('/scenarium/media', { method: 'POST', body: { kind: 'map', data: await reduzirImagem(f, 1800) } }); await load(); } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }
  async function tirar() { if (!confirm('Remover o mapa do espaço?')) return; try { await api('/scenarium/media/' + m.id, { method: 'DELETE' }); load(); } catch (e) { setErr(e.message); } }
  if (m === undefined) return null;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <strong>Mapa do espaço</strong>
      <p className="muted" style={{ margin: '4px 0 8px' }}>O atendente envia este mapa ao cliente que quer saber onde ficam os setores.</p>
      {err && <div className="error">{err}</div>}
      {m && <a href={m.url} target="_blank" rel="noreferrer"><img src={m.url} alt="Mapa do espaço" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, display: 'block', marginBottom: 8 }} /></a>}
      <label className="btn sm" style={{ cursor: 'pointer' }}>{busy ? 'Enviando…' : m ? 'Trocar o mapa' : 'Enviar o mapa'}<input type="file" accept="image/*" onChange={enviar} style={{ display: 'none' }} disabled={busy} /></label>
      {m && <button className="btn sm" style={{ marginLeft: 6 }} onClick={tirar}>Remover</button>}
    </div>
  );
}

function FotosDoSetor({ setorId }) {
  const [fotos, setFotos] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api('/scenarium/media?sector_id=' + setorId).then((r) => setFotos(r.sectors[0]?.photos || [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [setorId]);
  async function enviar(e) {
    const arq = [...e.target.files]; e.target.value = ''; if (!arq.length) return;
    setErr(''); setBusy(true);
    try { for (const f of arq) await api('/scenarium/media', { method: 'POST', body: { kind: 'photo', sector_id: setorId, data: await reduzirImagem(f, 1400) } }); } catch (e2) { setErr(e2.message); }
    await load(); setBusy(false);
  }
  async function legenda(f) {
    const t = window.prompt('Legenda da foto (opcional):', f.caption || ''); if (t === null) return;
    try { await api('/scenarium/media/' + f.id, { method: 'PUT', body: { caption: t } }); load(); } catch (e) { setErr(e.message); }
  }
  async function tirar(f) { if (!confirm('Remover esta foto?')) return; try { await api('/scenarium/media/' + f.id, { method: 'DELETE' }); load(); } catch (e) { setErr(e.message); } }
  return (
    <div className="field" style={{ marginTop: 10 }}>
      <label>Fotos do setor (até 8)</label>
      {err && <div className="error">{err}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
        {(fotos || []).map((f) => (
          <div key={f.id} style={{ width: 110 }}>
            <img src={f.url} alt={f.caption || ''} style={{ width: 110, height: 80, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
            <div className="muted" style={{ fontSize: 11, minHeight: 14 }}>{f.caption || ''}</div>
            <button type="button" className="btn sm" onClick={() => legenda(f)}>Legenda</button> <button type="button" className="btn sm" onClick={() => tirar(f)}>×</button>
          </div>
        ))}
      </div>
      <label className="btn sm" style={{ cursor: 'pointer' }}>{busy ? 'Enviando…' : '+ Adicionar fotos'}<input type="file" accept="image/*" multiple onChange={enviar} style={{ display: 'none' }} disabled={busy || (fotos || []).length >= 8} /></label>
    </div>
  );
}

// ---------------------------------------------------------------- setores
function Setores() {
  const [rows, setRows] = useState([]);
  const [tipos, setTipos] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('/scenarium/sectors').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); api('/scenarium/table-types').then(setTipos).catch(() => {}); }, []);
  const nomeMesas = (s) => (s.tables.length ? s.tables.map((g) => { const t = tipos.find((x) => String(x.id) === String(g.table_type_id)); return t ? t.name + (g.max_tables ? ` (até ${g.max_tables})` : '') : null; }).filter(Boolean).join(', ') : 'Todas');
  const abrir = (s) => {
    setErr('');
    const regras = Object.fromEntries((s?.tables || []).map((g) => [String(g.table_type_id), g.max_tables ? String(g.max_tables) : '']));
    setEdit({ id: s?.id, name: s?.name || '', space: s ? String(s.space).replace('.', ',') : '', notes: s?.notes || '', active: s ? s.active : true, restringe: !!s?.tables?.length, regras });
  };
  async function salvar(e) {
    e.preventDefault(); setErr('');
    const tables = edit.restringe ? Object.entries(edit.regras).filter(([, v]) => v !== undefined && v !== null).map(([id, v]) => ({ table_type_id: id, max_tables: v === '' ? null : Number(v) })) : [];
    const body = { name: edit.name, space: edit.space, notes: edit.notes, active: edit.active, tables };
    try {
      if (edit.id) await api('/scenarium/sectors/' + edit.id, { method: 'PUT', body });
      else await api('/scenarium/sectors', { method: 'POST', body });
      setEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  const apagar = async (s) => {
    if (!confirm(`Apagar o setor "${s.name}"?`)) return;
    try { await api('/scenarium/sectors/' + s.id, { method: 'DELETE' }); load(); } catch (e) { setErr(e.message); }
  };
  const alternarMesa = (id) => {
    const r = { ...edit.regras };
    if (r[id] === undefined) r[id] = ''; else delete r[id];
    setEdit({ ...edit, regras: r });
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0 }}>O espaço é uma medida sua: use pontos, metros quadrados ou o que preferir, desde que as mesas usem a mesma medida. Em cada setor você também define quais mesas ele aceita e quantas de cada tipo cabem.</p>
        <button className="btn primary" onClick={() => abrir(null)}>+ Novo setor</button>
      </div>
      {err && !edit && <div className="error">{err}</div>}
      <MapaDoEspaco />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Setor</th><th>Espaço</th><th>Mesas aceitas</th><th>Observações</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td><td>{n1(s.space)}</td><td>{nomeMesas(s)}</td><td className="muted">{s.notes || '—'}</td><td>{s.active ? 'Ativo' : 'Desativado'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => abrir(s)}>Editar</button>{' '}
                  <button className="btn sm" onClick={() => apagar(s)}>Apagar</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="6" className="muted">Nenhum setor cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={salvar}>
            <h2>{edit.id ? 'Editar setor' : 'Novo setor'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome *</label><input value={edit.name} maxLength={60} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></div>
            <div className="field"><label>Espaço total *</label><input value={edit.space} onChange={(e) => setEdit({ ...edit, space: e.target.value })} required /></div>
            <div className="field"><label>Observações (visão, som, perto do bar…)</label><input value={edit.notes} maxLength={300} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></div>
            {edit.id ? <FotosDoSetor setorId={edit.id} /> : <p className="muted">Salve o setor para poder adicionar fotos.</p>}
            <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={edit.restringe} onChange={(e) => setEdit({ ...edit, restringe: e.target.checked })} /> Este setor só aceita algumas mesas</label>
            {edit.restringe && (
              <div className="field" style={{ marginTop: 8 }}>
                <label>Mesas aceitas e quantas cabem (deixe a quantidade em branco para não limitar)</label>
                {tipos.filter((t) => t.active).map((t) => {
                  const id = String(t.id), on = edit.regras[id] !== undefined;
                  return (
                    <div className="row" key={t.id} style={{ gap: 8, marginTop: 4 }}>
                      <label className="row" style={{ gap: 8, flex: 1 }}><input type="checkbox" checked={on} onChange={() => alternarMesa(id)} /> {t.name} ({t.seats} lugar(es))</label>
                      {on && <input type="number" min="1" max="100" placeholder="até quantas" style={{ maxWidth: 120 }} value={edit.regras[id]} onChange={(e) => setEdit({ ...edit, regras: { ...edit.regras, [id]: e.target.value } })} />}
                    </div>
                  );
                })}
                {!tipos.some((t) => t.active) && <span className="muted">Cadastre os tipos de mesa na aba Mesas.</span>}
              </div>
            )}
            <label className="row" style={{ gap: 8, marginTop: 8 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Setor ativo (aceita reservas)</label>
            <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- tipos de mesa
function Mesas() {
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('/scenarium/table-types').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  async function salvar(e) {
    e.preventDefault(); setErr('');
    const body = { name: edit.name, seats: Number(edit.seats), space: edit.space, active: edit.active };
    try {
      if (edit.id) await api('/scenarium/table-types/' + edit.id, { method: 'PUT', body });
      else await api('/scenarium/table-types', { method: 'POST', body });
      setEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  const apagar = async (t) => {
    if (!confirm(`Apagar a mesa "${t.name}"? As reservas já feitas continuam como estão.`)) return;
    try { await api('/scenarium/table-types/' + t.id, { method: 'DELETE' }); load(); } catch (e) { setErr(e.message); }
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0 }}>Cada tipo de mesa tem seus lugares e o espaço que ocupa. Mudar aqui não altera reservas já feitas.</p>
        <button className="btn primary" onClick={() => { setErr(''); setEdit({ name: '', seats: '', space: '', active: true }); }}>+ Nova mesa</button>
      </div>
      {err && !edit && <div className="error">{err}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Mesa</th><th>Lugares</th><th>Espaço que ocupa</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td><td>{t.seats}</td><td>{n1(t.space)}</td><td>{t.active ? 'Ativa' : 'Desativada'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => { setErr(''); setEdit({ id: t.id, name: t.name, seats: t.seats, space: String(t.space).replace('.', ','), active: t.active }); }}>Editar</button>{' '}
                  <button className="btn sm" onClick={() => apagar(t)}>Apagar</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="5" className="muted">Nenhuma mesa cadastrada.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={salvar}>
            <h2>{edit.id ? 'Editar mesa' : 'Nova mesa'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome *</label><input value={edit.name} maxLength={60} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Ex.: Mesa de 4" required /></div>
            <div className="row">
              <div className="field"><label>Lugares *</label><input type="number" min="1" max="200" value={edit.seats} onChange={(e) => setEdit({ ...edit, seats: e.target.value })} required /></div>
              <div className="field"><label>Espaço que ocupa *</label><input value={edit.space} onChange={(e) => setEdit({ ...edit, space: e.target.value })} required /></div>
            </div>
            <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Mesa ativa</label>
            <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}
