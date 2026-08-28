const $ = (id) => document.getElementById(id);

const video = $('video');
const canvas = $('canvas');
const placeholder = $('placeholder');
const cameraBtn = $('cameraBtn');
const fallbackBtn = $('fallbackBtn');
const fallbackInput = $('fallbackInput');
const scanBtn = $('scanBtn');
const zoomInBtn = $('zoomInBtn');
const zoomOutBtn = $('zoomOutBtn');
const focusBtn = $('focusBtn');
const torchBtn = $('torchBtn');
const manualBtn = $('manualBtn');
const undoBtn = $('undoBtn');
const exportBtn = $('exportBtn');
const clearBtn = $('clearBtn');
const statusEl = $('status');
const qualityStatusEl = $('qualityStatus');
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
let digitalZoom = Number(localStorage.getItem('shipflow_zoom') || '1.8');
let torchOn = false;

let counts = loadJson('shipflow_counts', {});
let seenTrackings = new Set(loadJson('shipflow_seen_trackings', []));

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}
function saveState() {
  localStorage.setItem('shipflow_counts', JSON.stringify(counts));
  localStorage.setItem('shipflow_seen_trackings', JSON.stringify([...seenTrackings]));
}
function setStatus(text) { statusEl.textContent = text; }
function setQuality(text) { if (qualityStatusEl) qualityStatusEl.textContent = text; }
function normalizeText(text) { return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase(); }
function cleanDescription(text) { return (text || '').replace(/\s+/g, ' ').replace(/^[\s:;|\-]+/, '').replace(/[\s:;|\-]+$/, '').trim(); }

function explainCameraError(err) {
  const name = err?.name || 'Erro desconhecido';
  const message = err?.message || '';
  if (!window.isSecureContext) return 'A câmera ao vivo só funciona em HTTPS.';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'Este navegador bloqueou a câmera ao vivo. Use “📸 Usar câmera do celular”.';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Permissão negada. Libere a câmera no navegador.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Nenhuma câmera foi encontrada neste aparelho.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'A câmera está em uso por outro app. Feche outros apps e tente de novo.';
  return `Erro ao abrir câmera: ${name} ${message}`.trim();
}

function extractTracking(raw) {
  const joined = (raw || '').split(/\n+/).map((line) => line.trim()).filter(Boolean).join(' ');
  const patterns = [/(?:RASTREIO|C[OÓ]DIGO|OBJETO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/i, /\b([A-Z]{2}\d{9}[A-Z]{2})\b/i, /\b([A-Z0-9]{10,18})\b/];
  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (match && match[1]) return match[1].toUpperCase();
  }
  return '';
}

function extractDescription(raw) {
  const lines = (raw || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const normalizedLines = lines.map(normalizeText);

  for (let index = 0; index < normalizedLines.length; index += 1) {
    if (!normalizedLines[index].includes('DESCRICAO')) continue;
    const candidates = [];
    for (let next = index + 1; next < Math.min(lines.length, index + 8); next += 1) {
      const normalizedLine = normalizedLines[next];
      if (normalizedLine.includes('QTD') || normalizedLine.includes('VALOR') || normalizedLine.includes('PESO') || normalizedLine.includes('TOTAL') || normalizedLine.includes('DECLARACAO') || normalizedLine.includes('REMETENTE') || normalizedLine.includes('DESTINATARIO')) continue;
      if (lines[next].length >= 4) candidates.push(lines[next]);
    }
    if (candidates.length) return cleanDescription(candidates.join(' '));
  }

  const productHints = ['KIT', 'COMPRE', 'LEVE', 'SABORES', 'RASPADOR', 'FIO', 'HALITO', 'MINOX', 'GEL', 'SABONETE'];
  for (const line of lines) {
    const normalizedLine = normalizeText(line);
    if (productHints.some((hint) => normalizedLine.includes(normalizeText(hint))) && line.length > 4) return cleanDescription(line);
  }
  return '';
}

function looksLikeDeclaration(raw) {
  const normalized = normalizeText(raw);
  const score = ['DECLARACAO', 'CONTEUDO', 'DESCRICAO', 'REMETENTE', 'DESTINATARIO', 'SHIPFLOW'].filter((key) => normalized.includes(key)).length;
  return score >= 2 || normalized.includes('DESCRICAO') || normalized.includes('KIT') || normalized.includes('COMPRE');
}

async function initWorker() {
  if (worker) return worker;
  setStatus('Carregando leitor OCR...');
  if (!window.Tesseract || !window.Tesseract.createWorker) throw new Error('Tesseract não carregou.');
  worker = await window.Tesseract.createWorker('por');
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÀÂÃÉÈÊÍÌÓÒÔÕÚÙÇáàâãéèêíìóòôõúùç0123456789 |+-:/.,ºª'
    });
  } catch (_) {}
  return worker;
}

