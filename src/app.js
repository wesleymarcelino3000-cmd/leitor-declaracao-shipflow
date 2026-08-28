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
let results = [];
let counts = {};
let pageReads = [];
let ocrWorker = null;

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(current, total) {
  const percent = total ? Math.round((current / total) * 100) : 0;
  barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function fixOcr(text) {
  return String(text || '')
    .replace(/DESCR[1IÍ]C[AÃ]O/gi, 'DESCRICAO')
    .replace(/DECLARA[ÇC][AÃ]O/gi, 'DECLARACAO')
    .replace(/CONTE[ÚU]DO/gi, 'CONTEUDO')
    .replace(/MELAS[O0]NINA/gi, 'MELASONINA')
    .replace(/M[ÁA]SCARA/gi, 'MÁSCARA')
    .replace(/MARACUJ[ÁA]/gi, 'MARACUJÁ')
    .replace(/LIM[AÃ]O/gi, 'LIMÃO')
    .replace(/M[O0]RANGO/gi, 'MORANGO')
    .replace(/D[O0]RMIR/gi, 'DORMIR');
}

function cleanDescription(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;|\-]+/, '')
    .replace(/[\s:;|\-]+$/, '')
    .trim();
}

function canonicalDescription(description) {
  return cleanDescription(description).toUpperCase();
}

function extractTracking(text) {
  const joined = normalizeText(text);
  const patterns = [
    /(?:RASTREIO|OBJETO|CODIGO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/,
    /\b([A-Z]{2}\d{9}[A-Z]{2})\b/,
    /\b([A-Z0-9]{8,18})\b/,
  ];
  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function lineHasDescriptionHeader(line) {
  return normalizeText(line).includes('DESCRICAO');
}

function lineHasTotal(line) {
  return /^\s*TOTAL\s*:?/i.test(normalizeText(line)) || normalizeText(line).startsWith('TOTAL R$');
}

function findLastQtyPrice(line) {
  const regex = /(\d+)\s*[xX]\s*R\$\s*[\d.,]+/g;
  let match;
  let last = null;
  while ((match = regex.exec(line)) !== null) {
    last = {
      qty: Number(match[1]),
      index: match.index,
      text: match[0],
    };
  }
  return last;
}

function extractDescriptionBlock(text) {
  const lines = fixOcr(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lineHasDescriptionHeader(lines[i])) continue;

    const block = [];
    const headerTail = lines[i]
      .replace(/DESCRICAO/gi, '')
      .replace(/QTD\s*x\s*TOTAL/gi, '')
      .trim();
    if (headerTail && !/^QTD/i.test(headerTail)) block.push(headerTail);

    for (let j = i + 1; j < lines.length; j += 1) {
      if (lineHasTotal(lines[j])) break;
      const n = normalizeText(lines[j]);
      if (!n || n.includes('DECLARO QUE') || n.includes('ASSINATURA')) break;
      block.push(lines[j]);
    }
    if (block.length) blocks.push(block);
  }
  return blocks;
}

function parseProductRowsFromBlock(blockLines) {
  const rows = [];
  let current = null;

  for (const rawLine of blockLines) {
    const line = cleanDescription(rawLine);
    if (!line) continue;

    const qtyPrice = findLastQtyPrice(line);
    if (qtyPrice) {
      if (current?.description) rows.push(current);
      const desc = cleanDescription(line.slice(0, qtyPrice.index));
      current = {
        description: desc,
        quantity: qtyPrice.qty || 1,
        rawLines: [line],
      };
      continue;
    }

    if (current) {
      current.description = cleanDescription(`${current.description} ${line}`);
      current.rawLines.push(line);
    }
  }

  if (current?.description) rows.push(current);
  return rows.filter((row) => row.description && row.quantity > 0);
}

function parseProductsFromText(text) {
  const blocks = extractDescriptionBlock(text);
  const products = [];
  for (const block of blocks) products.push(...parseProductRowsFromBlock(block));
  return products;
}

function addPageResults(fileName, page, raw, source) {
  const text = fixOcr(raw);
  const tracking = extractTracking(text);
  const products = parseProductsFromText(text);

  pageReads.push({
    fileName,
    page,
    source,
    tracking,
    counted: products.length,
    raw: text,
    products,
  });

  for (const product of products) {
    const canonical = canonicalDescription(product.description);
    results.push({
      fileName,
      page,
      source,
      tracking,
      description: product.description,
      canonical,
      quantity: product.quantity,
      rawLines: product.rawLines,
    });
    counts[canonical] = (counts[canonical] || 0) + product.quantity;
  }
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

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract?.createWorker) throw new Error('OCR não carregou. Atualize a página e tente novamente.');
  setStatus('Carregando OCR para páginas sem texto...');
  ocrWorker = await window.Tesseract.createWorker('por');
  return ocrWorker;
}

function enhanceCanvas(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const contrast = gray < 170 ? 0 : 255;
    data[i] = contrast;
    data[i + 1] = contrast;
    data[i + 2] = contrast;
  }
  ctx.putImageData(image, 0, 0);
}

