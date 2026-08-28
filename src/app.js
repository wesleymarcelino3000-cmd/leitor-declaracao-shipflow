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
function fixOcr(text) {
  return String(text || '')
    .replace(/DESCR[1IÍ]C[AÃ]O/gi, 'DESCRICAO')
    .replace(/DECLARA[ÇC][AÃ]O/gi, 'DECLARACAO')
    .replace(/CONTE[ÚU]DO/gi, 'CONTEUDO')
    .replace(/H[AÁ]L[1IÍ]TO/gi, 'HÁLITO')
    .replace(/RASPAD[0O]R/gi, 'RASPADOR')
    .replace(/SAB[0O]RES/gi, 'SABORES')
    .replace(/C[O0]MPRE/gi, 'COMPRE')
    .replace(/LEV[E3]/gi, 'LEVE');
}
function isStopLine(line) {
  const t = normalizeText(line);
  return ['QTD', 'QTDE', 'QUANTIDADE', 'VALOR', 'PESO', 'TOTAL', 'DECLARACAO', 'REMETENTE', 'DESTINATARIO', 'ASSINATURA', 'DOCUMENTO', 'OBSERVACAO'].some((w) => t.includes(w));
}
function isProductLine(line) {
  const t = normalizeText(line);
  if (t.length < 3 || /^\d+$/.test(t) || isStopLine(line)) return false;
  if (t.includes('KIT') || t.includes('COMPRE') || t.includes('LEVE') || t.includes('SABORES') || t.includes('RASPADOR') || t.includes('FIO') || t.includes('HALITO')) return true;
  return /[A-ZÀ-Ú]{3,}/i.test(line) && !/R\$|CPF|CNPJ|CEP|RUA|AVENIDA|BAIRRO|CIDADE/i.test(line);
}
function scoreProductLine(line) {
  const t = normalizeText(line);
  let score = Math.min(t.length, 80) / 10;
  ['KIT', 'COMPRE', 'LEVE', 'SABORES', 'RASPADOR', 'FIO', 'HALITO'].forEach((w) => { if (t.includes(w)) score += 8; });
  if (/CPF|CNPJ|CEP|RUA|AVENIDA|BAIRRO|DESTINATARIO|REMETENTE/.test(t)) score -= 20;
  return score;
}
function extractDescription(raw) {
  const text = fixOcr(raw);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const normalized = lines.map(normalizeText);
  for (let i = 0; i < normalized.length; i += 1) {
    if (!normalized[i].includes('DESCRICAO')) continue;
    const candidates = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      if (isStopLine(lines[j])) { if (candidates.length) break; continue; }
      if (isProductLine(lines[j])) candidates.push(lines[j]);
    }
    if (candidates.length) return cleanDescription(candidates.join(' '));
  }
  const productLines = lines.filter(isProductLine).sort((a, b) => scoreProductLine(b) - scoreProductLine(a));
  return productLines[0] ? cleanDescription(productLines[0]) : '';
}
function cleanDescription(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/^[\s:;|\-]+/, '').replace(/[\s:;|\-]+$/, '').replace(/\b(QTD|QTDE|QUANTIDADE|VALOR|PESO|TOTAL)\b.*$/i, '').trim();
}
function canonicalDescription(description) {
  const t = normalizeText(description).replace(/[^A-Z0-9]+/g, ' ').replace(/\b(UN|UND|UNIDADE|UNIDADES|PRODUTO|PRODUTOS)\b/g, '').replace(/\s+/g, ' ').trim();
  const aliases = [
    { keys: ['KIT', 'HALITO', 'SABORES', 'RASPADOR', 'FIO'], name: 'KIT BOM HÁLITO | 4 SABORES + RASPADOR + FIO' },
    { keys: ['COMPRE', 'LEVE'], name: 'Compre 1 Leve 2' },
  ];
  for (const alias of aliases) {
    const hits = alias.keys.filter((key) => t.includes(key)).length;
    if (hits >= Math.min(2, alias.keys.length)) return alias.name;
  }
  return cleanDescription(description).toUpperCase();
}
function looksLikeDeclaration(text) {
  const t = normalizeText(text);
  const hits = ['DECLARACAO', 'CONTEUDO', 'DESCRICAO', 'REMETENTE', 'DESTINATARIO', 'SHIPFLOW'].filter((w) => t.includes(w)).length;
  return hits >= 2 || t.includes('DESCRICAO') || t.includes('KIT') || t.includes('COMPRE');
}
function extractTracking(text) {
  const joined = normalizeText(text);
  const patterns = [/(?:RASTREIO|OBJETO|CODIGO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/, /\b([A-Z]{2}\d{9}[A-Z]{2})\b/, /\b([A-Z0-9]{10,18})\b/];
  for (const pattern of patterns) { const match = joined.match(pattern); if (match?.[1]) return match[1]; }
  return '';
}
function addResult(fileName, page, raw, source) {
  const text = fixOcr(raw);
  const description = extractDescription(text);
  const tracking = extractTracking(text);
  const valid = looksLikeDeclaration(text) && Boolean(description);
  const canonical = valid ? canonicalDescription(description) : '';
  results.push({ fileName, page, source, valid, description, canonical, tracking, raw: text });
  if (valid) counts[canonical] = (counts[canonical] || 0) + 1;
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
    data[i] = data[i + 1] = data[i + 2] = contrast;
  }
  ctx.putImageData(image, 0, 0);
}
async function ocrPage(page) {
  const viewport = page.getViewport({ scale: 2.4 });
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
  if (normalizeText(text).length >= 30 && looksLikeDeclaration(text)) return { text, source: 'texto do PDF' };
  const ocrText = await ocrPage(page);
  return { text: ocrText || text, source: ocrText ? 'OCR da página' : 'texto parcial' };
}
async function processPdfs() {
  if (!selectedFiles.length) return;
  if (!window.pdfjsLib) return setStatus('Leitor de PDF não carregou. Atualize a página.');
  results = [];
  counts = {};
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
        addResult(item.file.name, pageNumber, text, source);
        readPages += 1;
        pageCountEl.textContent = `${readPages}/${totalPages}`;
        setProgress(readPages, totalPages);
        renderRaw();
        render();
      }
    }
    const found = Object.values(counts).reduce((sum, qty) => sum + qty, 0);
    setStatus(found ? `Pronto. ${found} etiquetas encontradas em ${selectedFiles.length} PDF(s).` : 'Não encontrei descrições. Verifique se os PDFs têm declaração legível.');
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
  if (!results.length) { rawTextEl.textContent = 'Nenhuma leitura ainda.'; return; }
  rawTextEl.textContent = results.map((item) => {
    const header = `${item.fileName} | PÁGINA ${item.page} | ${item.source} | ${item.valid ? 'OK' : 'NÃO CONTADA'}`;
    const fields = `Descrição: ${item.description || '-'}\nAgrupado como: ${item.canonical || '-'}\nRastreio: ${item.tracking || '-'}`;
    return `${header}\n${fields}\n\n${item.raw}`;
  }).join('\n\n------------------------------\n\n');
}
function render() {
  const rows = Object.entries(counts).map(([description, count]) => ({ description, count })).sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  totalCountEl.textContent = `${total} etiquetas encontradas`;
  exportBtn.disabled = rows.length === 0;
  if (!rows.length) { tableEl.innerHTML = '<div class="empty">Selecione uma pasta ou adicione PDFs para gerar a contagem.</div>'; return; }
  tableEl.innerHTML = rows.map((row) => `<div class="row"><div><strong>${escapeHtml(row.description)}</strong><span>${row.count} etiqueta${row.count === 1 ? '' : 's'}</span></div><b>${row.count}</b></div>`).join('');
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
  rawTextEl.textContent = 'Nenhuma leitura ainda.';
  setProgress(0, 1);
  render();
  renderFileQueue();
  pdfInput.value = '';
  if (folderInput) folderInput.value = '';
}
function exportCsv() {
  const rows = Object.entries(counts).map(([description, count]) => [description, String(count)]);
  const csvRows = [['Descricao', 'Quantidade de etiquetas'], ...rows];
  const csv = csvRows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `contagem-pdf-etiquetas-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
function escapeHtml(text) { return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function clearAll() {
  selectedFiles = [];
  results = [];
  counts = {};
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
