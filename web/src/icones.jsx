import React from 'react';

// Ícones de traço fino, sem cor própria: acompanham a cor do texto onde estiverem (discretos e combinando com o tema).
const base = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

export const IconeOlho = ({ cortado = false, size = 16 }) => (
  <svg {...base} width={size} height={size}>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.6" />
    {cortado && <path d="M4 4l16 16" />}
  </svg>
);

export const IconeCadeado = ({ size = 14 }) => (
  <svg {...base} width={size} height={size}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