async function ocrPage(page) {
  const viewport = page.getViewport({ scale: 2.5 });
  const pageCanvas = document.createElement('canvas');
  const ctx = pageCanvas.getContext('2d', { willReadFrequently: true });
  pageCanvas.width = Math.floor(viewport.width);
  pageCanvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  enhanceCanvas(ctx, pageCanvas.width, pageCanvas.height);
  const worker = await getOcrWorker();
  const result = await worker.recognize(pageCanvas);
  return result?.data?.text || '';
}

async function readTextFromPage(page) {
  const content = await page.getTextContent();
  const text = itemsToLines(content.items || []);
  if (parseProductsFromText(text).length > 0) return { text, source: 'texto do PDF' };
  const ocrText = await ocrPage(page);
  return { text: ocrText || text, source: ocrText ? 'OCR da página' : 'texto parcial' };
}

async function processPdfs() {
  if (!selectedFiles.length) return;
  if (!window.pdfjsLib) {
    setStatus('Leitor de PDF não carregou. Atualize a página.');
    return;
  }

  results = [];
  counts = {};
  pageReads = [];
  render();
  rawTextEl.textContent = '';
  setProgress(0, 1);
  processBtn.disabled = true;
  clearBtn.disabled = true;
  exportBtn.disabled = true;

  try {
    let totalPages = 0;
    const opened = [];
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
        const { text, source } = await readTextFromPage(page);
        addPageResults(item.file.name, pageNumber, text, source);
        readPages += 1;
        pageCountEl.textContent = `${readPages}/${totalPages}`;
        setProgress(readPages, totalPages);
        renderRaw();
        render();
      }
    }

    const totalUnits = Object.values(counts).reduce((sum, qty) => sum + qty, 0);
    const countedPages = pageReads.filter((p) => p.counted > 0).length;
    setStatus(totalUnits ? `Pronto. ${totalUnits} unidades em ${countedPages}/${totalPages} páginas com declaração.` : 'Não encontrei produtos no bloco DESCRICAO → TOTAL.');
  } catch (error) {
    console.error(error);
    setStatus(`Erro ao processar PDFs: ${error.message || error}`);
  } finally {
    processBtn.disabled = selectedFiles.length === 0;
    clearBtn.disabled = selectedFiles.length === 0;
    exportBtn.disabled = Object.keys(counts).length === 0;
  }
}

function renderRaw() {
  if (!pageReads.length) {
    rawTextEl.textContent = 'Nenhuma leitura ainda.';
    return;
  }

  rawTextEl.textContent = pageReads.map((item) => {
    const header = `${item.fileName} | PÁGINA ${item.page} | ${item.source} | ${item.counted ? `${item.counted} produto(s)` : 'NÃO CONTADA'}`;
    const fields = item.products.length
      ? item.products.map((p) => `- ${p.description} = ${p.quantity}`).join('\n')
      : 'Nenhum produto encontrado entre DESCRICAO e TOTAL.';
    return `${header}\nRastreio: ${item.tracking || '-'}\n${fields}\n\n${item.raw}`;
  }).join('\n\n------------------------------\n\n');
}

function render() {
  const rows = Object.entries(counts)
    .map(([description, count]) => ({ description, count }))
    .sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const countedPages = pageReads.filter((p) => p.counted > 0).length;
  totalCountEl.textContent = `${total} unidades encontradas | ${rows.length} produtos | ${countedPages} páginas com declaração`;
  exportBtn.disabled = rows.length === 0;

  if (!rows.length) {
    tableEl.innerHTML = '<div class="empty">Selecione uma pasta ou adicione PDFs para gerar a contagem.</div>';
    return;
  }

  tableEl.innerHTML = rows.map((row) => `
    <div class="row">
      <div>
        <strong>${escapeHtml(row.description)}</strong>
        <span>${row.count} unidade${row.count === 1 ? '' : 's'}</span>
      </div>
      <b>${row.count}</b>
    </div>
  `).join('');
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
  results = [];
  counts = {};
  pageReads = [];
  rawTextEl.textContent = 'Nenhuma leitura ainda.';
  setProgress(0, 1);
  render();
  renderFileQueue();
  pdfInput.value = '';
  if (folderInput) folderInput.value = '';
}

function exportCsv() {
  const rows = Object.entries(counts).map(([description, count]) => [description, String(count)]);
  const csvRows = [['Descricao', 'Quantidade'], ...rows];
  const csv = csvRows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `contagem-pdf-etiquetas-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clearAll() {
  selectedFiles = [];
  results = [];
  counts = {};
  pageReads = [];
  pdfInput.value = '';
  if (folderInput) folderInput.value = '';
  fileNameEl.textContent = 'Nenhum selecionado';
  pageCountEl.textContent = '-';
  rawTextEl.textContent = 'Nenhuma leitura ainda.';
  setStatus('Aguardando PDFs.');
  setProgress(0, 1);
  processBtn.disabled = true;
  clearBtn.disabled = true;
  exportBtn.disabled = true;
  render();
}

pdfInput.addEventListener('change', (event) => addFiles(event.target.files));
if (folderInput) folderInput.addEventListener('change', (event) => addFiles(event.target.files));
processBtn.addEventListener('click', processPdfs);
clearBtn.addEventListener('click', clearAll);
exportBtn.addEventListener('click', exportCsv);
render();
