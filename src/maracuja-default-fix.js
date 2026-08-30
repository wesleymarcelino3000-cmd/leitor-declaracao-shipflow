// Correção: Melasonina sem sabor deve ser contada como MARACUJÁ.
// Este patch roda depois do app principal e ajusta a exibição final sem mexer no PDF original.
(() => {
  function normalizeLabel(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function patchStockRows() {
    const cards = Array.from(document.querySelectorAll('#table .row'));
    if (!cards.length) return;

    let avulsaCard = null;
    let maracujaCard = null;
    let avulsaQty = 0;
    let maracujaQty = 0;

    for (const card of cards) {
      const title = card.querySelector('strong');
      const bubble = card.querySelector('b');
      if (!title || !bubble) continue;

      const label = normalizeLabel(title.textContent);
      const qty = Number(String(bubble.textContent || '').replace(/\D+/g, '')) || 0;

      if (label.includes('AVULSA') || label.includes('SEM SABOR')) {
        avulsaCard = card;
        avulsaQty = qty;
      }

      if (label === 'MELASONINA MARACUJA') {
        maracujaCard = card;
        maracujaQty = qty;
      }
    }

    if (!avulsaCard || !avulsaQty) return;

    if (maracujaCard) {
      const newQty = maracujaQty + avulsaQty;
      const span = maracujaCard.querySelector('span');
      const bubble = maracujaCard.querySelector('b');
      if (span) span.textContent = `${newQty} unidades`;
      if (bubble) bubble.textContent = String(newQty);
      avulsaCard.remove();
    } else {
      const title = avulsaCard.querySelector('strong');
      if (title) title.textContent = 'Melasonina MARACUJÁ';
    }

    const total = document.getElementById('totalCount');
    if (total) {
      total.textContent = total.textContent.replace(/\|\s*6\s*produtos/i, '| 5 produtos');
    }
  }

  const observer = new MutationObserver(() => patchStockRows());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('load', patchStockRows);
  setInterval(patchStockRows, 1000);
})();
