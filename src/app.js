const $ = (id) => document.getElementById(id);

const pdfInput = $('pdfInput');
const folderInput = $('folderInput');
const processBtn = $('processBtn');
const clearBtn = $('clearBtn');
const exportBtn = $('exportBtn');
const statusEl = $('status');
const fileNameEl = $('fileName');
const pageCountEl = $('pageCount');
const rawTextEl = $('rawText');
const tableEl = $('table');
const totalCountEl = $('totalCount');
const barEl = $('bar');

let selectedFiles = [];
let stockCounts = {};
let descriptionGroups = {};
let pageReads = [];
let details = [];

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

const PRODUCT_ORDER = [
  'Melasonina total',
  'Melasonina MARACUJÁ',
  'Melasonina LIMÃO',
  'Melasonina MORANGO',
  'Melasonina avulsa / sem sabor',
  'Máscara para Dormir',
];

function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(current, total) {
  const percent = total ? Math.round((current / total) * 100) : 0;
  barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function stripAccents(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalize(text) {
  return stripAccents(text).replace(/\s+/g, ' ').trim().toUpperCase();
}

function fixOcr(text) {
  return String(text || '')
    .replace(/DESCR[1IÍ]C[AÃ]O/gi, 'DESCRICAO')
    .replace(/MELAS[O0]NINA/gi, 'MELASONINA')
    .replace(/M[ÁA]SCARA/gi, 'MÁSCARA')
    .replace(/MARACUJ[ÁA]/gi, 'MARACUJÁ')
    .replace(/LIM[AÃ]O/gi, 'LIMÃO')
    .replace(/M[O0]RANGO/gi, 'MORANGO')
    .replace(/D[O0]RMIR/gi, 'DORMIR');
}

function clean(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;|\-+]+/, '')
    .replace(/[\s:;|\-+]+$/, '')
    .trim();
}

function cleanExact(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([|+])/g, ' $1')
    .replace(/([|+])\s+/g, '$1 ')
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function add(map, key, qty) {
  const amount = Number(qty || 0);
  if (!key || !Number.isFinite(amount) || amount <= 0) return;
  map[key] = (map[key] || 0) + amount;
}

function addDescriptionGroup(exactText, multiplier) {
  const label = cleanExact(exactText);
  if (!label) return;
  const key = normalize(label);
  if (!descriptionGroups[key]) descriptionGroups[key] = { description: label, count: 0 };
  descriptionGroups[key].count += Number(multiplier || 1) || 1;
}

function extractTracking(text) {
  const joined = normalize(text);
  const match = joined.match(/RASTREIO[:\s-]*([A-Z0-9]{6,25})/) || joined.match(/\b([A-Z0-9]{8})\b/);
  return match?.[1] || '';
}

function lineHasDescriptionHeader(line) {
  return normalize(line).includes('DESCRICAO');
}

function lineHasTotal(line) {
  const n = normalize(line);
  return n.startsWith('TOTAL') || n.includes(' TOTAL:') || n.includes('TOTAL R$');
}

function findLastQtyPrice(line) {
  const regex = /(\d+)\s*[xX]\s*R\$\s*[\d.,]+/g;
  let match;
  let last = null;
  while ((match = regex.exec(line)) !== null) {
    last = { qty: Number(match[1]), index: match.index, text: match[0] };
  }
  return last;
}

function extractDescriptionBlocks(text) {
  const lines = fixOcr(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lineHasDescriptionHeader(lines[i])) continue;

    const block = [];
    const headerTail = cleanExact(lines[i].replace(/DESCRICAO/gi, '').replace(/QTD\s*x\s*TOTAL/gi, ''));
    if (headerTail && !/^QTD/i.test(headerTail)) block.push(headerTail);

    for (let j = i + 1; j < lines.length; j += 1) {
      if (lineHasTotal(lines[j])) break;
      const n = normalize(lines[j]);
      if (!n || n.includes('DECLARO QUE') || n.includes('ASSINATURA')) break;
      block.push(lines[j]);
    }

    if (block.length) blocks.push(block);
  }
  return blocks;
}

