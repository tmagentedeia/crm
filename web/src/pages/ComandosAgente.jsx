import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const KINDS = [
  { k: 'pause', title: 'Bloquear o agente na conversa (24h)', help: 'Bloqueio total por 24h, só naquela conversa. Ex.: "Thiago aqui"' },
  { k: 'resume', title: 'Liberar o agente na conversa', help: 'Retomada total: limpa todos os bloqueios. Ex.: "Tá contigo, Diana"' },
];

export default function ComandosAgente() {
  const [cfg, setCfg] = useState(null);
  const [agent, setAgent] = useState('');
  const [adm, setAdm] = useState('');
  const [att, setAtt] = useState('');
  const [nw, setNw] = useState({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [test, setTest] = useState('');
  const [testRes, setTestRes] = useState(null);

  const load = () => api('/agent-config').then((c) => { setCfg(c); setAgent(c.agent_name || ''); setAdm(c.adm_name || ''); });
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
  const label = { off: 'desligar (bloqueio total, sem prazo)', on: 'ligar (retomada total)', pause: 'bloquear por 24h (bloqueio total)', resume: 'liberar (retomada total)', none: 'nada (o agente segue normal)' };
  const labelGeral = { pause: 'pausa simples da conversa', resume: 'retomada simples da conversa' };

  return (
    <div className="card">
      <h2>Comandos do agente</h2>
      <p className="muted">Mensagens que <strong>você</strong> envia pelo WhatsApp da empresa para controlar o agente. Só valem quando a mensagem é sua, nunca do cliente.</p>
      {msg && <div style={{ color: 'var(--ok)', marginBottom: 8 }}>{msg}</div>}
      {err && <div className="error">{err}</div>}

      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, margin: 0, minWidth: 160 }}>
          <label>Nome do agente</label>
          <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="ex.: Vitória" />
        </div>
        <div className="field" style={{ flex: 1, margin: 0, minWidth: 160 }}>
          <label>Proprietário / ADM</label>
          <input value={adm} onChange={(e) => setAdm(e.target.value)} placeholder="ex.: Thiago" />
        </div>
        <button className="btn" onClick={() => run(() => api('/agent-config', { method: 'PUT', body: { agent_name: agent, adm_name: adm } }), 'Nomes salvos')}>Salvar nomes</button>
      </div>
      <p className="muted" style={{ marginTop: -6 }}>Esses nomes geram as frases prontas “<em>proprietário</em> aqui” (bloquear) e “tá contigo <em>agente</em>” (liberar).</p>

      <div className="field">
        <label>Atendentes extras <span className="muted">(cada nome vira “nome aqui”, que bloqueia o agente por 24h, além do proprietário)</span></label>
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

      <div className="field">
        <label>Ligar / desligar <span className="muted">— fixos, não precisam de cadastro</span></label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
          <span className="muted" style={{ border: '1px dashed #bbb', borderRadius: 999, padding: '4px 10px' }} title="Comando fixo">/off</span>
          <span className="muted" style={{ border: '1px dashed #bbb', borderRadius: 999, padding: '4px 10px' }} title="Comando fixo">/on</span>
        </div>
        <p className="muted" style={{ margin: 0 }}><strong>/off</strong> desliga o agente naquela conversa, <strong>sem prazo</strong>; só o <strong>/on</strong> (ou uma frase de liberar) religa.</p>
      </div>

      {KINDS.map(({ k, title, help }) => {
        const own = cfg.commands.filter((c) => c.kind === k);
        const auto = cfg.automatic.filter((c) => c.kind === k);
        return (
          <div className="field" key={k}>
            <label>{title} <span className="muted">— {help} (até {cfg.limits[k]} frases próprias)</span></label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {auto.map((c) => <span key={c.phrase} className="muted" style={{ border: '1px dashed #bbb', borderRadius: 999, padding: '4px 10px' }} title="Frase fixa">{c.phrase}</span>)}
              {k === 'pause' && !cfg.adm_name && <span className="muted" style={{ border: '1px dashed #e0a030', borderRadius: 999, padding: '4px 10px' }} title="Preencha o nome do proprietário acima">{'{proprietário}'} aqui</span>}
              {k === 'resume' && !cfg.agent_name && <span className="muted" style={{ border: '1px dashed #e0a030', borderRadius: 999, padding: '4px 10px' }} title="Preencha o nome do agente acima">tá contigo {'{agente}'}</span>}
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
      <p className="muted"><strong>Pausa e retomada simples (fixas):</strong> qualquer outra mensagem sua numa conversa <strong>pausa</strong> o agente ali; se terminar com <strong>?</strong> ou <strong>...</strong>, ele <strong>retoma</strong>. Não há o que cadastrar. Mensagens que começam com “/” e não são comandos são ignoradas.</p>
      <p className="muted"><strong>Frases de bloquear/liberar mandam mais:</strong> se a mensagem começa com uma delas (cadastrada ou automática), vale o tipo dela, mesmo que termine com <strong>?</strong> ou <strong>...</strong>. Ex.: “Will aqui...” bloqueia; “Tá contigo, Diana?” libera tudo.</p>
    </div>
  );
}
