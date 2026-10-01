import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import ComandosAgente from './ComandosAgente.jsx';

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
      <h1>Configurações</h1>
      <p className="muted" style={{ marginBottom: 18 }}>Identidade e regras da sua empresa</p>
      {msg && <div className="card" style={{ marginBottom: 12, color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error">{err}</div>}
      <div className="grid cols-2">
        <div className="card">
          <h2>Logotipo</h2>
          {s.logo ? <img className="logo-big" src={s.logo} alt="Logotipo" /> : <p className="muted">Nenhum logotipo enviado.</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <label className="btn" style={{ margin: 0, cursor: 'pointer', color: 'var(--text)' }}>
              Enviar imagem
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onFile} style={{ display: 'none' }} />
            </label>
            {s.logo && <button className="btn bad" onClick={() => save({ logo: '' }, 'Logotipo removido')}>Remover</button>}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>PNG, JPG, WEBP ou SVG. Aparece no menu lateral.</p>
        </div>
        <form className="card" onSubmit={(e) => { e.preventDefault(); save({ name: s.name, phone: s.phone, inactive_days: Number(s.inactive_days), reminder_minutes: s.reminder_minutes ? Number(s.reminder_minutes) : null }); }}>
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
          <button className="btn primary">Salvar</button>
        </form>
      </div>
      <ComandosAgente />
    </>
  );
}