function parseRowsFromBlock(blockLines) {
  const rows = [];
  let current = null;

  for (const raw of blockLines) {
    const line = cleanExact(raw);
    if (!line) continue;
    const qtyPrice = findLastQtyPrice(line);

    if (qtyPrice) {
      if (current?.description) rows.push(current);
      current = {
        description: cleanExact(line.slice(0, qtyPrice.index)),
        exactLine: cleanExact(line),
        multiplier: qtyPrice.qty || 1,
        qtyPriceText: qtyPrice.text,
        rawLines: [line],
      };
      continue;
    }

    if (current) {
      current.description = cleanExact(`${current.description} ${line}`);
      current.exactLine = cleanExact(`${current.exactLine} ${line}`);
      current.rawLines.push(line);
    }
  }

  if (current?.description) rows.push(current);
  return rows;
}

function getNumberBeforeProduct(text, productRegex) {
  const n = normalize(text);
  const product = productRegex.source.replace(/\\s\+/g, '\\s+');
  const patterns = [
    new RegExp(`(?:^|\\b)(\\d+)\\s*(?:UN|UNIDADE|UNIDADES|X)?\\s*${product}`, 'i'),
    new RegExp(`(?:^|\\b)${product}\\s*(?:\\||-| )?(\\d+)\\s*(?:UN|UNIDADE|UNIDADES|X)?`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = n.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return 0;
}

function getFlavorQuantity(text, flavor) {
  const n = normalize(text);
  const f = normalize(flavor);
  const before = new RegExp(`(?:^|[|+\\s])([0-9]+)\\s*(?:X|UN|UNIDADE|UNIDADES)?\\s*${f}\\b`, 'i');
  const after = new RegExp(`\\b${f}\\b\\s*(?:[|+\\- ]+)?([0-9]+)\\s*(?:X|UN|UNIDADE|UNIDADES)?`, 'i');
  const matchBefore = n.match(before);
  if (matchBefore?.[1]) return Number(matchBefore[1]);
  const matchAfter = n.match(after);
  if (matchAfter?.[1]) return Number(matchAfter[1]);
  return n.includes(f) ? 1 : 0;
}

function countMentionedFlavors(text) {
  return ['MARACUJÁ', 'LIMÃO', 'MORANGO'].filter((flavor) => normalize(text).includes(normalize(flavor))).length;
}

function interpretDescription(description, multiplier) {
  const desc = clean(description);
  const n = normalize(desc);
  const m = Number(multiplier || 1) || 1;
  const out = [];
  const addOut = (name, qty) => {
    const amount = Number(qty || 0) * m;
    if (amount > 0) out.push({ name, qty: amount });
  };

  const hasMelasonina = n.includes('MELASONINA');
  const hasMascara = n.includes('MASCARA');
  const flavors = [
    { name: 'Melasonina MARACUJÁ', flavor: 'MARACUJÁ' },
    { name: 'Melasonina LIMÃO', flavor: 'LIMÃO' },
    { name: 'Melasonina MORANGO', flavor: 'MORANGO' },
  ];

  if (hasMelasonina) {
    let totalMelasonina = getNumberBeforeProduct(desc, /MELASONINA/);
    const kitMatch = n.match(/KIT\s*(\d+)\s*X?\s*MELASONINA/) || n.match(/(\d+)\s*X\s*MELASONINA/);
    if (kitMatch?.[1]) totalMelasonina = Number(kitMatch[1]);
    if (!totalMelasonina && /^MELASONINA\b/.test(n)) totalMelasonina = 1;
    const frascoMatch = n.match(/(\d+)\s*(?:UN|FRASCO|FRASCOS)?\s*-?\s*MELASONINA/) || n.match(/(\d+)\s*UN\s*MELASONINA/);
    if (frascoMatch?.[1]) totalMelasonina = Number(frascoMatch[1]);
    if (totalMelasonina > 0) addOut('Melasonina total', totalMelasonina);
  }

  let flavorSum = 0;
  const mentionedFlavorCount = countMentionedFlavors(desc);
  for (const item of flavors) {
    let qty = getFlavorQuantity(desc, item.flavor);
    if (!qty && mentionedFlavorCount > 0 && normalize(desc).includes(normalize(item.flavor))) qty = 1;
    if (qty > 0) {
      flavorSum += qty;
      addOut(item.name, qty);
    }
  }

  if (hasMelasonina && flavorSum === 0) {
    let avulsa = getNumberBeforeProduct(desc, /MELASONINA/);
    if (!avulsa && /^MELASONINA\b/.test(n)) avulsa = 1;
    if (avulsa > 0) addOut('Melasonina avulsa / sem sabor', avulsa);
  }

  if (hasMascara) {
    const mascaraQty = getNumberBeforeProduct(desc, /MASCARA/) || 1;
    addOut('Máscara para Dormir', mascaraQty);
  }

  return out;
}

function itemsToLines(items) {
  const rows = [];
  for (const item of items) {
    const text = String(item.str || '').trim();
    if (!text) continue;
    const x = item.transform?.[4] || 0;
    const y = item.transform?.[5] || 0;
    let row = rows.find((r) => Math.abs(r.y - y) <= 3);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, text });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => row.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(' '))
    .join('\n');
}

