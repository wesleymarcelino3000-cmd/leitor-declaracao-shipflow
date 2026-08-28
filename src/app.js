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

function normalizeLine(line) {
  return String(line || '')
    .replace(/DESCR[1IÍ]C[AÃ]O/gi, 'DESCRICAO')
    .replace(/QTD\s*[xX]\s*TOTAL/gi, 'QTD x TOTAL')
    .replace(/R\$\s*/gi, 'R$')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanDescription(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;|\-]+/, '')
    .replace(/[\s:;|\-]+$/, '')
    .trim();
}

function canonicalDescription(description) {
  return cleanDescription(description)
    .replace(/\s+/g, ' ')
    .trim();
}

function parseQtyAndDescription(line) {
  const cleaned = normalizeLine(line);
  const match = cleaned.match(/^(.*?)\s+(\d+)\s*[xX]\s*R?\$?\s*[\d.,]+\s*$/i);
  if (!match) return null;
  const description = cleanDescription(match[1]);
  const quantity = Number.parseInt(match[2], 10);
  if (!description || !Number.isFinite(quantity) || quantity <= 0) return null;
  return { description, quantity };
}

function extractProductsFromBlockText(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map(normalizeLine)
    .filter(Boolean);

  const products = [];
  let inside = false;
  let pendingDescription = '';

  for (const line of lines) {
    const normalized = normalizeText(line);

    if (normalized.includes('DESCRICAO') && normalized.includes('QTD')) {
      inside = true;
      pendingDescription = '';
      continue;
    }

    if (!inside && normalized === 'DESCRICAO') {
      inside = true;
      pendingDescription = '';
      continue;
    }

    if (!inside) continue;

    if (normalized.startsWith('TOTAL') || normalized.includes('TOTAL:')) {
      if (pendingDescription) pendingDescription = '';
      inside = false;
      continue;
    }

    if (normalized === 'QTD X TOTAL' || normalized === 'QTD TOTAL') continue;
    if (!line || /^[-_—=]+$/.test(line)) continue;

    const parsed = parseQtyAndDescription(line);
    if (parsed) {
      const fullDescription = cleanDescription([pendingDescription, parsed.description].filter(Boolean).join(' '));
      products.push({ description: canonicalDescription(fullDescription), quantity: parsed.quantity, line });
      pendingDescription = '';
      continue;
    }

    if (/\d+\s*[xX]\s*R?\$?\s*[\d.,]+/.test(line) && pendingDescription) {
      const qtyMatch = line.match(/(\d+)\s*[xX]\s*R?\$?\s*[\d.,]+/);
      const qty = qtyMatch ? Number.parseInt(qtyMatch[1], 10) : 0;
      if (qty > 0) {
        products.push({ description: canonicalDescription(pendingDescription), quantity: qty, line });
        pendingDescription = '';
      }
      continue;
    }

    if (!/^(REMETENTE|DESTINATARIO|DECLARACAO|ASSINATURA|DOCUMENTO|OBSERVACAO|CPF|CNPJ|CEP|RUA|AVENIDA|BAIRRO|CIDADE)/i.test(normalized)) {
      pendingDescription = cleanDescription([pendingDescription, line].filter(Boolean).join(' '));
    }
  }

  return products;
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
    const contrast = gray < 180 ? 0 : 255;
    data[i] = contrast;
    data[i + 1] = contrast;
    data[i + 2] = contrast;
  }
  ctx.putImageData(image, 0, 0);
}

async function ocrPage(page) {
  const viewport = page.getViewport({ scale: 2.8 });
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
  const text = content.items.map((item) => item.str || '').join('\n');
  if (normalizeText(text).includes('DESCRICAO') && normalizeText(text).includes('TOTAL')) {
    return { text, source: 'texto do PDF' };
  }
  const ocrText = await ocrPage(page);
  return { text: ocrText || text, source: ocrText ? 'OCR da página' : 'texto parcial' };
}

function addProducts(fileName, page, raw, source) {
  const products = extractProductsFromBlockText(raw);
  pageReads.push({ fileName, page, source, products, raw });

  for (const product of products) {
    const key = canonicalDescription(product.description);
    counts[key] = (counts[key] || 0) + product.quantity;
    results.push({ fileName, page, source, description: key, quantity: product.quantity, rawLine: product.line });
  }
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
        addProducts(item.file.name, pageNumber, text, source);
        readPages += 1;
        pageCountEl.textContent = `${readPages}/${totalPages}`;
        setProgress(readPages, totalPages);
        renderRaw();
        render();
      }
    }

    const found = Object.values(counts).reduce((sum, qty) => sum + qty, 0);
    setStatus(found ? `Pronto. ${found} unidades encontradas em ${selectedFiles.length} PDF(s).` : 'Não encontrei produtos no bloco entre DESCRICAO e TOTAL.');
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
    const found = item.products.length
      ? item.products.map((p) => `- ${p.description} = ${p.quantity}`).join('\n')
      : '- nenhum produto encontrado no bloco DESCRICAO até TOTAL';
    return `${item.fileName} | PÁGINA ${item.page} | ${item.source}\nProdutos encontrados:\n${found}\n\nTEXTO LIDO:\n${item.raw}`;
  }).join('\n\n------------------------------\n\n');
}

function render() {
  const rows = Object.entries(counts)
    .map(([description, count]) => ({ description, count }))
    .sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  totalCountEl.textContent = `${total} unidades encontradas`;
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
  link.download = `contagem-produtos-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
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
