import React, { useState } from 'react';
import { api, setToken } from '../api.js';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ company_name: '', name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      let data = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body: f });
      setToken(data.token);
      localStorage.setItem('crm_company', JSON.stringify(data.company || {}));
      onLogin(data.company || {});
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>{mode === 'login' ? 'Entrar' : 'Criar conta da empresa'}</h1>
        <p className="muted">Painel de gestão e atendimento</p>
        {err && <div className="error">{err}</div>}
        {mode === 'register' && (
          <>
            <div className="field"><label>Nome da empresa</label><input value={f.company_name} onChange={set('company_name')} required /></div>
            <div className="field"><label>Seu nome</label><input value={f.name} onChange={set('name')} required /></div>
          </>
        )}
        <div className="field"><label>E-mail</label><input type="email" value={f.email} onChange={set('email')} required /></div>
        <div className="field"><label>Senha</label><input type="password" value={f.password} onChange={set('password')} required minLength={mode === 'register' ? 8 : 1} /></div>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}</button>
        <p className="muted" style={{ textAlign: 'center', marginTop: 14 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
            {mode === 'login' ? 'Criar conta' : 'Já tenho conta'}
          </a>
        </p>
      </form>
    </div>
  );
}
