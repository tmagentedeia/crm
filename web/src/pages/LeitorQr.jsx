import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { api } from '../api.js';

const COR = { ok: '#2e7d32', ja_entrou: '#b26a00', outro_evento: '#b26a00', cancelado: '#b3261e', invalido: '#b3261e' };

// Leitor de QR Code da portaria: abre a câmera, lê o ingresso e já marca a entrada.
export default function LeitorQr({ eventoId, onFechar, onMarcou }) {
  const video = useRef(null);
  const tela = useRef(document.createElement('canvas'));
  const ultimo = useRef({ code: '', at: 0 });
  const ocupado = useRef(false);
  const [res, setRes] = useState(null);
  const [erroCam, setErroCam] = useState('');
  const [manual, setManual] = useState('');

  async function ler(code) {
    if (ocupado.current) return;
    ocupado.current = true;
    try {
      const r = await api('/event-list-comment/scan', { method: 'POST', body: { code, event_id: eventoId } });
      setRes(r);
      if (r.result === 'ok') onMarcou?.();
      if (navigator.vibrate) navigator.vibrate(r.result === 'ok' ? 80 : [120, 60, 120]);
    } catch (e) {
      setRes({ result: 'invalido', message: !e?.data ? 'Sem conexão. Marque a entrada pela lista.' : e.message });
    } finally { ocupado.current = false; }
  }

  useEffect(() => {
    let parar = false, stream = null, raf = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (parar) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.current.srcObject = stream;
        await video.current.play();
        const passo = () => {
          const v = video.current;
          if (parar || !v) return;
          if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth) {
            const c = tela.current, w = Math.min(v.videoWidth, 640), h = Math.round(w * v.videoHeight / v.videoWidth);
            c.width = w; c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(v, 0, 0, w, h);
            const q = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
            if (q?.data && !(q.data === ultimo.current.code && Date.now() - ultimo.current.at < 4000)) {
              ultimo.current = { code: q.data, at: Date.now() };
              ler(q.data);
            }
          }
          raf = requestAnimationFrame(passo);
        };
        passo();
      } catch { setErroCam('Não foi possível abrir a câmera. Permita o acesso à câmera no navegador, ou digite o código abaixo.'); }
    })();
    return () => { parar = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  return (
    <div className="modal-bg" onClick={onFechar}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2>Ler ingresso</h2>
        {erroCam ? <p className="error">{erroCam}</p> : <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 10, background: '#000', maxHeight: '45vh', objectFit: 'cover' }} />}
        {res && (
          <div style={{ marginTop: 10, padding: 12, borderRadius: 10, color: '#fff', background: COR[res.result] || '#555' }}>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{res.message}</div>
            {res.name && <div style={{ fontSize: 17, marginTop: 2 }}>{res.name}</div>}
            {res.sector && <div>{res.sector} · {res.table}</div>}
            {res.result === 'ja_entrou' && res.entered_at && <div>Entrou às {new Date(res.entered_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{res.entered_by ? ` · ${res.entered_by}` : ''}</div>}
            {['pending', 'partial'].includes(res.payment) && <div style={{ fontWeight: 700, marginTop: 4 }}>Atenção: pagamento {res.payment_label?.toLowerCase()}</div>}
            {(res.note || res.door_note) && <div style={{ marginTop: 4 }}>{res.note} {res.door_note}</div>}
          </div>
        )}
        <form className="row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); if (manual.trim()) { ler(manual.trim()); setManual(''); } }}>
          <input placeholder="Ou digite o código do ingresso" value={manual} onChange={(e) => setManual(e.target.value)} style={{ flex: 1 }} />
          <button className="btn">Conferir</button>
        </form>
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}><button className="btn" onClick={onFechar}>Fechar</button></div>
      </div>
    </div>
  );
}
