import React, { useEffect, useState } from 'react';
import { Nome, ICONES, MENU_PADRAO } from '../menu.jsx';
import { api } from '../api.js';
import { moduleOn } from '../modules.js';

// Redimensiona a imagem no navegador (máx. 256px) e devolve um data URL leve
function resizeImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    if (file.type === 'image/svg+xml') {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      return r.readAsDataURL(file);
    }
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Nomes e ícones do menu: a empresa escolhe como cada item aparece. Vazio = padrão.
function MenuPersonalizar({ company, onSaved }) {
  const [valores, setValores] = useState(() => company.menu_custom || {});
  const [aberto, setAberto] = useState(null); // id do item com a grade de ícones aberta
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const set = (id, campo, v) => setValores((o) => ({ ...o, [id]: { ...(o[id] || {}), [campo]: v } }));
  const sujo = JSON.stringify(limpar(valores)) !== JSON.stringify(company.menu_custom || {});
  function limpar(o) {
    const out = {};
    for (const [id, v] of Object.entries(o)) {
      const it = {};
      if (v?.icon?.trim()) it.icon = v.icon.trim();
      if (v?.label?.trim()) it.label = v.label.trim();
      if (Object.keys(it).length) out[id] = it;
    }
    return out;
  }
  async function salvar(novo) {
    setErr(''); setMsg('');
    try {
      const c = await api('/company', { method: 'PUT', body: { menu_custom: limpar(novo) } });
      setValores(c.menu_custom || {}); onSaved(c); setMsg('Menu atualizado!');
    } catch (e) { setErr(e.message); }
  }
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Menu: nomes e ícones</h2>
      <p className="muted" style={{ marginBottom: 10 }}>Escolha como cada item do menu aparece para você e sua equipe. Deixando em branco, vale o padrão.</p>
      {msg && <div style={{ color: 'var(--ok)', marginBottom: 8 }}>{msg}</div>}
      {err && <div className="error">{err}</div>}
      <table>
        <thead><tr><th style={{ width: 90 }}>Ícone</th><th>Nome</th><th></th></tr></thead>
        <tbody>
          {MENU_PADRAO.filter((m) => m.id !== 'beneficios').filter((m) => m.id === 'config' || moduleOn(company.modules, m.id)).map((m) => {
            const v = valores[m.id] || {};
            return (
              <React.Fragment key={m.id}>
                <tr>
                  <td><button type="button" className="btn sm" onClick={() => setAberto(aberto === m.id ? null : m.id)} title="Trocar ícone">{v.icon || m.icon} ▾</button></td>
                  <td><input value={v.label || ''} maxLength={30} placeholder={m.label} onChange={(e) => set(m.id, 'label', e.target.value)} /></td>
                  <td style={{ textAlign: 'right' }}>
                    {(v.icon || v.label) && <button type="button" className="btn sm" onClick={() => setValores((o) => { const { [m.id]: _, ...r } = o; return r; })}>Padrão</button>}
                  </td>
                </tr>
                {aberto === m.id && (
                  <tr><td colSpan="3">
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      {ICONES.map((ic) => (
                        <button key={ic} type="button" className="btn sm" style={{ fontSize: 18 }} onClick={() => { set(m.id, 'icon', ic); setAberto(null); }}>{ic}</button>
                      ))}
                      <input value={v.icon || ''} maxLength={16} placeholder="ou cole um ícone" style={{ width: 150 }} onChange={(e) => set(m.id, 'icon', e.target.value)} />
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => salvar(valores)} disabled={!sujo}>Salvar menu</button>
        <button className="btn" onClick={() => { setValores({}); salvar({}); }} disabled={!Object.keys(company.menu_custom || {}).length && !Object.keys(valores).length}>Voltar tudo ao padrão</button>
      </div>
    </div>
  );
}

export default function Config() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { api('/company').then(setS); }, []);
  if (!s) return <p className="muted">Carregando…</p>;

  const publish = (company) => window.dispatchEvent(new CustomEvent('company-updated', { detail: company }));

  async function save(patch, okMsg = 'Salvo!') {
    setErr(''); setMsg('');
    try {
      const company = await api('/company', { method: 'PUT', body: patch });
      setS(company); publish(company); setMsg(okMsg);
    } catch (e) { setErr(e.message); }
  }

  async function onFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    try { await save({ logo: await resizeImage(file) }, 'Logotipo atualizado!'); }
    catch { setErr('Não consegui ler essa imagem'); }
  }

  return (
    <>
      <h1><Nome id="config">Configurações</Nome></h1>
      <p className="muted" style={{ marginBottom: 18 }}>Identidade e regras da sua empresa</p>
      {msg && <div className="card" style={{ marginBottom: 12, color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error">{err}</div>}
      <form onSubmit={(e) => { e.preventDefault(); save({ name: s.name, phone: s.phone, admin_name: s.admin_name || '', admin_phone: s.admin_phone || '', admin_email: s.admin_email || '', inactive_days: Number(s.inactive_days), reminder_minutes: s.reminder_minutes ? Number(s.reminder_minutes) : null }); }}>
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <div>
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>Logotipo</h2>
              {s.logo ? <img className="logo-big" src={s.logo} alt="Logotipo" /> : <p className="muted">Nenhum logotipo enviado.</p>}
              <div className="row" style={{ marginTop: 12 }}>
                <label className="btn" style={{ margin: 0, cursor: 'pointer', color: 'var(--text)' }}>
                  Enviar imagem
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onFile} style={{ display: 'none' }} />
                </label>
                {s.logo && <button type="button" className="btn bad" onClick={() => save({ logo: '' }, 'Logotipo removido')}>Remover</button>}
              </div>
              <p className="muted" style={{ marginTop: 8 }}>PNG, JPG, WEBP ou SVG. Aparece no menu lateral.</p>
            </div>

            <div className="card">
          <h2>Dados da empresa</h2>
          <div className="field"><label>Nome</label><input value={s.name || ''} onChange={(e) => setS({ ...s, name: e.target.value })} required /></div>
          <div className="field"><label>Telefone</label><input value={s.phone || ''} onChange={(e) => setS({ ...s, phone: e.target.value })} /></div>
          <div className="field">
            <label>Considerar cliente inativo após (dias)</label>
            <input type="number" min="1" value={s.inactive_days} onChange={(e) => setS({ ...s, inactive_days: e.target.value })} />
          </div>
          <div className="field">
            <label>Lembrete por WhatsApp ao cliente agendado</label>
            <select value={s.reminder_minutes || ''} onChange={(e) => setS({ ...s, reminder_minutes: e.target.value })}>
              <option value="">Desligado</option>
              {[[60, '1 hora antes'], [120, '2 horas antes'], [180, '3 horas antes'], [240, '4 horas antes'], [720, '12 horas antes'], [1440, '24 horas antes'], [2880, '48 horas antes']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              {s.reminder_minutes && ![60, 120, 180, 240, 720, 1440, 2880].includes(Number(s.reminder_minutes)) && <option value={s.reminder_minutes}>{s.reminder_minutes} minutos antes</option>}
            </select>
            <p className="muted" style={{ marginTop: 4 }}>Um aviso só. Quem agenda com menos de {s.reminder_minutes ? Math.round((Number(s.reminder_minutes) + 60) / 6) / 10 : '—'}h de antecedência não recebe (acabou de marcar).</p>
          </div>
            </div>
          </div>
          <div className="card">
          <h2>Dados do administrador</h2>
          <p className="muted">Quem responde pela empresa. O WhatsApp daqui recebe avisos do painel (como a lista do evento) e é o número com o qual a assistente pessoal conversa.</p>
          <div className="field"><label>Nome do administrador</label><input value={s.admin_name || ''} onChange={(e) => setS({ ...s, admin_name: e.target.value })} /></div>
          <div className="field"><label>WhatsApp do administrador</label><input value={s.admin_phone || ''} onChange={(e) => setS({ ...s, admin_phone: e.target.value })} placeholder="(32) 99999-9999" /></div>
          <div className="field"><label>E-mail do administrador</label><input type="email" value={s.admin_email || ''} onChange={(e) => setS({ ...s, admin_email: e.target.value })} /></div>
          </div>
        </div>
        <button className="btn primary" style={{ marginTop: 16 }}>Salvar</button>
      </form>
      <MenuPersonalizar company={s} onSaved={(c) => { setS(c); publish(c); }} />
    </>
  );
}
