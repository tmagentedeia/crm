import crypto from 'crypto';

// Chave de integração de cada empresa. É aleatória e longa, então basta um hash SHA-256 (sem sal nem custo extra).
// Só o hash vai para o banco; a chave em si é mostrada uma única vez, quando é gerada.
export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

export function newApiKey() {
  const key = 'crm_' + crypto.randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key), hint: key.slice(-4) };
}

// Comparação em tempo constante (não revela quantos caracteres batem)
function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

export const matchesCompanyKey = (key, hash) => !!hash && sameText(hashKey(key), hash);

// Chave global (variável N8N_API_KEY): vale para qualquer empresa, só durante a transição.
// Para aposentá-la nas rotas /n8n, defina ALLOW_GLOBAL_KEY=false (a variável continua sendo usada nos avisos que o painel envia).
export const globalKeyAllowed = () => process.env.ALLOW_GLOBAL_KEY !== 'false';
// O espelho com a agenda do Google usa a chave global só para gravar/limpar o ID do evento, mesmo com ALLOW_GLOBAL_KEY=false.
export const matchesMirrorKey = (key) => !!process.env.N8N_API_KEY && sameText(key, process.env.N8N_API_KEY);
export const matchesGlobalKey = (key) => globalKeyAllowed() && !!process.env.N8N_API_KEY && sameText(key, process.env.N8N_API_KEY);
