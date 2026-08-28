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
let pageReads = [];
let declarationCounts = {};
let realProductCounts = {};
let ocrWorker = null;

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

function setStatus(text) { statusEl.textContent = text; }
function setProgress(current, total) {
  const percent = total ? Math.round((current / total) * 100) : 0;
  barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}
function normalizeText(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
function fixText(text) {
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
  return String(text || '').replace(/\s+/g, ' ').replace(/^[\s:;|\-]+/, '').replace(/[\s:;|\-]+$/, '').trim();
}
function add(map, key, qty) {
  const name = clean(key);
  const value = Number(qty) || 0;
  if (!name || value <= 0) return;
  map[name] = (map[name] || 0) + value;
}
function lineHasHeader(line) { return normalizeText(line).includes('DESCRICAO'); }
function lineHasTotal(line) {
  const n = normalizeText(line);
  return n === 'TOTAL' || n.startsWith('TOTAL:') || n.startsWith('TOTAL R$');
}
function findLastQtyPrice(line) {
  const regex = /(\d+)\s*[xX]\s*R\$\s*[\d.,]+/g;
  let match;
  let last = null;
  while ((match = regex.exec(line)) !== null) {
    last = { qty: Number(match[1]) || 1, index: match.index, text: match[0] };
  }
  return last;
}
function textItemsToLines(items) {
  const rows = [];
  for (const item of items) {
    const text = String(item.str || '').trim();
    if (!text) continue;
    const x = item.transform?.[4] || 0;
    const y = item.transform?.[5] || 0;
    let row = rows.find((r) => Math.abs(r.y - y) <= 3);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, text });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => row.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(' '))
    .join('\n');
}
function extractBlocks(text) {
  const lines = fixText(text).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lineHasHeader(lines[i])) continue;
    const block = [];
    const headerTail = clean(lines[i].replace(/DESCRICAO/gi, '').replace(/QTD\s*x\s*TOTAL/gi, ''));
    if (headerTail && !/^QTD/i.test(headerTail)) block.push(headerTail);
    for (let j = i + 1; j < lines.length; j += 1) {
      const n = normalizeText(lines[j]);
      if (lineHasTotal(lines[j])) break;
      if (n.includes('DECLARO QUE') || n.includes('ASSINATURA')) break;
      block.push(lines[j]);
    }
    if (block.length) blocks.push(block);
  }
  return blocks;
}
function parseRowsFromBlock(block) {
  const rows = [];
  let current = null;
  for (const rawLine of block) {
    const line = clean(rawLine);
    if (!line) continue;
    const qtyPrice = findLastQtyPrice(line);
    if (qtyPrice) {
      if (current?.description) rows.push(current);
      current = {
        description: clean(line.slice(0, qtyPrice.index)),
        multiplier: qtyPrice.qty,
        lines: [line],
      };
    } else if (current) {
      current.description = clean(`${current.description} ${line}`);
      current.lines.push(line);
    }
  }
  if (current?.description) rows.push(current);
  return rows.filter((row) => row.description && row.multiplier > 0);
}
function parseDeclarationRows(text) {
  return extractBlocks(text).flatMap(parseRowsFromBlock);
}
function flavorName(raw) {
  const n = normalizeText(raw);
  if (n.includes('MARACUJA')) return 'Melasonina Maracujá';
  if (n.includes('LIMAO')) return 'Melasonina Limão';
  if (n.includes('MORANGO')) return 'Melasonina Morango';
  return '';
}
function parseRealProducts(description, multiplier) {
  const result = {};
  const desc = fixText(description);
  const n = normalizeText(desc);
  const mult = Number(multiplier) || 1;

  const kitQty = n.match(/(\d+)\s*(?:UN\s*)?MELASONINA/);
  let melasoninaTotal = kitQty ? Number(kitQty[1]) * mult : 0;

  const explicitFlavorRegex = /(\d+)\s*[xX]\s*(MARACUJ[ÁA]|MARACUJA|LIM[ÃA]O|LIMAO|MORANGO)/gi;
  let match;
  let flavorTotal = 0;
  while ((match = explicitFlavorRegex.exec(desc)) !== null) {
    const qty = Number(match[1]) || 1;
    const name = flavorName(match[2]);
    if (name) {
      add(result, name, qty * mult);
      flavorTotal += qty * mult;
    }
  }

  if (!flavorTotal && n.includes('MELASONINA')) {
    const flavors = [
      ['MARACUJA', 'Melasonina Maracujá'],
      ['LIMAO', 'Melasonina Limão'],
      ['MORANGO', 'Melasonina Morango'],
    ];
    let foundFlavor = false;
    for (const [token, name] of flavors) {
      if (n.includes(token)) {
        foundFlavor = true;
        add(result, name, mult);
        flavorTotal += mult;
      }
    }
    if (!foundFlavor) add(result, 'Melasonina sem sabor identificado', mult);
  }

  if (!melasoninaTotal && n.includes('MELASONINA')) melasoninaTotal = flavorTotal || mult;
  if (melasoninaTotal) add(result, 'Melasonina total', melasoninaTotal);

  if (n.includes('MASCARA') || n.includes('DORMIR')) add(result, 'Máscara para Dormir', mult);
  if (!Object.keys(result).length) add(result, clean(description), mult);
  return result;
}
function extractTracking(text) {
  const joined = normalizeText(text);
  const patterns = [/(?:RASTREIO|OBJETO|CODIGO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/, /\b([A-Z]{2}\d{9}[A-Z]{2})\b/, /\b([A-Z0-9]{8,18})\b/];
  for (const pattern of patterns) { const match = joined.match(pattern); if (match?.[1]) return match[1]; }
  return '';
}
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract?.createWorker) throw new Error('OCR não carregou. Atualize a página e tente novamente.');
  setStatus('Carregando OCR para páginas sem texto...');
  ocrWorker = await window.Tesseract.createWorker('por');
  return ocrWorker;
}
async function ocrPage(page) {
  const viewport = page.getViewport({ scale: 2.4 });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const worker = await getOcrWorker();
  const result = await worker.recognize(canvas);
  return result?.data?.text || '';
}
async function readTextFromPage(page) {
  const content = await page.getTextContent();
  const text = textItemsToLines(content.items || []);
  if (parseDeclarationRows(text).length) return { text, source: 'texto do PDF' };
  const ocrText = await ocrPage(page);
  return { text: ocrText || text, source: ocrText ? 'OCR da página' : 'texto parcial' };
}
function addPage(fileName, pageNumber, raw, source) {
  const text = fixText(raw);
  const tracking = extractTracking(text);
  const rows = parseDeclarationRows(text);
  const pageRecord = { fileName, pageNumber, source, tracking, rows, raw: text };
  pageReads.push(pageRecord);

  for (const row of rows) {
    add(declarationCounts, clean(row.description).toUpperCase(), row.multiplier);
    const usage = parseRealProducts(row.description, row.multiplier);
    row.usage = usage;
    for (const [name, qty] of Object.entries(usage)) add(realProductCounts, name, qty);
  }
}
async function processPdfs() {
  if (!selectedFiles.length) return;
  if (!window.pdfjsLib) return setStatus('Leitor de PDF não carregou. Atualize a página.');

  pageReads = [];
  declarationCounts = {};
  realProductCounts = {};
  render();
  rawTextEl.textContent = '';
  setProgress(0, 1);
  processBtn.disabled = clearBtn.disabled = exportBtn.disabled = true;

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
        const { text, source } = await readTextFromPage(page);
        addPage(item.file.name, pageNumber, text, source);
        readPages += 1;
        pageCountEl.textContent = `${readPages}/${totalPages}`;
        setProgress(readPages, totalPages);
        renderRaw();
        render();
      }
    }

    const totalUsage = Object.values(realProductCounts).reduce((sum, qty) => sum + qty, 0);
    const countedPages = pageReads.filter((p) => p.rows.length > 0).length;
    setStatus(totalUsage ? `Pronto. ${totalUsage} unidades gastas em ${countedPages}/${totalPages} páginas com declaração.` : 'Não encontrei produtos no bloco DESCRICAO → TOTAL.');
  } catch (error) {
    console.error(error);
    setStatus(`Erro ao processar PDFs: ${error.message || error}`);
  } finally {
    processBtn.disabled = selectedFiles.length === 0;
    clearBtn.disabled = selectedFiles.length === 0;
    exportBtn.disabled = Object.keys(realProductCounts).length === 0;
  }
}
function rowsFromMap(map) {
  return Object.entries(map).map(([description, count]) => ({ description, count })).sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));
}
function renderSection(title, subtitle, rows) {
  if (!rows.length) return '';
  return `<div class="section-title"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>` + rows.map((row) => `
    <div class="row"><div><strong>${escapeHtml(row.description)}</strong><span>${row.count} unidade${row.count === 1 ? '' : 's'}</span></div><b>${row.count}</b></div>
  `).join('');
}
function render() {
  const realRows = rowsFromMap(realProductCounts);
  const declarationRows = rowsFromMap(declarationCounts);
  const melTotal = realProductCounts['Melasonina total'] || 0;
  const totalReal = realRows.reduce((sum, row) => sum + row.count, 0);
  totalCountEl.textContent = `${melTotal} melasoninas | ${totalReal} itens totais | ${realRows.length} produtos reais`;
  exportBtn.disabled = realRows.length === 0;
  if (!realRows.length && !declarationRows.length) {
    tableEl.innerHTML = '<div class="empty">Selecione uma pasta ou adicione PDFs para gerar a contagem.</div>';
    return;
  }
  tableEl.innerHTML = renderSection('Quantidade gasta por produto real', 'Conta: número dentro da descrição × multiplicador antes do R$.', realRows)
    + renderSection('Quantidade por descrição original', 'Agrupamento da declaração, sem separar os itens internos.', declarationRows);
}
function renderRaw() {
  if (!pageReads.length) { rawTextEl.textContent = 'Nenhuma leitura ainda.'; return; }
  rawTextEl.textContent = pageReads.map((page) => {
    const header = `${page.fileName} | página ${page.pageNumber} | ${page.source} | ${page.rows.length ? `${page.rows.length} linha(s)` : 'não contada'}`;
    const rows = page.rows.length ? page.rows.map((row) => {
      const usage = Object.entries(row.usage || {}).map(([name, qty]) => `${name}: ${qty}`).join(' | ');
      return `- ${row.description} | multiplicador ${row.multiplier}x => ${usage}`;
    }).join('\n') : 'Nenhum produto encontrado entre DESCRICAO e TOTAL.';
    return `${header}\nRastreio: ${page.tracking || '-'}\n${rows}\n\n${page.raw}`;
  }).join('\n\n------------------------------\n\n');
}
function renderFileQueue() {
  if (!selectedFiles.length) {
    fileNameEl.textContent = 'Nenhum selecionado';
    pageCountEl.textContent = '-';
    processBtn.disabled = clearBtn.disabled = true;
    setStatus('Aguardando PDFs.');
    return;
  }
  fileNameEl.textContent = selectedFiles.map((file, i) => `${i + 1}. ${file.webkitRelativePath || file.name}`).join(' | ');
  processBtn.disabled = clearBtn.disabled = false;
  setStatus(`${selectedFiles.length} PDF(s) na fila. Você pode processar agora.`);
}
function addFiles(files) {
  const incoming = Array.from(files || []).filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  for (const file of incoming) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    const exists = selectedFiles.some((item) => `${item.name}|${item.size}|${item.lastModified}` === key);
    if (!exists) selectedFiles.push(file);
  }
  pageReads = [];
  declarationCounts = {};
  realProductCounts = {};
  rawTextEl.textContent = 'Nenhuma leitura ainda.';
  setProgress(0, 1);
  render();
  renderFileQueue();
  pdfInput.value = '';
  if (folderInput) folderInput.value = '';
}
function exportCsv() {
  const realRows = rowsFromMap(realProductCounts).map((r) => ['Produto real gasto', r.description, String(r.count)]);
  const declarationRows = rowsFromMap(declarationCounts).map((r) => ['Descrição original', r.description, String(r.count)]);
  const csvRows = [['Tipo', 'Descricao', 'Quantidade'], ...realRows, ...declarationRows];
  const csv = csvRows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `contagem-produtos-reais-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
function clearAll() {
  selectedFiles = [];
  pageReads = [];
  declarationCounts = {};
  realProductCounts = {};
  pdfInput.value = '';
  if (folderInput) folderInput.value = '';
  fileNameEl.textContent = 'Nenhum selecionado';
  pageCountEl.textContent = '-';
  rawTextEl.textContent = 'Nenhuma leitura ainda.';
  setStatus('Aguardando PDFs.');
  setProgress(0, 1);
  processBtn.disabled = clearBtn.disabled = exportBtn.disabled = true;
  render();
}
function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

pdfInput.addEventListener('change', (event) => addFiles(event.target.files));
if (folderInput) folderInput.addEventListener('change', (event) => addFiles(event.target.files));
processBtn.addEventListener('click', processPdfs);
clearBtn.addEventListener('click', clearAll);
exportBtn.addEventListener('click', exportCsv);
render();
