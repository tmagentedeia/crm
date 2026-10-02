// Telefone no padrão do WhatsApp/UAZAPI: só dígitos; número brasileiro = 55 + DDD + número (celular SEM o 9 extra).
// Só completa o 55 quando o número "tem cara" de brasileiro; com "+" na frente ou outro formato, não mexe.
export function normPhone(s) {
  const raw = String(s ?? '').trim();
  const d = raw.replace(/\D/g, '');
  const comMais = raw.startsWith('+');
  const ddd = Number(d.slice(0, 2));
  const dddOk = ddd >= 11 && ddd <= 99;
  if (!comMais && d.length === 11 && dddOk && d[2] === '9') return '55' + d.slice(0, 2) + d.slice(3); // celular com 9
  if (!comMais && d.length === 10 && dddOk) return '55' + d; // fixo, ou celular sem o 9
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') return d.slice(0, 4) + d.slice(5); // 55 + celular com 9
  return d;
}
