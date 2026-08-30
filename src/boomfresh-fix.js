// Patch: adiciona interpretação de Boom Fresh.
// Regra: se BOOM FRESH não tiver sabor explícito, conta como BOOM FRESH MENTA.
// Sabores: MENTA, MORANGO, LIMÃO, ICE BLACK / BLACK ICE.
(function () {
  const oldRender = window.render;

  function stripAccents(text) {
    return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function norm(text) {
    return stripAccents(text).replace(/\s+/g, ' ').trim().toUpperCase();
  }

  function add(map, key, qty) {
    const amount = Number(qty || 0);
    if (!key || !Number.isFinite(amount) || amount <= 0) return;
    map[key] = (map[key] || 0) + amount;
  }

  function qtyBefore(text, word) {
    const n = norm(text);
    const w = norm(word).replace(/\s+/g, '\\s+');
    const patterns = [
      new RegExp('(?:^|[|+\\s])(\\d+)\\s*(?:X|UN|UNIDADE|UNIDADES)?\\s*' + w + '\\b', 'i'),
      new RegExp('\\b' + w + '\\b\\s*(?:[|+\\- ]+)?(\\d+)\\s*(?:X|UN|UNIDADE|UNIDADES)?', 'i')
    ];
    for (const p of patterns) {
      const m = n.match(p);
      if (m && m[1]) return Number(m[1]);
    }
    return 0;
  }

  function has(text, word) {
    return norm(text).includes(norm(word));
  }

  function getBoomFlavorQty(description, flavorWords) {
    for (const word of flavorWords) {
      const q = qtyBefore(description, word);
      if (q > 0) return q;
    }
    return flavorWords.some((word) => has(description, word)) ? 1 : 0;
  }

  function interpretBoomFresh(description, multiplier) {
    const n = norm(description);
    if (!n.includes('BOOM FRESH') && !n.includes('BOOMFRESH')) return [];

    const m = Number(multiplier || 1) || 1;
    const out = [];
    const push = (name, qty) => {
      const amount = Number(qty || 0) * m;
      if (amount > 0) out.push({ name, qty: amount });
    };

    const totalBoom = qtyBefore(description, 'BOOM FRESH') || qtyBefore(description, 'BOOMFRESH') || 1;
    push('Boom Fresh total', totalBoom);

    const menta = getBoomFlavorQty(description, ['MENTA']);
    const morango = getBoomFlavorQty(description, ['MORANGO']);
    const limao = getBoomFlavorQty(description, ['LIMÃO', 'LIMAO']);
    const blackIce = getBoomFlavorQty(description, ['ICE BLACK', 'BLACK ICE']);
    const explicit = menta + morango + limao + blackIce;

    if (explicit > 0) {
      if (menta) push('Boom Fresh MENTA', menta);
      if (morango) push('Boom Fresh MORANGO', morango);
      if (limao) push('Boom Fresh LIMÃO', limao);
      if (blackIce) push('Boom Fresh BLACK ICE', blackIce);
    } else {
      // Boom Fresh sem sabor escrito = Menta
      push('Boom Fresh MENTA', totalBoom);
    }

    return out;
  }

  if (typeof window.interpretDescription === 'function') {
    const originalInterpret = window.interpretDescription;
    window.interpretDescription = function patchedInterpretDescription(description, multiplier) {
      const base = originalInterpret(description, multiplier) || [];
      const boom = interpretBoomFresh(description, multiplier);
      return base.concat(boom);
    };
  }

  // Alguns scripts antigos declararam as funções em escopo global sem anexar ao window.
  // Por isso também recalculamos antes de renderizar usando window.details e window.stockCounts, se disponíveis.
  window.applyBoomFreshPatchToCounts = function applyBoomFreshPatchToCounts() {
    if (!window.details || !window.stockCounts) return;
    for (const d of window.details) {
      const boom = interpretBoomFresh(d.description || d.exactLine || '', d.multiplier || 1);
      for (const item of boom) add(window.stockCounts, item.name, item.qty);
    }
  };

  window.render = function patchedRender() {
    try {
      window.applyBoomFreshPatchToCounts?.();
    } catch (err) {
      console.warn('Boom Fresh patch falhou:', err);
    }
    return typeof oldRender === 'function' ? oldRender.apply(this, arguments) : undefined;
  };
})();
