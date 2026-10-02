import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtPhone } from '../api.js';
import { Nome } from "../menu.jsx";

const FIM_OK = /(t[áa]|ok|tudo bem)\s*\?\s*$/i;
const FRASES_SAIDA = [
  'Se não quiser mais receber, é só avisar, tá?',
  'Se preferir não receber mais, me avisa, ok?',
  'Qualquer coisa é só pedir para sair, tudo bem?',
];
const STATUS = {
  draft: 'Rascunho', running: 'Em andamento', paused: 'Pausada', stopped: 'Parada', done: 'Concluída',
};
const STATUS_ENVIO = { pending: 'Na fila', sending: 'Enviando', sent: 'Enviada', failed: 'Não enviada', cancelled: 'Cancelada' };
const PADRAO = {
  name: '', messages: ['', '', ''],
  interval_min: 5, interval_max: 10, batch_size: 20, batch_pause_min: 60, daily_limit: 50,
  mode: 'clients', ids: [],
};
const AVISO = 'Os limites definidos aqui são baseados em critérios subjetivos. O risco varia muito de acordo com o seu histórico de interações com os contatos e de número para número: já houve relatos de bloqueio com apenas 10 envios por dia, assim como números que fizeram mais de 100 envios por dia sem nenhum bloqueio. Por isso, recomendamos sempre o mínimo possível de envios com o máximo intervalo possível, para reduzir o risco de o WhatsApp bloquear o seu número. Não nos responsabilizamos por eventuais bloqueios nem pela sua decisão.';

