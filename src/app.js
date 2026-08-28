const $ = (id) => document.getElementById(id);

const video = $('video');
const canvas = $('canvas');
const placeholder = $('placeholder');
const cameraBtn = $('cameraBtn');
const scanBtn = $('scanBtn');
const manualBtn = $('manualBtn');
const undoBtn = $('undoBtn');
const exportBtn = $('exportBtn');
const clearBtn = $('clearBtn');
const statusEl = $('status');
const lastDescriptionEl = $('lastDescription');
const lastTrackingEl = $('lastTracking');
const rawTextEl = $('rawText');
const tableEl = $('table');
const totalCountEl = $('totalCount');

let stream = null;
let worker = null;
let scanning = false;
let processing = false;
let lastDescription = '';
let lastTracking = '';
let lastStable = { description: '', tracking: '', time: 0 };
let cameraMode = 'environment';

let counts = loadJson('shipflow_counts', {});
let seenTrackings = new Set(loadJson('shipflow_seen_trackings', []));

const fallbackInput = document.createElement('input');
fallbackInput.type = 'file';
fallbackInput.accept = 'image/*';
fallbackInput.capture = 'environment';
fallbackInput.style.display = 'none';
document.body.appendChild(fallbackInput);

const fallbackBtn = document.createElement('button');
fallbackBtn.type = 'button';
fallbackBtn.textContent = '📸 Usar câmera do celular';
fallbackBtn.title = 'Abre a câmera pelo sistema do celular quando o navegador bloqueia a câmera ao vivo';
cameraBtn.insertAdjacentElement('afterend', fallbackBtn);

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}
function saveState() {
  localStorage.setItem('shipflow_counts', JSON.stringify(counts));
  localStorage.setItem('shipflow_seen_trackings', JSON.stringify([...seenTrackings]));
}
function setStatus(text) { statusEl.textContent = text; }
function normalizeText(text) { return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase(); }
function cleanDescription(text) { return (text || '').replace(/\s+/g, ' ').replace(/^[\s:;|\-]+/, '').replace(/[\s:;|\-]+$/, '').trim(); }

function explainCameraError(err) {
  const name = err?.name || 'Erro desconhecido';
  const message = err?.message || '';
  if (!window.isSecureContext) return 'A câmera ao vivo só funciona em HTTPS. Abra o link final do Cloudflare, não preview interno.';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'Este navegador não liberou câmera ao vivo. Use o botão “Usar câmera do celular”.';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Permissão negada. Toque no cadeado do navegador e libere a câmera para este site.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Nenhuma câmera foi encontrada neste aparelho/navegador.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'A câmera está em uso por outro app. Feche câmera/WhatsApp/Instagram e tente de novo.';
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'A câmera traseira não abriu. Vou tentar outro modo de câmera.';
  return `Erro ao abrir câmera: ${name} ${message}`.trim();
}