async function applyCameraOptimizations() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const settings = track.getSettings ? track.getSettings() : {};
  const advanced = [];

  if (caps.focusMode && caps.focusMode.includes('continuous')) advanced.push({ focusMode: 'continuous' });
  if (caps.exposureMode && caps.exposureMode.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
  if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' });
  if (caps.zoom) {
    const nativeZoom = Math.max(caps.zoom.min || 1, Math.min(caps.zoom.max || 1, digitalZoom));
    advanced.push({ zoom: nativeZoom });
  }
  if (advanced.length) {
    try { await track.applyConstraints({ advanced }); } catch (err) { console.warn('Otimização parcial da câmera não suportada', err); }
  }

  const info = [
    `Qualidade: ${settings.width || '?'}x${settings.height || '?'}`,
    `zoom ${digitalZoom.toFixed(1)}x`,
    caps.focusMode ? 'foco auto' : 'foco padrão',
    caps.torch ? 'luz disponível' : 'sem luz nativa'
  ].join(' • ');
  setQuality(info);
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia indisponível');
    setStatus('Abrindo câmera em alta qualidade...');
    const constraintsList = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }, audio: false },
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false },
      { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: true, audio: false }
    ];
    let lastError = null;
    for (const constraints of constraintsList) {
      try { stream = await navigator.mediaDevices.getUserMedia(constraints); break; }
      catch (error) { lastError = error; }
    }
    if (!stream) throw lastError || new Error('Não foi possível abrir a câmera.');

    video.setAttribute('playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    placeholder.style.display = 'none';
    cameraBtn.textContent = '⏹ Parar câmera';
    await applyCameraOptimizations();
    setStatus('Câmera HD ligada. Centralize somente a DESCRIÇÃO dentro do quadrado.');
  } catch (error) {
    console.error(error);
    setStatus(explainCameraError(error));
  }
}

function stopCamera() {
  scanning = false;
  processing = false;
  scanBtn.textContent = '▶ Ler automático';
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; }
  video.srcObject = null;
  placeholder.style.display = 'grid';
  cameraBtn.textContent = '📷 Abrir câmera HD';
  setStatus('Câmera parada.');
  setQuality('Qualidade: aguardando câmera.');
}

function drawOptimizedFrameFromVideo() {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const boxW = vw * 0.72 / digitalZoom;
  const boxH = vh * 0.46 / digitalZoom;
  const sx = Math.max(0, (vw - boxW) / 2);
  const sy = Math.max(0, (vh - boxH) / 2);
  const targetW = 1500;
  const targetH = Math.round(targetW * (boxH / boxW));
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, sx, sy, boxW, boxH, 0, 0, targetW, targetH);
  enhanceCanvas(ctx, targetW, targetH);
}

function drawOptimizedImage(image) {
  const targetW = 1600;
  const scale = targetW / image.width;
  canvas.width = targetW;
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  enhanceCanvas(ctx, canvas.width, canvas.height);
}

function enhanceCanvas(ctx, width, height) {
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const contrast = Math.max(0, Math.min(255, (gray - 115) * 1.85 + 145));
    const value = contrast > 168 ? 255 : contrast < 90 ? 0 : contrast;
    data[i] = value; data[i + 1] = value; data[i + 2] = value;
  }
  ctx.putImageData(img, 0, 0);
}

function addCount(description, tracking = '') {
  const normalizedDescription = cleanDescription(description);
  if (!normalizedDescription) return;
  if (tracking && seenTrackings.has(tracking)) { setStatus(`Rastreio ${tracking} já contado. Ignorado.`); return; }
  counts[normalizedDescription] = (counts[normalizedDescription] || 0) + 1;
  if (tracking) seenTrackings.add(tracking);
  saveState(); render();
  setStatus(tracking ? `Contado: ${normalizedDescription} | Rastreio ${tracking}` : `Contado: ${normalizedDescription}`);
}

function updateDetectedFields(description, tracking, raw) {
  lastDescription = description;
  lastTracking = tracking;
  lastDescriptionEl.textContent = description || 'Nenhuma ainda';
  lastTrackingEl.textContent = tracking || 'Não encontrado';
  rawTextEl.textContent = raw || 'Nenhum texto lido.';
  manualBtn.disabled = !description;
  undoBtn.disabled = !description;
}

async function processCanvas(autoCount = false) {
  const ocrWorker = await initWorker();
  setStatus('Lendo área da DESCRIÇÃO...');
  const result = await ocrWorker.recognize(canvas);
  const raw = result?.data?.text || '';
  const isDeclaration = looksLikeDeclaration(raw);
  const description = extractDescription(raw) || cleanDescription(raw.split('\n').find((l) => normalizeText(l).length > 4 && !normalizeText(l).includes('DESCRICAO')) || '');
  const tracking = extractTracking(raw);
  updateDetectedFields(description, tracking, raw);
  if ((isDeclaration || description) && description) {
    if (autoCount) addCount(description, tracking);
    else setStatus('Descrição encontrada. Clique em Somar manual ou mantenha parado para contar.');
  } else {
    setStatus('Não li a descrição. Use 🔎+ e deixe o texto maior/nítido no quadrado.');
  }
}

