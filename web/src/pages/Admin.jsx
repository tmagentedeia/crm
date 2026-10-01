import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { MODULES, moduleOn } from '../modules.js';

const FORM_VAZIO = () => ({
  name: '', owner_name: '', email: '', password: '', template_id: '',
  modules: Object.fromEntries(MODULES.map((m) => [m.key, true])),
});

export default function Admin() {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState({}); // id -> valor digitado
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [novaChave, setNovaChave] = useState(null); // { id, empresa, chave } — mostrada uma única vez
  const [copiada, setCopiada] = useState(false);
  const [form, setForm] = useState(null); // null = formulário "Nova empresa" fechado
  const [criando, setCriando] = useState(false);
  const [modelos, setModelos] = useState([]);
  const [salvarModelo, setSalvarModelo] = useState(null); // { company_id, empresa, name, description }
  const loadModelos = () => api('/admin/templates').then(setModelos).catch((e) => setErr(e.message));
  const load = () => { loadModelos(); return api('/admin/companies').then(setList).catch((e) => setErr(e.message)); };
  useEffect(() => { load(); }, []);

  async function guardarModelo(e) {
    e.preventDefault();
    setErr(''); setMsg('');
    try {
      await api('/admin/templates', { method: 'POST', body: { company_id: salvarModelo.company_id, name: salvarModelo.name, description: salvarModelo.description } });
      setMsg(`Modelo "${salvarModelo.name}" salvo, sem nenhum dado de clientes.`);
      setSalvarModelo(null);
      loadModelos();
    } catch (e2) { setErr(e2.message); }
  }
  async function apagarModelo(m) {
    if (!window.confirm(`Apagar o modelo "${m.name}"? As empresas já criadas com ele não mudam.`)) return;
    setErr(''); setMsg('');
    try { await api('/admin/templates/' + m.id, { method: 'DELETE' }); loadModelos(); } catch (e2) { setErr(e2.message); }
  }
  // Escolher um modelo na tela "Nova empresa" já marca os módulos dele (dá para ajustar antes de criar)
  function escolherModelo(id) {
    const m = modelos.find((x) => String(x.id) === String(id));
    setForm({ ...form, template_id: id,
      modules: m ? Object.fromEntries(MODULES.map((x) => [x.key, moduleOn(m.modules, x.key)])) : form.modules });
  }

  const shown = (s) => (s.id in edit ? edit[s.id] : s.max_professionals ?? '');

  async function save(s) {
    setErr(''); setMsg('');
    try {
      await api('/admin/companies/' + s.id, { method: 'PUT', body: { max_professionals: edit[s.id] === '' ? null : Number(edit[s.id]) } });
      setEdit(({ [s.id]: _, ...rest }) => rest);
      setMsg(`Limite de "${s.name}" atualizado.`);
      load();
    } catch (e) { setErr(e.message); }
  }

  async function gerarChave(s) {
    if (s.api_key_hint && !window.confirm(
      `Gerar uma nova chave para "${s.name}"?\n\nA chave atual deixa de funcionar na hora, e as integrações dessa empresa só voltam a funcionar quando receberem a nova.`)) return;
    setErr(''); setMsg(''); setCopiada(false);
    try {
      const r = await api(`/admin/companies/${s.id}/api-key`, { method: 'POST' });
      setNovaChave({ id: s.id, empresa: s.name, chave: r.api_key });
      load();
    } catch (e) { setErr(e.message); }
  }

  async function alternarModulo(s, key) {
    setErr(''); setMsg('');
    try {
      await api(`/admin/companies/${s.id}/modules`, { method: 'PUT', body: { modules: { [key]: !moduleOn(s.modules, key) } } });
      load();
    } catch (e) { setErr(e.message); }
  }

  async function criarEmpresa(e) {
    e.preventDefault();
    setErr(''); setMsg(''); setCopiada(false); setCriando(true);
    try {
      const r = await api('/admin/companies', { method: 'POST', body: form });
      setNovaChave({ id: r.id, empresa: r.name, chave: r.api_key });
      setMsg(`Empresa "${r.name}" criada. O responsável entra com ${r.owner_email}.`);
      setForm(null);
      load();
    } catch (e2) { setErr(e2.message); } finally { setCriando(false); }
  }

  async function copiar() {
    try { await navigator.clipboard.writeText(novaChave.chave); setCopiada(true); } catch { setCopiada(false); }
  }

  const setF = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1>Administração</h1>
        {!form && <button className="btn primary" onClick={() => { setForm(FORM_VAZIO()); setErr(''); }}>+ Nova empresa</button>}
      </div>
      <p className="muted" style={{ marginBottom: 16 }}>Empresas cadastradas, limite de profissionais, módulos e chave de integração de cada uma. Deixe o limite vazio para não ter limite.</p>
      {msg && <div className="card" style={{ marginBottom: 12, color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error">{err}</div>}

      {form && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={criarEmpresa}>
          <h2 style={{ marginBottom: 10 }}>Nova empresa</h2>
          <div className="field">
            <label>Começar do modelo</label>
            <select value={form.template_id} onChange={(e) => escolherModelo(e.target.value)}>
              <option value="">Em branco (sem modelo)</option>
              {modelos.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.categorias} categoria(s), {m.servicos} serviço(s)</option>)}
            </select>
            {form.template_id && <span className="muted">Traz módulos, categorias, serviços, configurações e o manual do atendente. Não traz clientes, agenda nem profissionais.</span>}
          </div>
          <div className="field"><label>Nome da empresa</label><input value={form.name} onChange={setF('name')} required /></div>
          <div className="field"><label>Nome do responsável</label><input value={form.owner_name} onChange={setF('owner_name')} required /></div>
          <div className="field"><label>E-mail do responsável (é o login dele)</label><input type="email" value={form.email} onChange={setF('email')} required /></div>
          <div className="field"><label>Senha inicial (8 ou mais caracteres)</label><input type="password" value={form.password} onChange={setF('password')} required minLength={8} autoComplete="new-password" /></div>
          <div className="field">
            <label>Módulos liberados</label>
            {MODULES.map((m) => (
              <label key={m.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '4px 0', fontWeight: 'normal' }}>
                <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={form.modules[m.key]}
                  onChange={(e) => setForm({ ...form, modules: { ...form.modules, [m.key]: e.target.checked } })} />
                <span><strong>{m.label}</strong> <span className="muted">— {m.desc}</span></span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={criando}>{criando ? 'Criando…' : 'Criar empresa'}</button>
            <button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {salvarModelo && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={guardarModelo}>
          <h2 style={{ marginBottom: 6 }}>Salvar "{salvarModelo.empresa}" como modelo</h2>
          <p className="muted" style={{ marginBottom: 10 }}>Guarda módulos, configurações, categorias, serviços e o manual do atendente publicado. Não guarda clientes, agenda, profissionais, atualizações provisórias, logotipo nem dados da empresa.</p>
          <div className="field"><label>Nome do modelo</label><input value={salvarModelo.name} onChange={(e) => setSalvarModelo({ ...salvarModelo, name: e.target.value })} required /></div>
          <div className="field"><label>Descrição (opcional)</label><input value={salvarModelo.description} onChange={(e) => setSalvarModelo({ ...salvarModelo, description: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary">Salvar modelo</button>
            <button type="button" className="btn" onClick={() => setSalvarModelo(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {novaChave && (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong>Chave de "{novaChave.empresa}" · código da empresa: {novaChave.id}</strong>
          <p className="muted" style={{ margin: '6px 0 10px' }}>Copie e guarde agora: por segurança, a chave não será mostrada de novo.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input readOnly value={novaChave.chave} style={{ flex: 1, minWidth: 260, fontFamily: 'monospace' }}
              onFocus={(e) => e.target.select()} />
            <button className="btn primary" onClick={copiar}>{copiada ? 'Copiada!' : 'Copiar'}</button>
            <button className="btn" onClick={() => setNovaChave(null)}>Fechar</button>
          </div>
        </div>
      )}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Código</th><th>Empresa</th><th>E-mail do responsável</th><th>Criado em</th><th>Ativos</th><th>Limite</th><th>Módulos</th><th>Chave de integração</th><th>Modelo</th><th></th></tr></thead>
          <tbody>
            {list.map((s) => {
              const changed = s.id in edit;
              return (
                <tr key={s.id}>
                  <td>{s.id}</td>
                  <td>{s.name}</td>
                  <td>{s.owner_email || <span className="muted">—</span>}</td>
                  <td>{fmtDate(s.created_at)}</td>
                  <td>{s.ativos}</td>
                  <td style={{ width: 130 }}>
                    <input type="number" min="0" placeholder="sem limite" value={shown(s)}
                      onChange={(e) => setEdit({ ...edit, [s.id]: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && changed && save(s)} />
                  </td>
                  <td style={{ minWidth: 170 }}>
                    {MODULES.map((m) => (
                      <label key={m.key} title={m.desc} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 'normal', whiteSpace: 'nowrap' }}>
                        <input type="checkbox" style={{ width: 'auto' }} checked={moduleOn(s.modules, m.key)} onChange={() => alternarModulo(s, m.key)} />
                        {m.label}
                      </label>
                    ))}
                  </td>
                  <td>
                    {s.api_key_hint
                      ? <><span style={{ fontFamily: 'monospace' }}>crm_…{s.api_key_hint}</span> <span className="muted">· gerada em {fmtDate(s.api_key_created_at)}</span></>
                      : <span className="muted">Sem chave</span>}
                    {' '}
                    <button className="btn sm" onClick={() => gerarChave(s)}>{s.api_key_hint ? 'Regenerar' : 'Gerar chave'}</button>
                  </td>
                  <td>
                    <button className="btn sm" onClick={() => setSalvarModelo({ company_id: s.id, empresa: s.name, name: '', description: '' })}>Salvar como modelo</button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {changed && <button className="btn sm primary" onClick={() => save(s)}>Salvar</button>}
                  </td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan="10" className="muted">Nenhuma empresa cadastrada.</td></tr>}
          </tbody>
        </table>
      </div>
    
      {modelos.length > 0 && (
        <div className="card table-wrap" style={{ marginTop: 16 }}>
          <h2 style={{ marginBottom: 10 }}>Modelos</h2>
          <table>
            <thead><tr><th>Modelo</th><th>Descrição</th><th>Conteúdo</th><th></th></tr></thead>
            <tbody>
              {modelos.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.description || <span className="muted">—</span>}</td>
                  <td className="muted">{m.categorias} categoria(s) · {m.servicos} serviço(s){m.tem_manual ? ' · manual do atendente' : ''}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => apagarModelo(m)}>Apagar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