function extractTracking(raw) {
  const lines = (raw || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const joined = lines.join(' ');
  const patterns = [/(?:RASTREIO|C[OÓ]DIGO|OBJETO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/i, /\b([A-Z]{2}\d{9}[A-Z]{2})\b/i, /\b([A-Z0-9]{10,18})\b/];
  for (const p of patterns) { const m = joined.match(p); if (m && m[1]) return m[1].toUpperCase(); }
  return '';
}

function extractDescription(raw) {
  const lines = (raw || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const normalizedLines = lines.map(normalizeText);
  for (let i = 0; i < normalizedLines.length; i++) {
    if (normalizedLines[i].includes('DESCRICAO')) {
      const candidates = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
        const nl = normalizedLines[j];
        if (nl.includes('QTD') || nl.includes('VALOR') || nl.includes('PESO') || nl.includes('TOTAL') || nl.includes('DECLARACAO') || nl.includes('REMETENTE') || nl.includes('DESTINATARIO')) continue;
        if (lines[j].length >= 4) candidates.push(lines[j]);
      }
      if (candidates.length) return cleanDescription(candidates.join(' '));
    }
  }
  const productHints = ['KIT', 'COMPRE', 'LEVE', 'SABORES', 'RASPADOR', 'FIO', 'HALITO', 'HÁLITO'];
  for (const line of lines) {
    const nl = normalizeText(line);
    if (productHints.some((h) => nl.includes(normalizeText(h))) && line.length > 4) return cleanDescription(line);
  }
  return '';
}

function looksLikeDeclaration(raw) {
  const t = normalizeText(raw);
  const score = ['DECLARACAO', 'CONTEUDO', 'DESCRICAO', 'REMETENTE', 'DESTINATARIO', 'SHIPFLOW'].filter((k) => t.includes(k)).length;
  return score >= 2 || t.includes('DESCRICAO') || t.includes('KIT') || t.includes('COMPRE');
}

async function initWorker() {
  if (worker) return worker;
  setStatus('Carregando leitor OCR...');
  if (!window.Tesseract || !window.Tesseract.createWorker) {
    throw new Error('Tesseract não carregou. Atualize a página com Ctrl+F5.');
  }
  worker = await window.Tesseract.createWorker('por');
  return worker;
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia indisponível');
    setStatus('Abrindo câmera ao vivo...');
    const constraintsList = [
      { video: { facingMode: { ideal: cameraMode }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: cameraMode }, audio: false },
      { video: true, audio: false }
    ];
    let lastErr = null;
    for (const constraints of constraintsList) {
      try { stream = await navigator.mediaDevices.getUserMedia(constraints); break; }
      catch (err) { lastErr = err; }
    }
    if (!stream) throw lastErr || new Error('Não abriu stream');
    video.setAttribute('playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    placeholder.style.display = 'none';
    cameraBtn.textContent = '⏹ Parar câmera';
    setStatus('Câmera ao vivo ligada. Aponte para a declaração.');
  } catch (err) {
    console.error(err);
    setStatus(explainCameraError(err));
  }
}

function stopCamera() {
  scanning = false;
  scanBtn.textContent = '▶ Ler automático';
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; }
  video.srcObject = null;
  placeholder.style.display = 'grid';
  cameraBtn.textContent = '📷 Abrir câmera';
  setStatus('Câmera parada.');
}

function addCount(description, tracking = '') {
  const desc = cleanDescription(description);
  if (!desc) return;
  if (tracking && seenTrackings.has(tracking)) { setStatus(`Rastreio ${tracking} já contado. Ignorado.`); return; }
  counts[desc] = (counts[desc] || 0) + 1;
  if (tracking) seenTrackings.add(tracking);
  saveState();
  render();
  setStatus(tracking ? `Contado: ${desc} | Rastreio ${tracking}` : `Contado: ${desc}`);
}

async function processCanvas(autoCount = false) {
  const ocr = await initWorker();
  setStatus('Lendo declaração...');
  const result = await ocr.recognize(canvas);
  const raw = result?.data?.text || '';
  rawTextEl.textContent = raw || 'Nenhum texto lido.';
  const isDecl = looksLikeDeclaration(raw);
  const description = extractDescription(raw);
  const tracking = extractTracking(raw);
  lastDescription = description;
  lastTracking = tracking;
  lastDescriptionEl.textContent = description || 'Nenhuma ainda';
  lastTrackingEl.textContent = tracking || 'Não encontrado';
  manualBtn.disabled = !description;
  undoBtn.disabled = !description;
  if (isDecl && description) {
    if (autoCount) addCount(description, tracking);
    else setStatus('Descrição encontrada. Clique em Somar manual ou use leitura automática.');
  } else {
    setStatus('Não consegui encontrar a descrição. Tente aproximar e melhorar a luz.');
  }
}

async function scanFrame() {
  if (!scanning || processing || !stream) return;
  processing = true;
  try {
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);
    await processCanvas(false);
    if (lastDescription) {
      const now = Date.now();
      const key = `${normalizeText(lastDescription)}|${lastTracking || ''}`;
      const lastKey = `${normalizeText(lastStable.description)}|${lastStable.tracking || ''}`;
      if (key === lastKey && now - lastStable.time > 1200) { addCount(lastDescription, lastTracking); lastStable = { description: '', tracking: '', time: now + 2500 }; }
      else if (key !== lastKey) { lastStable = { description: lastDescription, tracking: lastTracking, time: now }; setStatus('Descrição encontrada. Segure por 1 segundo...'); }
    }
  } catch (err) { console.error(err); setStatus('Erro na leitura. Tente aproximar ou melhorar a luz.'); }
  finally { processing = false; }
}

async function processImageFile(file) {
  if (!file) return;
  try {
    setStatus('Carregando imagem da declaração...');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      const maxW = 1400;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      await processCanvas(true);
    };
    img.onerror = () => setStatus('Não consegui abrir esta imagem.');
    img.src = url;
  } catch (err) { console.error(err); setStatus('Erro ao processar imagem.'); }
}

function render() {
  const rows = Object.entries(counts).map(([description, count]) => ({ description, count })).sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  totalCountEl.textContent = `${total} etiquetas contadas`;
  exportBtn.disabled = rows.length === 0;
  clearBtn.disabled = rows.length === 0;
  if (!rows.length) { tableEl.innerHTML = '<div class="empty">Nenhum produto contado ainda.</div>'; return; }
  tableEl.innerHTML = rows.map((row) => `<div class="row"><div><strong>${escapeHtml(row.description)}</strong><span>Descrição encontrada</span></div><b>${row.count}</b></div>`).join('');
}

function escapeHtml(text) { return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function downloadCsv() {
  const rows = Object.entries(counts).map(([description, count]) => [description, String(count)]);
  const csvRows = [['Descricao', 'Quantidade de etiquetas'], ...rows];
  const csv = csvRows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contagem-etiquetas-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

cameraBtn.addEventListener('click', () => { if (stream) stopCamera(); else startCamera(); });
fallbackBtn.addEventListener('click', () => fallbackInput.click());
fallbackInput.addEventListener('change', (event) => processImageFile(event.target.files?.[0]));
scanBtn.addEventListener('click', async () => {
  if (!stream) await startCamera();
  if (!stream) return;
  await initWorker();
  scanning = !scanning;
  scanBtn.textContent = scanning ? '⏸ Pausar leitura' : '▶ Ler automático';
  setStatus(scanning ? 'Leitura automática ligada.' : 'Leitura pausada.');
});
manualBtn.addEventListener('click', () => addCount(lastDescription, lastTracking));
undoBtn.addEventListener('click', () => {
  const desc = cleanDescription(lastDescription);
  if (!desc || !counts[desc]) return;
  if (counts[desc] > 1) counts[desc] -= 1; else delete counts[desc];
  if (lastTracking) seenTrackings.delete(lastTracking);
  saveState(); render(); setStatus('Última leitura removida.');
});
clearBtn.addEventListener('click', () => {
  if (!confirm('Limpar toda a contagem deste lote?')) return;
  counts = {}; seenTrackings = new Set(); saveState(); render(); setStatus('Lote limpo.');
});
exportBtn.addEventListener('click', downloadCsv);
setInterval(scanFrame, 900);
render();