export default function Campanhas() {
  const [lista, setLista] = useState(null);
  const [tela, setTela] = useState({ nome: 'lista' }); // lista | form (id?) | detalhe (id)
  const [erro, setErro] = useState('');

  const carregar = () => api('/campaigns').then((l) => { setLista(l); setErro(''); }).catch((e) => { setLista([]); setErro(e.message); });
  useEffect(() => { carregar(); }, []);

  if (tela.nome === 'form') return <Form frases={() => setTela({ nome: 'frases', de: tela })} id={tela.id} voltar={() => { setTela({ nome: 'lista' }); carregar(); }} abrir={(id) => { setTela({ nome: 'detalhe', id }); carregar(); }} />;
  if (tela.nome === 'frases') return <Frases voltar={() => setTela(tela.de?.nome === 'form' ? tela.de : { nome: 'lista' })} />;
  if (tela.nome === 'detalhe') return <Detalhe key={tela.id} id={tela.id} voltar={() => { setTela({ nome: 'lista' }); carregar(); }} editar={() => setTela({ nome: 'form', id: tela.id })} irPara={(id) => setTela({ nome: 'detalhe', id })} />;

  return (
    <div>
      <div className="topbar">
        <h1><Nome id="campanhas">Campanhas</Nome></h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setTela({ nome: 'frases', de: { nome: 'lista' } })}>Saudações e cumprimentos</button>
          <button className="btn primary" onClick={() => setTela({ nome: 'form' })}>Nova campanha</button>
        </div>
      </div>
      {erro && <div className="error">{erro}</div>}
      <p className="muted">Suas campanhas ficam guardadas. Só uma pode estar ativa por vez; para reaproveitar uma, abra e clique em “Duplicar”.</p>
      <div className="card">
        <table>
          <thead><tr><th>Campanha</th><th>Situação</th><th>Enviadas</th><th>Na fila</th><th>Não enviadas</th></tr></thead>
          <tbody>
            {(lista || []).map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setTela({ nome: 'detalhe', id: c.id })}>
                <td><strong>{c.name}</strong></td>
                <td>{STATUS[c.status]}</td>
                <td>{c.sent} de {c.total}</td>
                <td>{c.remaining}</td>
                <td>{c.failed}</td>
              </tr>
            ))}
            {lista && !lista.length && <tr><td colSpan="5" className="muted">Nenhuma campanha ainda. Clique em “Nova campanha”.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Form({ id, voltar, abrir, frases }) {
  const [f, setF] = useState(PADRAO);
  const [clientes, setClientes] = useState([]);
  const [sim, setSim] = useState(null);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    Promise.all([api('/customers?status=client'), api('/customers?status=lead')])
      .then(([c, l]) => setClientes([...c.map((x) => ({ ...x, tipo: 'Cliente' })), ...l.map((x) => ({ ...x, tipo: 'Lead' }))]))
      .catch(() => {});
    if (id) api('/campaigns/' + id).then((c) => setF({
      name: c.name, messages: c.messages,
      interval_min: c.interval_min, interval_max: c.interval_max, batch_size: c.batch_size,
      batch_pause_min: c.batch_pause_min, daily_limit: c.daily_limit,
      mode: 'selected', ids: c.recipients.map((r) => r.customer_id).filter(Boolean),
    }));
  }, [id]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setMsg = (i, v) => setF((x) => ({ ...x, messages: x.messages.map((m, j) => (j === i ? v : m)) }));
  const total = useMemo(() => {
    if (f.mode === 'selected') return f.ids.length;
    if (f.mode === 'clients') return clientes.filter((c) => c.tipo === 'Cliente').length;
    if (f.mode === 'leads') return clientes.filter((c) => c.tipo === 'Lead').length;
    return clientes.length;
  }, [f.mode, f.ids, clientes]);

  const body = () => ({
    name: f.name, messages: f.messages,
    interval_min: Number(f.interval_min), interval_max: Number(f.interval_max),
    batch_size: Number(f.batch_size), batch_pause_min: Number(f.batch_pause_min), daily_limit: Number(f.daily_limit),
    recipients: { mode: f.mode, ids: f.ids },
  });

  useEffect(() => {
    const t = setTimeout(() => {
      api('/campaigns/simulate', { method: 'POST', body: { ...body(), total } }).then(setSim).catch(() => setSim(null));
    }, 300);
    return () => clearTimeout(t);
  }, [f, total]);

  const [aviso, setAviso] = useState({}); // aviso de limite por campo
  const avisar = (k, texto) => setAviso((a) => ({ ...a, [k]: texto }));
  const num = (k, min, max, rotulo, ajuda, unidade) => (
    <label className="field" style={{ flex: '0 0 auto', minWidth: 150 }}>
      <div>{rotulo}</div>
      <div className="muted">({ajuda})</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <input type="number" min={min} max={max} value={f[k]} style={{ width: 90 }}
          onChange={(e) => {
            const v = e.target.value;
            if (v !== '' && Number(v) > max) { set(k, max); avisar(k, `Máximo ${max}`); }
            else { set(k, v); avisar(k, ''); }
          }}
          onBlur={() => {
            if (f[k] === '' || Number(f[k]) < min) { set(k, min); avisar(k, `Mínimo ${min}`); }
          }} />
        {unidade && <span className="muted">{unidade}</span>}
      </div>
      {aviso[k] && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{aviso[k]}</span>}
    </label>
  );
  const alternar = (cid) => set('ids', f.ids.includes(cid) ? f.ids.filter((x) => x !== cid) : [...f.ids, cid]);

  const salvar = async () => {
    setErro(''); setSalvando(true);
    try {
      const r = await api(id ? '/campaigns/' + id : '/campaigns', { method: id ? 'PUT' : 'POST', body: body() });
      abrir(r.id);
    } catch (e) { setErro(e.message); }
    setSalvando(false);
  };

  return (
    <div>
      <div className="topbar">
        <h1>{id ? 'Editar campanha' : 'Nova campanha'}</h1>
        <button className="btn" onClick={voltar}>Voltar</button>
      </div>
      {erro && <div className="error">{erro}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <label className="field">Nome da campanha
          <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Promoção de outubro" />
        </label>
        <p className="muted">
          Cada mensagem chega assim: uma <strong>saudação</strong> (“Oi”, “Ei”, “Olá”), o <strong>nome</strong> da pessoa, um <strong>cumprimento</strong> (“Como vai você?”),
          depois o <strong>seu texto</strong> e, no fim, a <strong>frase de saída</strong> para quem não quiser mais receber. Saudação e cumprimento são colocados por nós, de forma variada
          (se o contato não tem nome cadastrado, o nome é pulado). Você escreve só o seu texto, em três versões que se alternam, sempre terminando com a frase de saída.
          Quer mudar as saudações e os cumprimentos? <a href="#" onClick={(e) => { e.preventDefault(); frases(); }}>Editar saudações e cumprimentos</a>.
        </p>
        {f.messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <label className="field">{i === 0 ? 'Mensagem' : `Variação ${i}`}
              <textarea rows="4" value={m} onChange={(e) => setMsg(i, e.target.value)} />
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {m.trim() && !FIM_OK.test(m.trim()) && (
                <span className="muted" style={{ color: 'var(--bad)' }}>Termine com a frase de saída em forma de pergunta (“tá?”, “ok?” ou “tudo bem?”).</span>
              )}
              <button type="button" className="btn sm"
                disabled={!m.trim() || FIM_OK.test(m.trim()) || FRASES_SAIDA.some((x) => m.includes(x))}
                title={FIM_OK.test(m.trim()) ? 'Esta mensagem já termina com a frase de saída' : ''}
                onClick={() => setMsg(i, (m.trim() + ' ' + FRASES_SAIDA[i % FRASES_SAIDA.length]).trim())}>Adicionar frase de saída</button>
            </div>
          </div>
        ))}
        {sim?.has_link && <div className="error" style={{ marginTop: 10 }}>Atenção: links nas mensagens aumentam o risco de bloqueio do seu número.</div>}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Ritmo de envio</h3>
        <p className="muted">Os envios acontecem só entre 7h e 22h. O tempo entre uma mensagem e outra é sorteado dentro da faixa que você escolher.</p>
        <p style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 9, padding: '8px 12px', fontSize: 14 }}>
          <strong>Atenção:</strong> não nos responsabilizamos por eventuais bloqueios. Os valores aqui seguem uma prática de equilíbrio e razoabilidade, mas o risco varia muito de número para número.
        </p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {num('interval_min', 5, 600, 'Menor intervalo', 'mínimo 5', 'minutos')}
          {num('interval_max', 10, 600, 'Maior intervalo', 'mínimo 10', 'minutos')}
          {num('batch_size', 1, 30, 'Envios seguidos', 'máximo 30')}
          {num('batch_pause_min', 60, 1440, 'Pausa depois deles', 'mínimo 60 minutos', 'minutos')}
          {num('daily_limit', 1, 100, 'Limite por dia', 'máximo 100')}
        </div>
        {sim && (
          <p style={{ marginTop: 10 }}>
            <strong>Previsão:</strong> cerca de {sim.per_day} mensagens por dia (em média {sim.per_hour} por hora)
            {sim.days ? <>; para {total} contato{total === 1 ? '' : 's'}, leva uns <strong>{sim.days} dia{sim.days === 1 ? '' : 's'}</strong>.</> : '.'}
          </p>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Quem vai receber</h3>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
          {[['clients', 'Todos os clientes'], ['leads', 'Todos os leads'], ['all', 'Clientes e leads'], ['selected', 'Escolher contatos']].map(([v, r]) => (
            <label key={v}><input type="radio" checked={f.mode === v} onChange={() => set('mode', v)} /> {r}</label>
          ))}
        </div>
        {f.mode === 'selected' && (
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            <table>
              <tbody>
                {clientes.map((c) => (
                  <tr key={c.id} onClick={() => alternar(c.id)} style={{ cursor: 'pointer' }}>
                    <td><input type="checkbox" readOnly checked={f.ids.includes(c.id)} /></td>
                    <td>{c.name || 'Sem nome'}</td><td className="muted">{fmtPhone(c.phone)}</td><td className="muted">{c.tipo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">{total} contato{total === 1 ? '' : 's'} selecionado{total === 1 ? '' : 's'}.</p>
      </div>

      <button className="btn primary" disabled={salvando} onClick={salvar}>{salvando ? 'Salvando…' : 'Salvar campanha'}</button>
    </div>
  );
}

function Detalhe({ id, voltar, editar, irPara }) {
  const [c, setC] = useState(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState(false);
  const [ciente, setCiente] = useState(false);

  const carregar = () => api('/campaigns/' + id).then((x) => { setC(x); }).catch((e) => setErro(e.message));
  useEffect(() => { carregar(); const t = setInterval(carregar, 15000); return () => clearInterval(t); }, [id]);

  const acao = async (nome, corpo, pergunta) => {
    if (pergunta && !window.confirm(pergunta)) return;
    setErro('');
    try { await api(`/campaigns/${id}/${nome}`, { method: 'POST', body: corpo }); setAviso(false); setCiente(false); await carregar(); }
    catch (e) { setErro(e.message); }
  };
  const duplicar = async () => {
    try { const r = await api(`/campaigns/${id}/duplicate`, { method: 'POST' }); irPara(r.id); } catch (e) { setErro(e.message); }
  };
  const apagar = async () => {
    if (!window.confirm('Apagar esta campanha?')) return;
    try { await api('/campaigns/' + id, { method: 'DELETE' }); voltar(); } catch (e) { setErro(e.message); }
  };

  if (!c) return <div>{erro ? <div className="error">{erro}</div> : 'Carregando…'}</div>;
  const rec = c.recipients;
  const n = (s) => rec.filter((r) => r.status === s).length;
  const tem = (...s) => rec.filter((r) => s.includes(r.status)).length;
  const link = c.messages.some((m) => /(https?:\/\/|www\.)/i.test(m));

  return (
    <div>
      <div className="topbar">
        <h1>{c.name}</h1>
        <button className="btn" onClick={voltar}>Voltar</button>
      </div>
      {erro && <div className="error">{erro}</div>}
      {c.pause_reason && c.status === 'paused' && <div className="error">{c.pause_reason}. Confira o número e retome quando estiver tudo certo.</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <p><strong>Situação:</strong> {STATUS[c.status]}</p>
        <p>{n('sent')} enviadas · {tem('pending', 'sending')} na fila · {n('failed')} não enviadas · {rec.length} no total</p>
        {c.status === 'running' && c.next_send_at && <p className="muted">Próximo envio previsto para {new Date(c.next_send_at).toLocaleString('pt-BR')} (os envios só acontecem entre 7h e 22h).</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {c.status === 'draft' && <button className="btn primary" onClick={() => setAviso(true)}>▶ Iniciar</button>}
          {c.status === 'draft' && <button className="btn" onClick={editar}>Editar</button>}
          {c.status === 'running' && <button className="btn" onClick={() => acao('pause')}>⏸ Pausar</button>}
          {c.status === 'paused' && <button className="btn primary" onClick={() => acao('resume')}>▶ Retomar</button>}
          {['running', 'paused'].includes(c.status) && <button className="btn bad" onClick={() => acao('stop', {}, 'Parar de vez? Os contatos que ainda estão na fila não vão receber a mensagem.')}>⏹ Parar</button>}
          <button className="btn" onClick={duplicar}>Duplicar</button>
          {['draft', 'stopped', 'done'].includes(c.status) && <button className="btn bad" onClick={apagar}>Apagar</button>}
        </div>
      </div>

      {aviso && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--bad)' }}>
          <h3>Antes de começar</h3>
          <p>{AVISO}</p>
          {link && <p><strong>Suas mensagens têm link. Links aumentam o risco de bloqueio.</strong></p>}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}>
            <input type="checkbox" checked={ciente} onChange={(e) => setCiente(e.target.checked)} />
            Li o aviso e quero iniciar a campanha
          </label>
          <button className="btn primary" disabled={!ciente} onClick={() => acao('start', { accept: true })}>Iniciar campanha</button>{' '}
          <button className="btn" onClick={() => { setAviso(false); setCiente(false); }}>Cancelar</button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Ritmo</h3>
        <p className="muted">Intervalo de {c.interval_min} a {c.interval_max} min entre mensagens · {c.batch_size} envios seguidos e pausa de {c.batch_pause_min} min · até {c.daily_limit} por dia · das 7h às 22h</p>
        {c.status !== 'done' && c.status !== 'stopped' && <p>Previsão: cerca de {c.per_day} por dia{c.days ? `; ainda leva uns ${c.days} dia${c.days === 1 ? '' : 's'}` : ''}.</p>}
      </div>

      <div className="card">
        <h3>Contatos</h3>
        <table>
          <thead><tr><th>Contato</th><th>Situação</th><th>Quando</th></tr></thead>
          <tbody>
            {rec.map((r) => (
              <tr key={r.id}>
                <td>{r.name || 'Sem nome'} <span className="muted">{fmtPhone(r.phone)}</span></td>
                <td>{STATUS_ENVIO[r.status]}{r.error ? <span className="muted"> — {r.error}</span> : ''}</td>
                <td className="muted">{r.sent_at ? new Date(r.sent_at).toLocaleString('pt-BR') : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Frases({ voltar }) {
  const [d, setD] = useState(null);
  const [g, setG] = useState([]);
  const [k, setK] = useState([]);
  const [novoG, setNovoG] = useState('');
  const [novoK, setNovoK] = useState('');
  const [erro, setErro] = useState('');
  const [msg, setMsg] = useState('');

  const aplicar = (r) => { setD(r); setG(r.greetings); setK(r.compliments); };
  useEffect(() => { api('/campaigns/phrases').then(aplicar).catch((e) => setErro(e.message)); }, []);
  if (!d) return <div>{erro ? <div className="error">{erro}</div> : 'Carregando…'}</div>;

  const salvar = async () => {
    setErro(''); setMsg('');
    try { aplicar(await api('/campaigns/phrases', { method: 'PUT', body: { greetings: g, compliments: k } })); setMsg('Salvo.'); }
    catch (e) { setErro(e.message); }
  };
  const restaurar = async () => {
    if (!window.confirm('Voltar para as saudações e cumprimentos originais? As suas mudanças serão perdidas.')) return;
    setErro(''); setMsg('');
    try { aplicar(await api('/campaigns/phrases', { method: 'DELETE' })); setMsg('Listas originais restauradas.'); }
    catch (e) { setErro(e.message); }
  };

  const lista = (titulo, ajuda, itens, setItens, novo, setNovo, minimo) => (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>{titulo} <span className="muted">({itens.length} — mínimo {minimo})</span></h3>
      <p className="muted">{ajuda}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {itens.map((t, i) => (
          <span key={t + i} className="badge" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {t}
            <button type="button" title={itens.length <= minimo ? `É preciso manter pelo menos ${minimo}` : 'Remover'}
              disabled={itens.length <= minimo} style={{ border: 0, background: 'none', cursor: itens.length <= minimo ? 'not-allowed' : 'pointer', opacity: itens.length <= minimo ? .3 : 1 }}
              onClick={() => setItens(itens.filter((_, j) => j !== i))}>✕</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={novo} onChange={(e) => setNovo(e.target.value)} placeholder="Escreva uma nova" style={{ flex: 1 }}
          onKeyDown={(e) => { if (e.key === 'Enter' && novo.trim()) { setItens([...itens, novo.trim()]); setNovo(''); } }} />
        <button className="btn" disabled={!novo.trim()} onClick={() => { setItens([...itens, novo.trim()]); setNovo(''); }}>Adicionar</button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="topbar">
        <h1>Saudações e cumprimentos</h1>
        <button className="btn" onClick={voltar}>Voltar</button>
      </div>
      {erro && <div className="error">{erro}</div>}
      {msg && <p style={{ color: 'var(--ok)' }}>{msg}</p>}
      <p className="muted">
        Toda mensagem de campanha começa com uma saudação, o nome da pessoa e um cumprimento, e os usamos em rodízio para as mensagens não ficarem iguais.
        Exemplo: “<strong>{g[0]} Maria!</strong> {k[0]} <em>(seu texto)</em>”. Você pode incluir os seus e tirar os que não gostar, mas precisa manter o mínimo para o rodízio funcionar bem.
      </p>
      {lista('Saudações', 'Como a mensagem começa.', g, setG, novoG, setNovoG, d.minimos.greetings)}
      {lista('Cumprimentos', 'Logo depois do nome.', k, setK, novoK, setNovoK, d.minimos.compliments)}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" onClick={salvar}>Salvar</button>
        <button className="btn" onClick={restaurar}>Voltar ao padrão</button>
      </div>
    </div>
  );
}
