import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const KINDS = [
  { k: 'off', title: 'Desligar o agente', help: 'Bloqueio total da conversa por 24h. Ex.: /off' },
  { k: 'pause', title: 'Pausar (bloqueio total)', help: 'Também bloqueio total daquela conversa. Ex.: "Thiago aqui"' },
  { k: 'on', title: 'Ligar o agente', help: 'Retomada total: limpa todos os bloqueios. Ex.: /on' },
  { k: 'resume', title: 'Retomar (retomada total)', help: 'Também retomada total. Ex.: "Tá contigo, Diana"' },
];

export default function ComandosAgente() {
  const [cfg, setCfg] = useState(null);
  const [agent, setAgent] = useState('');
  const [att, setAtt] = useState('');
  const [nw, setNw] = useState({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [test, setTest] = useState('');
  const [testRes, setTestRes] = useState(null);

  const load = () => api('/agent-config').then((c) => { setCfg(c); setAgent(c.agent_name || ''); });
  useEffect(() => { load(); }, []);
  if (!cfg) return null;

  const run = async (fn, ok) => {
    setErr(''); setMsg('');
    try { await fn(); await load(); if (ok) setMsg(ok); } catch (e) { setErr(e.message); }
  };
  const runTest = async () => {
    setErr('');
    try { setTestRes(await api('/agent-commands/classify', { method: 'POST', body: { text: test } })); } catch (e) { setErr(e.message); }
  };
  const label = { off: 'desligar (bloqueio total)', on: 'ligar (retomada total)', pause: 'bloqueio total', resume: 'retomada total', none: 'nada (o agente segue normal)' };
  const labelGeral = { pause: 'pausa simples da conversa', resume: 'retomada simples da conversa' };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Comandos do agente</h2>
      <p className="muted">Mensagens que <strong>você</strong> envia pelo WhatsApp do salão para controlar o agente. Só valem quando a mensagem é sua, nunca do cliente.</p>
      {msg && <div style={{ color: 'var(--ok)', marginBottom: 8 }}>{msg}</div>}
      {err && <div className="error">{err}</div>}

      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="field" style={{ flex: 1, margin: 0 }}>
          <label>Nome do agente</label>
          <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="ex.: Vitória" />
        </div>
        <button className="btn" onClick={() => run(() => api('/agent-config', { method: 'PUT', body: { agent_name: agent } }), 'Nome salvo')}>Salvar nome</button>
      </div>

      <div className="field">
        <label>Atendentes que podem pausar <span className="muted">(cada nome vira “nome aqui”)</span></label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {cfg.attendants.map((a) => (
            <span key={a.id} className="row" style={{ gap: 6, border: '1px solid var(--border, #ddd)', borderRadius: 999, padding: '4px 10px' }}>
              {a.name} aqui
              <button className="btn sm" onClick={() => run(() => api('/agent-attendants/' + a.id, { method: 'DELETE' }))}>×</button>
            </span>
          ))}
          {!cfg.attendants.length && <span className="muted">Nenhum atendente cadastrado.</span>}
        </div>
        <div className="row">
          <input value={att} onChange={(e) => setAtt(e.target.value)} placeholder="Nome (ex.: Will)" style={{ flex: 1 }} />
          <button className="btn" onClick={() => run(async () => { await api('/agent-attendants', { method: 'POST', body: { name: att } }); setAtt(''); })}>Adicionar</button>
        </div>
      </div>

      {KINDS.map(({ k, title, help }) => {
        const own = cfg.commands.filter((c) => c.kind === k);
        const auto = cfg.automatic.filter((c) => c.kind === k);
        return (
          <div className="field" key={k}>
            <label>{title} <span className="muted">— {help} (até {cfg.limits[k]} frases próprias)</span></label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {auto.map((c) => <span key={c.phrase} className="muted" style={{ border: '1px dashed #bbb', borderRadius: 999, padding: '4px 10px' }} title="Automática">{c.phrase}</span>)}
              {own.map((c) => (
                <span key={c.id} className="row" style={{ gap: 6, border: '1px solid var(--border, #ddd)', borderRadius: 999, padding: '4px 10px' }}>
                  {c.phrase}
                  <button className="btn sm" onClick={() => run(() => api('/agent-commands/' + c.id, { method: 'DELETE' }))}>×</button>
                </span>
              ))}
            </div>
            <div className="row">
              <input value={nw[k] || ''} onChange={(e) => setNw({ ...nw, [k]: e.target.value })} placeholder="Nova frase" style={{ flex: 1 }} />
              <button className="btn" onClick={() => run(async () => { await api('/agent-commands', { method: 'POST', body: { kind: k, phrase: nw[k] } }); setNw({ ...nw, [k]: '' }); })}>Adicionar</button>
            </div>
          </div>
        );
      })}

      <div className="field">
        <label>Testar uma frase</label>
        <div className="row">
          <input value={test} onChange={(e) => { setTest(e.target.value); setTestRes(null); }} placeholder="Digite como se fosse você mandando no WhatsApp" style={{ flex: 1 }} />
          <button className="btn" onClick={runTest}>Testar</button>
        </div>
        {testRes && <p style={{ marginTop: 6 }}>O agente iria: <strong>{testRes.rule === 'geral' ? labelGeral[testRes.action] : label[testRes.action]}</strong>{testRes.rule === 'geral' && <span className="muted"> (regra geral)</span>}</p>}
      </div>
      <p className="muted">A frase vale quando a mensagem <em>começa</em> com ela. Maiúsculas, acentos e vírgulas não fazem diferença.</p>
      <p className="muted"><strong>Regra geral:</strong> qualquer outra mensagem sua numa conversa <strong>pausa</strong> o agente ali (pausa simples); se terminar com <strong>?</strong> ou <strong>...</strong>, ele <strong>retoma</strong> (retomada simples). Mensagens que começam com “/” e não são comandos são ignoradas.</p>
      <p className="muted"><strong>Frases cadastradas mandam mais:</strong> se a mensagem começa com uma frase cadastrada (ou automática), vale o tipo dela, mesmo que termine com <strong>?</strong> ou <strong>...</strong>. Ex.: “Will aqui...” bloqueia; “Tá contigo, Diana?” retoma tudo.</p>
    </div>
  );
}
