// Janelas (modais) do painel fecham com o botão "voltar" do celular/navegador e com a tecla ESC.
// Vale para todas as janelas de uma vez: cada janela aberta ganha uma entrada no histórico do navegador,
// então "voltar" fecha a janela em vez de sair da tela. Fechar pelo X, por Salvar ou clicando fora
// desfaz a entrada sozinho, sem deixar sujeira no histórico.

const SEL = '.modal-bg';

export function iniciarVoltarFecha() {
  if (typeof window === 'undefined' || window.__voltarFecha) return;
  window.__voltarFecha = true;

  let abertas = 0;      // janelas na tela agora
  let empilhadas = 0;   // entradas que nós colocamos no histórico
  let ignorar = 0;      // popstate causados por nós mesmos (ao desfazer entradas)

  const fecharUltima = () => {
    const todas = document.querySelectorAll(SEL);
    const ultima = todas[todas.length - 1];
    if (ultima) ultima.click();   // o fundo da janela já fecha ao receber o clique
  };

  const sincronizar = () => {
    abertas = document.querySelectorAll(SEL).length;
    while (empilhadas < abertas) {
      history.pushState({ janela: true }, '');
      empilhadas++;
    }
    if (empilhadas > abertas) {
      const sobra = empilhadas - abertas;
      empilhadas = abertas;
      ignorar++;
      history.go(-sobra);
    }
  };

  new MutationObserver(sincronizar).observe(document.body, { childList: true, subtree: true });

  window.addEventListener('popstate', () => {
    if (ignorar > 0) { ignorar--; return; }
    if (empilhadas > 0) {
      empilhadas--;
      fecharUltima();
      // se a janela não fechou (ex.: está salvando), repõe a entrada
      setTimeout(() => { if (document.querySelectorAll(SEL).length > empilhadas) sincronizar(); }, 0);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector(SEL)) {
      e.preventDefault();
      history.back();   // passa pelo mesmo caminho do botão voltar
    }
  });
}
