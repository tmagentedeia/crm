// Gotenberg de mentira para os testes: devolve um "PDF" com o HTML recebido dentro, para conferir as variáveis.
import http from 'http';
const porta = Number(process.env.FAKE_GOTENBERG_PORT || 53000);
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{"status":"up"}');
  if (req.method === 'POST' && req.url === '/forms/chromium/convert/html') {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => { res.setHeader('content-type', 'application/pdf'); res.end(Buffer.concat([Buffer.from('%PDF-FAKE\n'), Buffer.concat(partes)])); });
    return;
  }
  res.statusCode = 404; res.end();
}).listen(porta);
