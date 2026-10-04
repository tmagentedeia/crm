import { rotulosDe } from '../rotulos.js';
import React, { useEffect, useState } from 'react';
import { Nome } from '../menu.jsx';
import { api, fmtDate, fmtPhone, fmtTime, money } from '../api.js';
import { moduleOn } from '../modules.js';
import { useSelecao, CelulaTodos, CelulaLinha, ApagarSelecionados, resumoApagado } from '../selecao.jsx';

// Planilha: células que começam com = + - @ viram texto (evita fórmula embutida em nome ou observação)
const cel = (v) => {
  const t = String(v ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
  return /^[=+\-@]/.test(t) ? "'" + t : t;
};
const dataBr = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '');
const SITUACAO = { member: 'Membro', former: 'Ex-membro', supporter: 'Contribuinte' };
const GENERO = { female: 'Feminino', male: 'Masculino', other: 'Outro' };
const dm = (d, m, y) => (d && m ? String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + (y ? '/' + y : '') : '');
const COLUNAS = ['Nome', 'Sobrenome', 'Telefone', 'Tipo', 'Origem', 'Cidade', 'Estado', 'Data de nascimento', 'Gênero', 'Situação no programa', 'Nível', 'Última visita', 'Cadastrado em', 'Atualizado em', 'Observações'];
const linhas = (rows) => rows.map((c) => [c.name, c.last_name, c.phone, c.status === 'client' ? 'Cliente' : 'Lead', c.source === 'ia' ? 'Agente IA' : 'Manual', c.city, c.state, dm(c.birth_day, c.birth_month, c.birth_year), GENERO[c.gender], SITUACAO[c.club_status], c.club_level_name, dataBr(c.last_visit_at), dataBr(c.created_at), dataBr(c.updated_at), c.notes].map(cel));
// aceita 25/09 ou 25/09/1990; devolve o que o servidor entende
const nomeCompleto = (c) => [c.name, c.last_name].filter(Boolean).join(' ');

const PERFIL = { buyer: 'Comprador', hirer: 'Contratante' };

const STATUS = { pending: 'Aguardando confirmação', scheduled: 'Agendado', attended: 'Compareceu', no_show: 'Faltou', cancelled: 'Cancelado' };

