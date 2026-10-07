// Guarda endereços com senha (Redis e banco de conversas de cada empresa) cifrados no banco do painel.
// A chave vem de CREDENTIALS_KEY; se não existir, usa JWT_SECRET (não pode mudar, senão os endereços guardados deixam de abrir).
import crypto from 'crypto';

const chave = () => crypto.createHash('sha256').update(String(process.env.CREDENTIALS_KEY || process.env.JWT_SECRET || '')).digest();

export function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
}

// devolve null quando não há valor ou quando não foi possível abrir (chave trocada)
export function decifrar(guardado) {
  if (!guardado) return null;
  try {
    const [v, iv, tag, dados] = String(guardado).split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', chave(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dados, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

// só o servidor e a porta, para a Administração mostrar a quem a empresa está ligada sem expor a senha
export function servidorDe(url) {
  try { const u = new URL(url); return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : ''); } catch { return null; }
}
