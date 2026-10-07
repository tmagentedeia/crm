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

export const IconeSair = ({ size = 18 }) => (
  <svg {...base} width={size} height={size}>
    <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
    <path d="M16 8l4 4-4 4" />
    <path d="M20 12H9" />
  </svg>
);

export const IconeTema = ({ size = 16 }) => (
  <svg {...base} width={size} height={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5v17" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" opacity=".35" />
  </svg>
);