async function readTextFromPage(page) {
  const content = await page.getTextContent();
  return itemsToLines(content.items || []);
}

function processPageText(fileName, pageNumber, text) {
  const fixed = fixOcr(text);
  const blocks = extractDescriptionBlocks(fixed);
  const tracking = extractTracking(fixed);
  const pageDetail = { fileName, page: pageNumber, tracking, raw: fixed, rows: [] };

  for (const block of blocks) {
    const rows = parseRowsFromBlock(block);
    for (const row of rows) {
      addDescriptionGroup(row.exactLine, row.multiplier);
      const interpreted = interpretDescription(row.description, row.multiplier);
      for (const item of interpreted) add(stockCounts, item.name, item.qty);
      details.push({ fileName, page: pageNumber, tracking, description: row.description, exactLine: row.exactLine, multiplier: row.multiplier, interpreted });
      pageDetail.rows.push({ ...row, interpreted });
    }
  }
  pageReads.push(pageDetail);
}

async function processPdfs() {
  if (!selectedFiles.length) return;
  if (!window.pdfjsLib) {
    setStatus('Leitor de PDF não carregou. Atualize a página.');
    return;
  }

  stockCounts = {};
  descriptionGroups = {};
  pageReads = [];
  details = [];
  render();
  rawTextEl.textContent = '';
  setProgress(0, 1);
  processBtn.disabled = true;
  clearBtn.disabled = true;
  exportBtn.disabled = true;

  try {
    const opened = [];
    let totalPages = 0;
    setStatus('Abrindo PDFs...');
    for (const file of selectedFiles) {
      const buffer = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
      opened.push({ file, pdf });
      totalPages += pdf.numPages;
    }

    let readPages = 0;
    pageCountEl.textContent = `0/${totalPages}`;
    for (const item of opened) {
      for (let pageNumber = 1; pageNumber <= item.pdf.numPages; pageNumber += 1) {
        setStatus(`Lendo ${item.file.name} — página ${pageNumber} de ${item.pdf.numPages}...`);
        const page = await item.pdf.getPage(pageNumber);
        const text = await readTextFromPage(page);
        processPageText(item.file.name, pageNumber, text);
        readPages += 1;
        pageCountEl.textContent = `${readPages}/${totalPages}`;
        setProgress(readPages, totalPages);
        renderRaw();
        render();
      }
    }

    const totalStock = Object.values(stockCounts).reduce((sum, qty) => sum + qty, 0);
    const declarationPages = pageReads.filter((p) => p.rows.length > 0).length;
    setStatus(totalStock ? `Pronto. ${totalStock} itens de estoque em ${declarationPages}/${totalPages} páginas com declaração.` : 'Não encontrei produtos entre DESCRICAO e TOTAL.');
  } catch (error) {
    console.error(error);
    setStatus(`Erro ao processar PDFs: ${error.message || error}`);
  } finally {
    processBtn.disabled = selectedFiles.length === 0;
    clearBtn.disabled = selectedFiles.length === 0;
    exportBtn.disabled = Object.keys(stockCounts).length === 0;
  }
}

function renderRaw() {
  if (!pageReads.length) {
    rawTextEl.textContent = 'Nenhuma leitura ainda.';
    return;
  }
  rawTextEl.textContent = pageReads.map((item) => {
    const header = `${item.fileName} | PÁGINA ${item.page} | ${item.rows.length ? `${item.rows.length} descrição(ões)` : 'sem declaração contada'}`;
    const rows = item.rows.length
      ? item.rows.map((row) => {
          const interpreted = row.interpreted.length ? row.interpreted.map((p) => `  - ${p.name}: ${p.qty}`).join('\n') : '  - nada interpretado';
          return `Linha exata: ${row.exactLine}\nDescrição para cálculo: ${row.description}\nMultiplicador: ${row.multiplier}\n${interpreted}`;
        }).join('\n\n')
      : 'Nenhuma descrição encontrada entre DESCRICAO e TOTAL.';
    return `${header}\nRastreio: ${item.tracking || '-'}\n${rows}\n\nTEXTO EXTRAÍDO:\n${item.raw}`;
  }).join('\n\n------------------------------\n\n');
}