async function scanFrame() {
  if (!scanning || processing || !stream) return;
  processing = true;
  try {
    drawOptimizedFrameFromVideo();
    await processCanvas(false);
    if (lastDescription) {
      const now = Date.now();
      const currentKey = `${normalizeText(lastDescription)}|${lastTracking || ''}`;
      const previousKey = `${normalizeText(lastStable.description)}|${lastStable.tracking || ''}`;
      if (currentKey === previousKey && now - lastStable.time > 900) { addCount(lastDescription, lastTracking); lastStable = { description: '', tracking: '', time: now + 2300 }; }
      else if (currentKey !== previousKey) { lastStable = { description: lastDescription, tracking: lastTracking, time: now }; setStatus('Descrição encontrada. Segure parado por 1 segundo...'); }
    }
  } catch (error) { console.error(error); setStatus('Erro na leitura. Aproxime, use zoom ou mais luz.'); }
  finally { processing = false; }
}

async function processImageFile(file) {
  if (!file) return;
  try {
    setStatus('Carregando imagem da declaração...');
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = async () => {
      try { drawOptimizedImage(image); await processCanvas(true); }
      catch (error) { console.error(error); setStatus('Erro ao processar imagem.'); }
      finally { URL.revokeObjectURL(url); fallbackInput.value = ''; }
    };
    image.onerror = () => { URL.revokeObjectURL(url); fallbackInput.value = ''; setStatus('Não consegui abrir esta imagem.'); };
    image.src = url;
  } catch (error) { console.error(error); fallbackInput.value = ''; setStatus('Erro ao processar imagem.'); }
}

function escapeHtml(text) { return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function render() {
  const rows = Object.entries(counts).map(([description, count]) => ({ description, count })).sort((left, right) => right.count - left.count || left.description.localeCompare(right.description));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  totalCountEl.textContent = `${total} etiquetas contadas`;
  exportBtn.disabled = rows.length === 0;
  clearBtn.disabled = rows.length === 0;
  tableEl.innerHTML = rows.length ? rows.map((row) => `<div class="row"><div><strong>${escapeHtml(row.description)}</strong><span>Descrição encontrada</span></div><b>${row.count}</b></div>`).join('') : '<div class="empty">Nenhum produto contado ainda.</div>';
}

function downloadCsv() {
  const rows = Object.entries(counts).map(([description, count]) => [description, String(count)]);
  const csvRows = [['Descricao', 'Quantidade de etiquetas'], ...rows];
  const csv = csvRows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `contagem-etiquetas-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

cameraBtn.addEventListener('click', () => { if (stream) stopCamera(); else startCamera(); });
fallbackBtn.addEventListener('click', () => fallbackInput.click());
fallbackInput.addEventListener('change', (event) => processImageFile(event.target.files?.[0]));
zoomInBtn.addEventListener('click', async () => { digitalZoom = Math.min(4, digitalZoom + 0.3); localStorage.setItem('shipflow_zoom', String(digitalZoom)); await applyCameraOptimizations(); setStatus(`Zoom ajustado para ${digitalZoom.toFixed(1)}x.`); });
zoomOutBtn.addEventListener('click', async () => { digitalZoom = Math.max(1, digitalZoom - 0.3); localStorage.setItem('shipflow_zoom', String(digitalZoom)); await applyCameraOptimizations(); setStatus(`Zoom ajustado para ${digitalZoom.toFixed(1)}x.`); });
focusBtn.addEventListener('click', async () => { await applyCameraOptimizations(); setStatus('Foco/exposição ajustados. Toque na tela do celular se o navegador permitir foco manual.'); });
torchBtn.addEventListener('click', async () => {
  try {
    const track = stream?.getVideoTracks?.()[0];
    const caps = track?.getCapabilities?.() || {};
    if (!track || !caps.torch) { setStatus('Este navegador/celular não liberou a luz da câmera.'); return; }
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    setStatus(torchOn ? 'Luz ligada.' : 'Luz desligada.');
  } catch (err) { console.error(err); setStatus('Não consegui controlar a luz neste aparelho.'); }
});
scanBtn.addEventListener('click', async () => {
  if (!stream) await startCamera();
  if (!stream) return;
  await initWorker();
  scanning = !scanning;
  scanBtn.textContent = scanning ? '⏸ Pausar leitura' : '▶ Ler automático';
  setStatus(scanning ? 'Leitura automática ligada. Foque só na DESCRIÇÃO.' : 'Leitura pausada.');
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
setInterval(scanFrame, 800);
render();
