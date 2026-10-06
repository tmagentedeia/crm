import React, { useState } from 'react';
import { api, setToken } from './api.js';
import CampoSenha from './senha.jsx';
import { IconeChave } from './icones.jsx';

// Cada pessoa troca a própria senha: informa a atual e escolhe a nova. Abre pelo menu lateral, para o dono e para a equipe.
export default function SenhaModal({ onClose }) {
  const [f, setF] = useState({ atual: '', nova: '', repetir: '' });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function salvar(e) {
    e.preventDefault();
    setErr('');
    if (f.nova.length < 8) return setErr('A senha nova precisa ter ao menos 8 caracteres');
    if (f.nova !== f.repetir) return setErr('A confirmação não confere com a senha nova');
    setBusy(true);
    try {
      const r = await api('/auth/password', { method: 'POST', body: { current: f.atual, password: f.nova } });
      if (r.token) setToken(r.token);   // a sessão continua valendo, agora com a senha nova
      setOk(true);
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ color: 'var(--muted)', display: 'inline-flex' }}><IconeChave size={18} /></span>Alterar minha senha</h2>
        {ok ? (
          <>
            <p style={{ color: 'var(--ok)' }}>Senha alterada! Use a nova senha no próximo acesso.</p>
            <div className="row"><button className="btn primary" onClick={onClose}>Fechar</button></div>
          </>
        ) : (
          <form onSubmit={salvar}>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Senha atual</label><CampoSenha value={f.atual} onChange={set('atual')} autoFocus required autoComplete="current-password" /></div>
            <div className="field"><label>Senha nova (8 ou mais caracteres)</label><CampoSenha value={f.nova} onChange={set('nova')} required minLength={8} autoComplete="new-password" /></div>
            <div className="field"><label>Repita a senha nova</label><CampoSenha value={f.repetir} onChange={set('repetir')} required minLength={8} autoComplete="new-password" /></div>
            <div className="row">
              <button className="btn primary" disabled={busy || !f.atual || !f.nova || !f.repetir}>{busy ? 'Salvando…' : 'Salvar senha'}</button>
              <button type="button" className="btn" onClick={onClose}>Cancelar</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
