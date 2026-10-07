import CampoSenha from '../senha.jsx';
import React, { useState } from 'react';
import { api, setToken } from '../api.js';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login'); // login | senha | register
  const [f, setF] = useState({ company_name: '', name: '', email: '', password: '', nova: '', repetir: '' });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const ir = (m) => { setMode(m); setErr(''); setOk(''); setF({ ...f, password: '', nova: '', repetir: '' }); };

  async function submit(e) {
    e.preventDefault();
    setErr(''); setOk('');
    if (mode === 'senha') {
      if (f.nova.length < 8) return setErr('A senha nova precisa ter ao menos 8 caracteres');
      if (f.nova !== f.repetir) return setErr('A confirmação não confere com a senha nova');
      setBusy(true);
      try {
        await api('/auth/password', { method: 'POST', body: { email: f.email, current: f.password, password: f.nova } });
        setMode('login'); setF({ ...f, password: '', nova: '', repetir: '' });
        setOk('Senha alterada! Entre com a senha nova.');
      } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
      return;
    }
    setBusy(true);
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
        <h1>{mode === 'login' ? 'Entrar' : mode === 'senha' ? 'Alterar senha' : 'Criar conta da empresa'}</h1>
        <p className="muted">{mode === 'senha' ? 'Informe a senha que você usa hoje (ou a provisória) e escolha uma nova.' : 'Painel de gestão e atendimento'}</p>
        {ok && <div style={{ color: 'var(--ok)', marginBottom: 8 }}>{ok}</div>}
        {err && <div className="error">{err}</div>}
        {mode === 'register' && (
          <>
            <div className="field"><label>Nome da empresa</label><input value={f.company_name} onChange={set('company_name')} required /></div>
            <div className="field"><label>Seu nome</label><input value={f.name} onChange={set('name')} required /></div>
          </>
        )}
        <div className="field"><label>E-mail</label><input type="email" value={f.email} onChange={set('email')} required /></div>
        <div className="field"><label>{mode === 'senha' ? 'Senha atual (ou provisória)' : 'Senha'}</label><CampoSenha value={f.password} onChange={set('password')} required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} /></div>
        {mode === 'senha' && (
          <>
            <div className="field"><label>Senha nova (8 ou mais caracteres)</label><CampoSenha value={f.nova} onChange={set('nova')} required minLength={8} autoComplete="new-password" /></div>
            <div className="field"><label>Repita a senha nova</label><CampoSenha value={f.repetir} onChange={set('repetir')} required minLength={8} autoComplete="new-password" /></div>
          </>
        )}
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : mode === 'senha' ? 'Salvar senha nova' : 'Criar conta'}</button>
        <p className="muted" style={{ textAlign: 'center', marginTop: 14 }}>
          {mode === 'login' ? (
            <>
              <a href="#" onClick={(e) => { e.preventDefault(); ir('senha'); }}>Alterar senha</a>
              {' · '}
              <a href="#" onClick={(e) => { e.preventDefault(); ir('register'); }}>Criar conta</a>
            </>
          ) : (
            <a href="#" onClick={(e) => { e.preventDefault(); ir('login'); }}>{mode === 'senha' ? 'Voltar para entrar' : 'Já tenho conta'}</a>
          )}
        </p>
      </form>
    </div>
  );
}