function sortedStockRows() {
  const rows = Object.entries(stockCounts).map(([description, count]) => ({ description, count }));
  return rows.sort((a, b) => {
    const ia = PRODUCT_ORDER.indexOf(a.description);
    const ib = PRODUCT_ORDER.indexOf(b.description);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return b.count - a.count || a.description.localeCompare(b.description);
  });
}

function sortedDescriptionRows() {
  return Object.values(descriptionGroups).sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));
}

function renderRows(title, rows, emptyText) {
  if (!rows.length) return `<h2 class="section-title">${escapeHtml(title)}</h2><div class="empty">${escapeHtml(emptyText)}</div>`;
  return `
    <h2 class="section-title">${escapeHtml(title)}</h2>
    ${rows.map((row) => `
      <div class="row">
        <div>
          <strong>${escapeHtml(row.description)}</strong>
          <span>${row.count} ${title.includes('Descrições') ? 'multiplicador total' : `unidade${row.count === 1 ? '' : 's'}`}</span>
        </div>
        <b>${row.count}</b>
      </div>
    `).join('')}
  `;
}

function render() {
  const stockRows = sortedStockRows();
  const descriptionRows = sortedDescriptionRows();
  const total = stockRows.reduce((sum, row) => sum + row.count, 0);
  const declarationPages = pageReads.filter((p) => p.rows.length > 0).length;
  totalCountEl.textContent = `${total} itens calculados | ${stockRows.length} produtos | ${declarationPages} páginas com declaração`;
  exportBtn.disabled = stockRows.length === 0;
  const title = document.querySelector('.results-head h2');
  if (title) title.textContent = 'Quantidade gasta por produto';

  if (!stockRows.length && !descriptionRows.length) {
    tableEl.innerHTML = '<div class="empty">Selecione uma pasta ou adicione PDFs para gerar a contagem.</div>';
    return;
  }

  tableEl.innerHTML = [
    renderRows('Quantidade gasta por produto', stockRows, 'Nenhum produto calculado.'),
    renderRows('Descrições exatas das etiquetas', descriptionRows, 'Nenhuma descrição encontrada.'),
  ].join('<div style="height:24px"></div>');
}

function renderFileQueue() {
  if (!selectedFiles.length) {
    fileNameEl.textContent = 'Nenhum selecionado';
    pageCountEl.textContent = '-';
    processBtn.disabled = true;
    clearBtn.disabled = true;
    setStatus('Aguardando PDFs.');
    return;
  }
  fileNameEl.textContent = selectedFiles.map((file, index) => `${index + 1}. ${file.webkitRelativePath || file.name}`).join(' | ');
  processBtn.disabled = false;
  clearBtn.disabled = false;
  setStatus(`${selectedFiles.length} PDF(s) na fila. Você pode processar agora.`);
}

function addFiles(files) {
  const incoming = Array.from(files || []).filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  for (const file of incoming) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    const exists = selectedFiles.some((item) => `${item.name}|${item.size}|${item.lastModified}` === key);
    if (!exists) selectedFiles.push(file);
  }
  stockCounts = {};
  descriptionGroups = {};
  pageReads = [];
  details = [];
  rawTextEl.textContent = 'Nenhuma leitura ainda.';
  setProgress(0, 1);
  render();
  renderFileQueue();
  pdfInput.value = '';
  if (folderInput) folderInput.value = '';
}

function exportCsv() {
  const stockRows = sortedStockRows().map((row) => ['Produto calculado', row.description, String(row.count)]);
  const descriptionRows = sortedDescriptionRows().map((row) => ['Descrição exata da etiqueta', row.description, String(row.count)]);
  const csvRows = [['Tipo', 'Nome', 'Quantidade'], ...stockRows, ...descriptionRows];
  const csv = csvRows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shipflow-estoque-produtos-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

pdfInput?.addEventListener('change', (event) => addFiles(event.target.files));
folderInput?.addEventListener('change', (event) => addFiles(event.target.files));
processBtn?.addEventListener('click', processPdfs);
exportBtn?.addEventListener('click', exportCsv);
clearBtn?.addEventListener('click', () => {
  selectedFiles = [];
  stockCounts = {};
  descriptionGroups = {};
  pageReads = [];
  details = [];
  rawTextEl.textContent = 'Nenhuma leitura ainda.';
  setProgress(0, 1);
  render();
  renderFileQueue();
});

render();
renderFileQueue();