import React from 'react';
import { IconeCadeado } from './icones.jsx';

// Aviso de função de outro plano: aparece ao tocar numa função apagada (com cadeado) no painel.
export default function UpgradeModal({ company, nome, onClose }) {
  const up = company?.upgrade || {};
  const texto = up.text || 'Esta função não está no seu plano atual. Fale com a gente para liberar.';
  const link = up.phone
    ? `https://wa.me/${up.phone}?text=${encodeURIComponent(`Olá! Quero liberar a função "${nome}" no meu plano.`)}`
    : null;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ color: 'var(--muted)', display: 'inline-flex' }}><IconeCadeado size={18} /></span>{nome}</h2>
        <p>{texto}</p>
        <div className="row">
          {link && <a className="btn primary" href={link} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Fazer upgrade</a>}
          <button className="btn" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
