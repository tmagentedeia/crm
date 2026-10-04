import CampoSenha from '../senha.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { api, fmtDate, getToken, setToken, ADMIN_KEY } from '../api.js';
import { MODULES, moduleOn } from '../modules.js';
import { PLANOS, planoDe } from '../plans.js';
import { IconeCadeado, IconeOlho } from '../icones.jsx';
import { ROTULOS } from '../rotulos.js';

const FORM_VAZIO = () => ({
  name: '', owner_name: '', email: '', referral_code: '', password: '', template_id: '',
  modules: Object.fromEntries(MODULES.map((m) => [m.key, !['casa_de_shows', 'documentos', 'delivery', 'restaurante'].includes(m.key)])),  // Casa de Shows só entra quando o administrador marca; o Programa de benefícios já nasce ligado
});

// Campo com rótulo pequeno em cima (definido aqui fora para os campos não perderem o foco ao digitar)
const Campo = ({ rotulo, children, style }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, ...style }}>
    <span className="muted" style={{ fontSize: 12 }}>{rotulo}</span>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 34 }}>{children}</div>
  </div>
);

export default function Admin() {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState({}); // id -> valor digitado
  const [cx, setCx] = useState({}); // id -> { i: instância, p: prefixo } digitados (bloqueios)
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [versao, setVersao] = useState(null);
  const [menuPadrao, setMenuPadrao] = useState(null);
  const [origemMenu, setOrigemMenu] = useState('');
  const [acessos, setAcessos] = useState(null); // null = fechado
  const cartaoChave = useRef(null);
  const [novaChave, setNovaChave] = useState(null); // { id, empresa, chave } — mostrada uma única vez
  const [copiada, setCopiada] = useState(false);
  const [form, setForm] = useState(null); // null = formulário "Nova empresa" fechado
  const [criando, setCriando] = useState(false);
  const [modelos, setModelos] = useState([]);
  const [salvarModelo, setSalvarModelo] = useState(null); // { company_id, empresa, name, description }
  const loadModelos = () => api('/admin/templates').then(setModelos).catch((e) => setErr(e.message));
  useEffect(() => { api('/admin/version').then(setVersao).catch(() => {}); api('/admin/default-menu').then(setMenuPadrao).catch(() => {}); api('/admin/upgrade').then(setUp).catch(() => {}); }, []);
  const definirMenuPadrao = (body, ok) => { setErr(''); setMsg(''); api('/admin/default-menu', { method: 'PUT', body }).then((r) => { setMenuPadrao(r); setMsg(ok); }).catch((e) => setErr(e.message)); };
  const verAcessos = () => (acessos ? setAcessos(null) : api('/admin/access-log').then(setAcessos).catch((e) => setErr(e.message)));
  const salvarCx = async (s) => {
    setErr(''); setMsg('');
    try {
      await api(`/admin/companies/${s.id}/blocks-config`, { method: 'PUT', body: { whatsapp_instance: cx[s.id].i, redis_prefix: cx[s.id].p } });
      const { [s.id]: _, ...resto } = cx; setCx(resto); setMsg('Bloqueios de ' + s.name + ' atualizados.'); load();
    } catch (e) { setErr(e.message); }
  };
  const [up, setUp] = useState({ phone: '', text: '' }); // contato e texto do aviso de upgrade
  const [opAgenda, setOpAgenda] = useState(null); // id da empresa cujas opções da Agenda estão abertas
  const [opcoes, setOpcoes] = useState(null); // id da empresa cujas opções do Atendente estão abertas
  const [nomes, setNomes] = useState(null); // { id, empresa, modulo, valores } — nomes do módulo em edição
  const [abertas, setAbertas] = useState({});
  const [em, setEm] = useState({}); // id -> e-mail do responsável em edição
  const [trocaEmail, setTrocaEmail] = useState(null); // { id, empresa, de, para, senha }
  const [wh, setWh] = useState({}); // endereço do fluxo de campanhas em edição, por empresa
  const salvarWh = async (s) => {
    setErr(''); setMsg('');
    try {
      await api(`/admin/companies/${s.id}/campaign-webhook`, { method: 'PUT', body: { url: wh[s.id] } });
      const { [s.id]: _, ...resto } = wh; setWh(resto); setMsg('Endereço do envio de campanhas de ' + s.name + ' atualizado.'); load();
    } catch (e) { setErr(e.message); }
  };
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

  async function salvarNomes() {
    setErr(''); setMsg('');
    try {
      const atual = list.find((x) => x.id === nomes.id)?.module_labels || {};
      await api(`/admin/companies/${nomes.id}/labels`, { method: 'PUT', body: { labels: { ...atual, [nomes.modulo]: nomes.valores } } });
      setMsg(`Nomes de "${nomes.empresa}" atualizados.`);
      setNomes(null); load();
    } catch (e) { setErr(e.message); }
  }
  async function confirmarEmail() {
    setErr(''); setMsg('');
    try {
      const r = await api(`/admin/companies/${trocaEmail.id}/owner`, { method: 'PUT', body: { email: trocaEmail.para, password: trocaEmail.senha } });
      setMsg(`E-mail do responsável de "${trocaEmail.empresa}" agora é ${r.owner_email}, com a senha nova.`);
      setEm((x) => { const n = { ...x }; delete n[trocaEmail.id]; return n; });
      setTrocaEmail(null); load();
    } catch (e) { setErr(e.message); }
  }
  async function salvarModo(s, modo) {
    setErr(''); setMsg('');
    try {
      await api('/admin/companies/' + s.id, { method: 'PUT', body: { booking_mode: modo } });
      setMsg(`Agendamento de "${s.name}": ${modo === 'confirm' ? 'sob confirmação' : 'automático'}.`);
      load();
    } catch (e) { setErr(e.message); }
  }

  // Entra no painel da empresa sem usar a senha dela (acesso temporário, registrado). O acesso do administrador fica guardado para voltar.
  async function abrirPainel(s) {
    try {
      const r = await api(`/admin/companies/${s.id}/impersonate`, { method: 'POST' });
      localStorage.setItem(ADMIN_KEY, getToken());
      setToken(r.token);
      localStorage.setItem('crm_company', JSON.stringify(r.company));
      location.hash = 'dashboard';
      location.reload();
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

  async function alternarVitrine(s, key) {
    setErr(''); setMsg('');
    try {
      await api(`/admin/companies/${s.id}/locks`, { method: 'PUT', body: { locks: { [key]: !(s.locked_modules?.[key] === true) } } });
      load();
    } catch (e) { setErr(e.message); }
  }
  async function salvarUpgrade() {
    setErr(''); setMsg('');
    try { setUp(await api('/admin/upgrade', { method: 'PUT', body: up })); setMsg('Aviso de upgrade salvo.'); } catch (e) { setErr(e.message); }
  }

  async function aplicarPlano(s, p) {
    if (!confirm(`Aplicar o plano ${p.nome} a ${s.name}?\n\nIsso liga os módulos do plano, desliga os demais e deixa os que ficam de fora à vista, apagados, com o convite de upgrade. O limite de profissionais não muda.`)) return;
    setErr(''); setMsg('');
    try { await api(`/admin/companies/${s.id}/plan`, { method: 'PUT', body: { plan: p.id } }); setMsg(`Plano ${p.nome} aplicado a ${s.name}`); load(); } catch (e) { setErr(e.message); }
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

  // a chave nova aparece no topo da página: leva a tela até lá para não passar despercebida
  useEffect(() => { if (novaChave) cartaoChave.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [novaChave]);

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
      {versao && (
        <p className="muted" style={{ marginBottom: 8 }}>
          Versão no ar: {versao.commit ? <strong>{versao.commit}</strong> : 'código não informado'} · desde {new Date(versao.started_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
        </p>
      )}
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
          <div className="field"><label>Código de indicação (opcional; é o cupom que a pessoa informou ao contratar)</label><input value={form.referral_code} onChange={setF('referral_code')} placeholder="M2-NomeDaEmpresaQueIndicou" /></div>
          <div className="field"><label>Senha inicial (8 ou mais caracteres)</label><CampoSenha value={form.password} onChange={setF('password')} required minLength={8} autoComplete="new-password" /></div>
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
        <div className="card" ref={cartaoChave} style={{ marginBottom: 16, scrollMarginTop: 12 }}>
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

      {opAgenda && (() => {
        const emp = list.find((x) => x.id === opAgenda);
        if (!emp) return null;
        return (
          <div className="modal-bg" onClick={() => setOpAgenda(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Opções da Agenda — {emp.name}</h2>
              <div className="field"><label>Como o atendente marca horários</label>
                <select value={emp.booking_mode || 'auto'} onChange={(e) => salvarModo(emp, e.target.value)}>
                  <option value="auto">Automático (horários fixos)</option>
                  <option value="confirm">Sob confirmação</option>
                </select></div>
              {err && <div className="error">{err}</div>}
              <div className="row"><button className="btn primary" onClick={() => setOpAgenda(null)}>Fechar</button></div>
            </div>
          </div>
        );
      })()}

      {opcoes && (() => {
        const emp = list.find((x) => x.id === opcoes);
        if (!emp) return null;
        return (
          <div className="modal-bg" onClick={() => setOpcoes(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Opções do Atendente — {emp.name}</h2>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 'normal' }}>
                <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={moduleOn(emp.modules, 'assistente')} onChange={() => alternarModulo(emp, 'assistente')} />
                <span><strong>Assistente pessoal</strong><br /><span className="muted">Um segundo agente, o assistente pessoal do proprietário, com manual e atualizações provisórias próprios, ao lado do atendente. Desligado, a empresa vê a aba apagada, com convite de upgrade.</span></span>
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 'normal', marginTop: 12 }}>
                <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={moduleOn(emp.modules, 'lembrete_cliente')} onChange={() => alternarModulo(emp, 'lembrete_cliente')} />
                <span><strong>Lembrete a pedido do cliente</strong><br /><span className="muted">O cliente pode pedir ao atendente para ser lembrado de algo, e o atendente agenda o aviso. Desligado, o atendente não oferece nem agenda esses lembretes (os avisos automáticos de horário continuam).</span></span>
              </label>
              {err && <div className="error">{err}</div>}
              <div className="row"><button className="btn primary" onClick={() => setOpcoes(null)}>Fechar</button></div>
            </div>
          </div>
        );
      })()}

      {nomes && (
        <div className="modal-bg" onClick={() => setNomes(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Nomes do módulo — {nomes.empresa}</h2>
            <p className="muted">Troca só o texto das telas desta empresa; o funcionamento é o mesmo. Em branco vale o nome padrão.</p>
            {Object.entries(ROTULOS[nomes.modulo]).map(([k, v]) => (
              <div className="field" key={k}><label>{v.label}</label>
                <input maxLength={30} placeholder={v.padrao} value={nomes.valores[k] || ''}
                  onChange={(e) => setNomes({ ...nomes, valores: { ...nomes.valores, [k]: e.target.value } })} /></div>
            ))}
            {err && <div className="error">{err}</div>}
            <div className="row">
              <button className="btn primary" onClick={salvarNomes}>Salvar</button>
              <button className="btn" onClick={() => setNomes({ ...nomes, valores: {} })}>Voltar ao padrão</button>
              <button className="btn" onClick={() => setNomes(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {trocaEmail && (
        <div className="modal-bg" onClick={() => setTrocaEmail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Trocar o e-mail de login?</h2>
            <p>Empresa <strong>{trocaEmail.empresa}</strong>:<br />de <strong>{trocaEmail.de}</strong><br />para <strong>{trocaEmail.para}</strong></p>
            <div className="field"><label>Senha nova para este login (8 ou mais caracteres)</label>
              <CampoSenha value={trocaEmail.senha} onChange={(e) => setTrocaEmail({ ...trocaEmail, senha: e.target.value })} autoFocus autoComplete="new-password" />
            </div>
            {err && <div className="error">{err}</div>}
            <div className="row">
              <button className="btn primary" disabled={trocaEmail.senha.length < 8} onClick={confirmarEmail}>Trocar e-mail e senha</button>
              <button className="btn" onClick={() => setTrocaEmail(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {list.map((s) => {
        const changed = s.id in edit;
        return (
          <div key={s.id} className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Campo rotulo=" ">
                <button className="btn sm" title={abertas[s.id] ? 'Recolher' : 'Expandir'} onClick={() => setAbertas({ ...abertas, [s.id]: !abertas[s.id] })}>{abertas[s.id] ? '▾' : '▸'}</button>
              </Campo>
              <Campo rotulo="Código"><strong>{s.id}</strong></Campo>
              <Campo rotulo="Empresa"><strong style={{ cursor: 'pointer', color: '#d4a017', fontSize: 16 }} onClick={() => setAbertas({ ...abertas, [s.id]: !abertas[s.id] })}>{s.name}</strong></Campo>
              <Campo rotulo=" ">
                <button className="btn" style={{ fontWeight: 700, fontSize: 14, padding: '7px 18px', background: '#d4a017', borderColor: '#d4a017', color: '#1a1a1a' }} onClick={() => abrirPainel(s)}>Abrir painel</button>
              </Campo>
              <Campo rotulo="E-mail do responsável">
                {s.owner_email
                  ? <input type="email" value={em[s.id] ?? s.owner_email} title="Clique, edite e aperte Enter para trocar" style={{ width: '22ch', minWidth: 0 }}
                      onChange={(e) => setEm({ ...em, [s.id]: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEm((x) => { const n = { ...x }; delete n[s.id]; return n; });
                        if (e.key === 'Enter' && em[s.id] !== undefined && em[s.id].trim().toLowerCase() !== s.owner_email.toLowerCase())
                          setTrocaEmail({ id: s.id, empresa: s.name, de: s.owner_email, para: em[s.id].trim().toLowerCase(), senha: '' });
                      }} />
                  : <span className="muted">—</span>}
              </Campo>
              <Campo rotulo="Criado em"><span className="muted" style={{ fontSize: 12 }}>{fmtDate(s.created_at)}</span></Campo>
              <Campo rotulo="Vencimento">
                {s.billing_exempt ? <span className="muted">Isenta</span> : s.billing_due_day ? <span>dia {s.billing_due_day}</span> : <span className="muted">—</span>}
              </Campo>
              <Campo rotulo="Indicações"><span>{s.referrals_total ?? 0}</span></Campo>
              <Campo rotulo="Plano"><strong>{planoDe(s.modules) || 'personalizado'}</strong></Campo>
            </div>
            {abertas[s.id] && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border, #ddd)', display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 560px', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Campo rotulo="Ativos">{s.ativos}</Campo>
                <Campo rotulo="Limite">
                  <input type="number" min="0" placeholder="—" value={shown(s)} style={{ width: 50, minWidth: 50 }}
                    onChange={(e) => setEdit({ ...edit, [s.id]: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && changed && save(s)} />
                  {changed && <button className="btn sm primary" onClick={() => save(s)}>Salvar</button>}
                </Campo>
              </div>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Campo rotulo="Bloqueios (instância e prefixo)">
                  <input placeholder="instância do WhatsApp" style={{ width: 170 }} value={cx[s.id]?.i ?? s.whatsapp_instance ?? ''}
                    onChange={(e) => setCx({ ...cx, [s.id]: { i: e.target.value, p: cx[s.id]?.p ?? s.redis_prefix ?? '' } })} />
                  <input placeholder="prefixo (opcional)" style={{ width: 150 }} value={cx[s.id]?.p ?? s.redis_prefix ?? ''}
                    onChange={(e) => setCx({ ...cx, [s.id]: { i: cx[s.id]?.i ?? s.whatsapp_instance ?? '', p: e.target.value } })} />
                  {s.id in cx && <button className="btn sm primary" onClick={() => salvarCx(s)}>Salvar</button>}
                </Campo>
                <Campo rotulo="Envio de campanhas (endereço do fluxo)">
                  <input placeholder="https://…/webhook/campanhas-envio" style={{ width: 300 }} value={wh[s.id] ?? s.campaign_webhook_url ?? ''}
                    onChange={(e) => setWh({ ...wh, [s.id]: e.target.value })} />
                  {s.id in wh && <button className="btn sm primary" onClick={() => salvarWh(s)}>Salvar</button>}
                </Campo>
                <Campo rotulo="Chave de integração">
                  {s.api_key_hint
                    ? <><span style={{ fontFamily: 'monospace' }}>crm_…{s.api_key_hint}</span> <span className="muted">· gerada em {fmtDate(s.api_key_created_at)}</span></>
                    : <span className="muted">Sem chave</span>}
                  <button className="btn sm" onClick={() => gerarChave(s)}>{s.api_key_hint ? 'Regenerar' : 'Gerar chave'}</button>
                  {novaChave?.id === s.id && (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input readOnly value={novaChave.chave} style={{ width: 280, fontFamily: 'monospace' }} onFocus={(e) => e.target.select()} />
                      <button className="btn sm primary" onClick={copiar}>{copiada ? 'Copiada!' : 'Copiar'}</button>
                    </span>
                  )}
                </Campo>
                <Campo rotulo="Modelo">
                  <button className="btn sm" onClick={() => setSalvarModelo({ company_id: s.id, empresa: s.name, name: '', description: '' })}>Salvar como modelo</button>
                </Campo>
              </div>
            </div>
            <div style={{ flex: '0 0 auto' }}>
              <span className="muted" style={{ fontSize: 12 }}>Plano: <strong>{planoDe(s.modules) || 'personalizado'}</strong></span>
              <div className="row" style={{ gap: 6, margin: '4px 0 8px' }}>
                {PLANOS.map((p) => (
                  <button key={p.id} type="button" className={'btn sm' + (planoDe(s.modules) === p.nome ? ' primary' : '')} onClick={() => aplicarPlano(s, p)}>{p.nome}</button>
                ))}
              </div>
              <span className="muted" style={{ fontSize: 12 }}>Módulos</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, max-content)', columnGap: 22, rowGap: 2, marginTop: 3 }}>
                {MODULES.map((m) => (
                  <label key={m.key} title={m.desc} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 'normal', whiteSpace: 'nowrap' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={moduleOn(s.modules, m.key)} onChange={() => alternarModulo(s, m.key)} />
                    {m.label}
                    {!moduleOn(s.modules, m.key) && (
                      <button type="button" className="btn sm" style={{ padding: '0 6px', lineHeight: 0, opacity: s.locked_modules?.[m.key] === true ? .9 : .5 }}
                        title={s.locked_modules?.[m.key] === true ? 'Aparece apagada para a empresa (convite de upgrade). Toque para esconder.' : 'Escondida da empresa. Toque para mostrar apagada, com convite de upgrade.'}
                        onClick={(e) => { e.preventDefault(); alternarVitrine(s, m.key); }}>{s.locked_modules?.[m.key] === true ? <IconeCadeado size={13} /> : <IconeOlho cortado size={13} />}</button>
                    )}
                    {(ROTULOS[m.key] || m.key === 'atendente' || m.key === 'agenda') && moduleOn(s.modules, m.key) && (
                      <button type="button" className="btn sm" style={{ padding: '0 6px' }} title={m.key === 'atendente' ? 'Opções do atendente' : m.key === 'agenda' ? 'Opções da agenda' : 'Personalizar os nomes deste módulo'}
                        onClick={(e) => {
                          e.preventDefault();
                          if (m.key === 'atendente') setOpcoes(s.id);
                          else if (m.key === 'agenda') setOpAgenda(s.id);
                          else setNomes({ id: s.id, empresa: s.name, modulo: m.key, valores: { ...(s.module_labels?.[m.key] || {}) } });
                        }}>✏️</button>
                    )}
                  </label>
                ))}
              </div>
            </div>
            </div>
            )}
          </div>
        );
      })}
      {!list.length && <div className="card muted">Nenhuma empresa cadastrada.</div>}
    
      <div className="card table-wrap" style={{ marginTop: 16 }}>
        <button className="btn sm" onClick={verAcessos}>{acessos ? 'Esconder' : 'Ver'} acessos do administrador às empresas</button>
        {acessos && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Quando</th><th>Empresa</th><th>Quem entrou</th></tr></thead>
            <tbody>
              {acessos.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(a.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{a.company_name || `Empresa ${a.company_id}`}</td>
                  <td>{a.admin_email || '—'}</td>
                </tr>
              ))}
              {!acessos.length && <tr><td colSpan="3" className="muted">Nenhum acesso registrado ainda.</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginBottom: 6 }}>Aviso de upgrade</h2>
        <p className="muted" style={{ marginBottom: 10 }}>
          Aparece quando a empresa toca numa função apagada (com cadeado). Vale para todas as empresas. Em cada empresa, use o botão ao lado da função desligada para escolher se ela aparece apagada ou fica escondida.
        </p>
        <div className="field"><label>WhatsApp para receber o interesse (com DDI e DDD, só números)</label>
          <input value={up.phone} placeholder="5532999999999" onChange={(e) => setUp({ ...up, phone: e.target.value })} /></div>
        <div className="field"><label>Texto do aviso (em branco usa o texto padrão)</label>
          <textarea rows={2} maxLength={300} value={up.text} placeholder="Esta função não está no seu plano atual. Fale com a gente para liberar." onChange={(e) => setUp({ ...up, text: e.target.value })} /></div>
        <button className="btn primary" onClick={salvarUpgrade}>Salvar aviso</button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginBottom: 6 }}>Menu padrão das empresas novas</h2>
        <p className="muted" style={{ marginBottom: 10 }}>
          Nomes e ícones do menu com que nasce uma empresa criada <strong>sem modelo</strong>. Empresas que já existem e as criadas de um modelo não mudam.
          {' '}{menuPadrao && Object.keys(menuPadrao.menu_custom || {}).length
            ? <>Hoje vale o menu de <strong>{menuPadrao.from_company_name}</strong>.</>
            : 'Hoje vale o menu original.'}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={origemMenu} onChange={(e) => setOrigemMenu(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Escolha a empresa de onde copiar</option>
            {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="btn primary" disabled={!origemMenu} onClick={() => definirMenuPadrao({ company_id: Number(origemMenu) }, 'Menu padrão atualizado.')}>Usar o menu desta empresa</button>
          <button className="btn" onClick={() => definirMenuPadrao({ clear: true }, 'Voltou ao menu original.')}>Voltar ao menu original</button>
        </div>
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