export default function Clientes({ company }) {
  const clube = moduleOn(company?.modules, 'clube');
  const scn = moduleOn(company?.modules, 'scenarium');
  const [perfil, setPerfil] = useState('');
  const [club, setClub] = useState(null);
  const [sit, setSit] = useState('');
  const [nivel, setNivel] = useState('');
  useEffect(() => { if (clube) api('/club').then(setClub).catch(() => {}); }, [clube]);
  const [tab, setTab] = useState('');
  const [search, setSearch] = useState('');
  const [ordem, setOrdem] = useState('');   // '', name-asc, name-desc, city-asc, city-desc
  const [list, setList] = useState([]);
  const [detail, setDetail] = useState(null);
  const [adding, setAdding] = useState(false);
  const sel = useSelecao(list);

  const qs = `status=${tab}&search=${encodeURIComponent(search)}&club=${sit}&level=${nivel}&kind=${perfil}`;
  const [campo, sentido] = ordem.split('-');
  const load = () => api(`/customers?${qs}${campo ? `&sort=${campo}&dir=${sentido}` : ''}`).then(setList);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [tab, search, sit, nivel, ordem]);

  const [aviso, setAviso] = useState('');
  const exportar = () => api(`/customers/export?${qs}`);
  // Copia em formato de tabela: é só colar numa célula do Google Planilhas ou do Excel
  const copiar = async () => {
    try {
      const rows = await exportar();
      await navigator.clipboard.writeText([COLUNAS, ...linhas(rows)].map((l) => l.join('\t')).join('\n'));
      setAviso(`${rows.length} registro(s) copiados. Cole em uma célula da planilha.`);
    } catch { setAviso('Não consegui copiar. Use "Baixar planilha".'); }
  };
  const baixar = async () => {
    try {
      const rows = await exportar();
      const aspas = (v) => '"' + String(v).replace(/"/g, '""') + '"';
      const csv = '\ufeff' + [COLUNAS, ...linhas(rows)].map((l) => l.map(aspas).join(';')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'clientes.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      setAviso(`${rows.length} registro(s) baixados.`);
    } catch { setAviso('Não consegui baixar a planilha.'); }
  };

  const open = (id) => api('/customers/' + id).then(setDetail);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1><Nome id="clientes">Clientes e Leads</Nome></h1><p className="muted">Lead = só conversou · Cliente = já comprou / contratou / compareceu</p></div>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Cadastrar cliente ou lead</button>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['', 'Todos'], ['lead', 'Leads'], ['client', 'Clientes']].map(([v, l]) => (
          <button key={v} className={'btn' + (tab === v ? ' primary' : '')} onClick={() => setTab(v)}>{l}</button>
        ))}
        {scn && (
          <select value={perfil} onChange={(e) => setPerfil(e.target.value)} style={{ maxWidth: 170 }} title="Perfil do cliente">
            <option value="">Perfil: todos</option>
            {Object.entries(PERFIL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {clube && (
          <>
            <select value={sit} onChange={(e) => { setSit(e.target.value); setNivel(''); }} style={{ maxWidth: 190 }} title="Situação no programa">
              <option value="">{club?.program_name || 'Programa de benefícios'}: todos</option>
              {Object.entries(SITUACAO).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              <option value="none">Fora do programa</option>
            </select>
            {(sit === '' || sit === 'member') && club?.levels?.length > 0 && (
              <select value={nivel} onChange={(e) => setNivel(e.target.value)} style={{ maxWidth: 160 }} title="Nível">
                <option value="">Todos os níveis</option>
                {club.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
          </>
        )}
        <select value={ordem} onChange={(e) => setOrdem(e.target.value)} style={{ maxWidth: 190 }} title="Ordem da lista">
          <option value="">Mais recentes primeiro</option>
          <option value="name-asc">Nome (A a Z)</option>
          <option value="name-desc">Nome (Z a A)</option>
          <option value="city-asc">Cidade (A a Z)</option>
          <option value="city-desc">Cidade (Z a A)</option>
        </select>
        <input placeholder="Buscar por nome ou telefone…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
        <button className="btn" onClick={copiar} title="Copia a lista para colar numa planilha">Copiar para planilha</button>
        <button className="btn" onClick={baixar} title="Baixa um arquivo que abre no Excel e no Google Planilhas">Baixar planilha</button>
      </div>
      {aviso && <p className="muted" style={{ marginBottom: 8 }}>{aviso}</p>}
      <ApagarSelecionados s={sel} total={list.length} rotulo="cliente(s)/lead(s)" rota="/customers/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, 'contato(s)')); load(); }}
        descreve={(i) => <p>Também serão apagados {i.appointments} agendamento(s) e {i.orders} pedido(s) de música desses contatos, além do lugar deles na fila de espera.</p>} />
      <div className="card table-wrap">
        <table>
          <thead><tr><CelulaTodos s={sel} /><th>Nome</th><th>Telefone</th><th>Tipo</th>{clube && <th>{club?.program_name || 'Programa de benefícios'}</th>}<th>Cidade</th><th>Última visita</th></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className="click" onClick={() => open(c.id)}>
                <CelulaLinha s={sel} id={c.id} />
                <td>{nomeCompleto(c) || <span className="muted">Sem nome</span>}</td>
                <td>{fmtPhone(c.phone)}</td>
                <td><span className={'badge ' + c.status}>{c.status === 'client' ? 'Cliente' : 'Lead'}</span>{(c.client_kinds || []).map((k) => <span key={k} className="muted"> · {PERFIL[k]}</span>)}</td>
                {clube && <td>{c.club_status ? <span className="badge">{SITUACAO[c.club_status]}{c.club_level_name ? ' · ' + c.club_level_name : ''}</span> : <span className="muted">—</span>}</td>}
                <td>{[c.city, c.state].filter(Boolean).join(' / ') || <span className="muted">—</span>}</td>
                <td>{fmtDate(c.last_visit_at)}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan="7" className="muted">Nada encontrado.</td></tr>}
          </tbody>
        </table>
      </div>
      {detail && <Detail c={detail} perfis={scn || !!detail.client_kinds?.length} nomePedidos={rotulosDe(company, 'pedidos').items} clube={clube} club={club} onClose={() => setDetail(null)} onSaved={() => { setDetail(null); load(); }} onDeleted={() => { setDetail(null); load(); }} />}
      {adding && <AddCustomer clube={clube} club={club} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </>
  );
}

function FichaCampos({ f, setF, clube, club }) {
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="row">
        <div className="field"><label>Cidade</label><input value={f.city} onChange={set('city')} /></div>
        <div className="field" style={{ maxWidth: 90 }}><label>Estado</label><input value={f.state} maxLength={2} placeholder="MG" onChange={set('state')} /></div>
      </div>
      <div className="row">
        <div className="field"><label>Data de nascimento</label><input value={f.birthday} placeholder="dd/mm/aaaa (o ano é opcional)" onChange={set('birthday')} /></div>
        <div className="field"><label>Gênero</label>
          <select value={f.gender} onChange={set('gender')}><option value="">—</option>{Object.entries(GENERO).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      </div>
      {clube && (
        <div className="row">
          <div className="field"><label>{club?.program_name || 'Programa de benefícios'}</label>
            <select value={f.club_status} onChange={(e) => setF({ ...f, club_status: e.target.value, club_level_id: e.target.value === 'member' ? f.club_level_id : '' })}>
              <option value="">Fora do programa</option>{Object.entries(SITUACAO).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          {f.club_status === 'member' && (
            <div className="field"><label>Nível</label>
              <select value={f.club_level_id} onChange={set('club_level_id')}>
                <option value="">Sem nível</option>
                {(club?.levels || []).map((l) => <option key={l.id} value={l.id}>{l.name} ({l.benefit_qty}/mês)</option>)}
              </select></div>
          )}
        </div>
      )}
    </>
  );
}
const fichaInicial = (c = {}) => ({
  city: c.city || '', state: c.state || '', gender: c.gender || '',
  birthday: dm(c.birth_day, c.birth_month, c.birth_year),
  club_status: c.club_status || '', club_level_id: c.club_level_id ? String(c.club_level_id) : '',
});
const fichaCorpo = (f, clube) => ({
  city: f.city, state: f.state, gender: f.gender || null, birthday: f.birthday,
  ...(clube ? { club_status: f.club_status || null, club_level_id: f.club_status === 'member' && f.club_level_id ? Number(f.club_level_id) : null } : {}),
});

function Detail({ c, perfis, nomePedidos, clube, club, onClose, onSaved, onDeleted }) {
  const [f, setF] = useState({ name: c.name || '', last_name: c.last_name || '', phone: c.phone || '', status: c.status, notes: c.notes || '', ...fichaInicial(c) });
  const [kinds, setKinds] = useState(c.client_kinds || []);
  const alternarPerfil = (k) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  const [err, setErr] = useState('');
  const attended = c.history.filter((h) => h.status === 'attended');
  const future = c.history.filter((h) => h.status === 'scheduled' && new Date(h.starts_at) > new Date()).length;
  const save = async () => {
    setErr('');
    try { await api('/customers/' + c.id, { method: 'PUT', body: { name: f.name, last_name: f.last_name, phone: f.phone, status: f.status, notes: f.notes, ...fichaCorpo(f, clube), ...(perfis ? { client_kinds: kinds } : {}) } }); onSaved(); } catch (e) { setErr(e.message); }
  };
  const [semCamp, setSemCamp] = useState(!!c.campaign_excluded);
  const alternarCampanhas = async () => {
    setErr('');
    try {
      if (semCamp) await api('/campaigns/exclusions/remove', { method: 'POST', body: { phone: c.phone } });
      else await api('/campaigns/exclusions', { method: 'POST', body: { phones: c.phone } });
      setSemCamp(!semCamp);
    } catch (e) { setErr(e.message); }
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
          <h2>{nomeCompleto(c) || 'Sem nome'}</h2><span className={'badge ' + c.status}>{c.status === 'client' ? 'Cliente' : 'Lead'}</span>
        </div>
        {semCamp && <p className="muted" style={{ color: 'var(--bad)' }}>Este contato não recebe campanhas.</p>}
        <p className="muted">{fmtPhone(c.phone)} · primeiro contato em {fmtDate(c.first_contact_at)} · {attended.length} visita(s) · gasto total {money(attended.reduce((s, h) => s + Number(h.price), 0))}{c.age != null ? ` · ${c.age} anos` : ''} · ficha atualizada em {fmtDate(c.updated_at)}</p>
        {err && <div className="error">{err}</div>}
        <div className="row">
          <div className="field"><label>Nome</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label>Sobrenome</label><input value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} /></div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 2 }}><label>Telefone (com DDD)</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div className="field"><label>Tipo</label>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="lead">Lead</option><option value="client">Cliente</option>
            </select></div>
        </div>
        {perfis && (
          <div className="field"><label>Perfil do cliente</label>
            <div className="row" style={{ gap: 16 }}>
              {Object.entries(PERFIL).map(([k, l]) => (
                <label key={k} className="row" style={{ gap: 6 }}><input type="checkbox" checked={kinds.includes(k)} onChange={() => alternarPerfil(k)} /> {l}</label>
              ))}
            </div>
          </div>
        )}
        <FichaCampos f={f} setF={setF} clube={clube} club={club} />
        <div className="field"><label>Observações</label><textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        <div className="row" style={{ marginBottom: 14 }}>
          <button className="btn primary" onClick={save}>Salvar</button>
          <a className="btn" href={'https://wa.me/' + c.phone} target="_blank" rel="noreferrer">WhatsApp</a>
          <button className="btn" onClick={alternarCampanhas} title="Esse número nunca recebe campanhas">{semCamp ? 'Voltar a receber campanhas' : 'Não enviar campanhas'}</button>
          <button className="btn bad" style={{ marginLeft: 'auto' }} onClick={remove}>Excluir</button>
        </div>
        {(c.orders?.length > 0 || c.balance?.franchise > 0) && (
          <>
            <h2>{nomePedidos}</h2>
            {c.courtesy_used_at && <p className="muted">Cortesia do 1º pedido usada em {new Date(c.courtesy_used_at).toLocaleDateString('pt-BR')}.</p>}
            {c.balance?.franchise > 0 && <p className="muted">Franquia do mês: usou {c.balance.used} de {c.balance.franchise} · restam {c.balance.remaining}</p>}
            {c.orders?.length > 0 ? (
              <table><tbody>{c.orders.map((o) => (
                <tr key={o.id}><td>{o.live_starts_at ? new Date(o.live_starts_at).toLocaleDateString('pt-BR') : 'Na fila'}</td><td>{o.song}</td><td>{o.kind === 'franchise' ? 'Franquia' : o.kind === 'courtesy' ? 'Cortesia' : o.kind === 'paid' ? 'Pago' : '—'}</td></tr>
              ))}</tbody></table>
            ) : <p className="muted">Sem pedidos ainda.</p>}
          </>
        )}
        {c.tickets?.rows?.length > 0 && (
          <>
            <h2>Ingressos e reservas</h2>
            <p className="muted">
              {c.tickets.purchases} compra(s) · total pago {money(c.tickets.total)}
              {c.tickets.average_ticket !== null && ` · ticket médio ${money(c.tickets.average_ticket)} por compra e ${money(c.tickets.average_per_person)} por pessoa`}
            </p>
            <table><tbody>{c.tickets.rows.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.date + 'T12:00:00').toLocaleDateString('pt-BR')}</td><td>{t.event_title || 'Reserva avulsa'}</td><td>{t.sector_name}</td>
                <td>{t.people} pessoa(s)</td><td>{t.total !== null ? money(t.total) : '—'}{t.code_word ? ` · ${t.code_word}` : ''}</td>
                <td className="muted">{t.status === 'cancelled' ? 'Cancelada' : t.status === 'no_show' ? 'Não veio' : t.status === 'attended' ? 'Compareceu' : 'Confirmada'}</td>
              </tr>
            ))}</tbody></table>
          </>
        )}
        <h2>Histórico</h2>
        {c.history.length ? (
          <table><tbody>{c.history.map((h, i) => (
            <tr key={i}><td>{fmtDate(h.starts_at)} {fmtTime(h.starts_at)}</td><td>{h.service}</td><td>{h.professional}</td><td><span className={'badge ' + h.status}>{STATUS[h.status]}</span></td></tr>
          ))}</tbody></table>
        ) : <p className="muted">Sem agendamentos ainda.</p>}
      </div>
    </div>
  );
}

function AddCustomer({ clube, club, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', last_name: '', phone: '', status: 'client', notes: '', ...fichaInicial() });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    try { await api('/customers', { method: 'POST', body: { name: f.name, last_name: f.last_name, phone: f.phone, status: f.status, notes: f.notes, ...fichaCorpo(f, clube), source: 'manual' } }); onSaved(); }
    catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Cadastrar cliente ou lead</h2>
        {err && <div className="error">{err}</div>}
        <div className="row">
          <div className="field"><label>Nome *</label><input value={f.name} onChange={set('name')} required /></div>
          <div className="field"><label>Sobrenome *</label><input value={f.last_name} onChange={set('last_name')} required /></div>
        </div>
        <div className="field"><label>Telefone (com DDD) *</label><input value={f.phone} onChange={set('phone')} required /></div>
        <div className="field"><label>Tipo</label>
          <select value={f.status} onChange={set('status')}><option value="client">Cliente</option><option value="lead">Lead</option></select></div>
        <FichaCampos f={f} setF={setF} clube={clube} club={club} />
        <div className="field"><label>Observações</label><textarea rows={2} value={f.notes} onChange={set('notes')} /></div>
        <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}
