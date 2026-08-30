// Correção: a lista "Descrições exatas das etiquetas" deve agrupar o bloco inteiro
// entre DESCRICAO e TOTAL, e não separar cada linha interna da declaração.

processPageText = function processPageText(fileName, pageNumber, text) {
  const fixed = fixOcr(text);
  const blocks = extractDescriptionBlocks(fixed);
  const tracking = extractTracking(fixed);
  const pageDetail = { fileName, page: pageNumber, tracking, raw: fixed, rows: [] };

  for (const block of blocks) {
    const rows = parseRowsFromBlock(block);

    // Descrição exata da etiqueta = bloco inteiro da declaração.
    // Exemplo:
    // MELASONINA | MARACUJÁ ORIGINAL 2x R$139.40
    // MELASONINA | SABOR LIMÃO 1x R$69.70
    // deve ser uma única descrição agrupada.
    const exactBlockText = cleanExact(block.join(' / '));
    const blockMultiplier = 1;
    addDescriptionGroup(exactBlockText, blockMultiplier);

    // Cálculo de estoque continua por linha/produto interno.
    for (const row of rows) {
      const interpreted = interpretDescription(row.description, row.multiplier);
      for (const item of interpreted) add(stockCounts, item.name, item.qty);
      details.push({
        fileName,
        page: pageNumber,
        tracking,
        description: row.description,
        exactLine: exactBlockText,
        multiplier: row.multiplier,
        interpreted,
      });
      pageDetail.rows.push({ ...row, exactLine: exactBlockText, interpreted });
    }
  }

  pageReads.push(pageDetail);
};
