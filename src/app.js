const $ = (id) => document.getElementById(id);

const video = $('video');
const canvas = $('canvas');
const placeholder = $('placeholder');
const cameraBtn = $('cameraBtn');
const fallbackBtn = $('fallbackBtn');
const fallbackInput = $('fallbackInput');
const scanBtn = $('scanBtn');
const aiBtn = $('aiBtn');
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
const confidenceEl = $('confidence');
const rawTextEl = $('rawText');
const tableEl = $('table');
const totalCountEl = $('totalCount');

let stream = null;
let track = null;
let worker = null;
let scanning = false;
let processing = false;
let torchEnabled = false;
let digitalZoom = 1.35;
let nativeZoom = 1;
let nativeZoomLimits = null;
let lastDescription = '';
let lastTracking = '';
let lastConfidence = 0;
let stableReading = { key: '', since: 0 };
let lastCountedKey = '';
let lastCountedAt = 0;

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

function normalizeText(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[|]/g, ' I ')
    .replace(/[^A-Z0-9ÁÀÂÃÉÊÍÓÔÕÚÜÇa-záàâãéêíóôõúüç\s+\-/.,:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function cleanDescription(text) {
  let value = (text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;|\-]+/, '')
    .replace(/[\s:;|\-]+$/, '')
    .trim();

  value = value
    .replace(/H[AÁ]L[1I]TO/gi, 'HÁLITO')
    .replace(/RASPAD[0O]R/gi, 'RASPADOR')
    .replace(/SAB[0O]RES/gi, 'SABORES')
    .replace(/C[0O]MPRE/gi, 'COMPRE')
    .replace(/LEVE\s*Z/gi, 'LEVE 2')
    .replace(/\bFlO\b/gi, 'FIO')
    .replace(/\bKlT\b/gi, 'KIT')
    .trim();

  return value;
}

function similarity(a, b) {
  const aw = new Set(normalizeText(a).split(' ').filter((w) => w.length > 2));
  const bw = new Set(normalizeText(b).split(' ').filter((w) => w.length > 2));
  if (!aw.size || !bw.size) return 0;
  let common = 0;
  for (const word of aw) if (bw.has(word)) common += 1;
  return common / Math.max(aw.size, bw.size);
}

function findSimilarDescription(description) {
  const rows = Object.keys(counts);
  for (const existing of rows) {
    if (similarity(existing, description) >= 0.72) return existing;
  }
  return description;
}

function explainCameraError(error) {
  const name = error?.name || 'Erro';
  if (!window.isSecureContext) return 'Abra pelo link HTTPS da Vercel para liberar câmera.';
  if (!navigator.mediaDevices?.getUserMedia) return 'Este navegador não liberou câmera ao vivo. Use “📸 Usar câmera do celular”.';
  if (name === 'NotAllowedError') return 'Permissão negada. Libere a câmera no cadeado do navegador.';
  if (name === 'NotFoundError') return 'Nenhuma câmera encontrada.';
  if (name === 'NotReadableError') return 'A câmera está em uso por outro app. Feche outros apps e tente de novo.';
  return `Erro ao abrir câmera: ${name}`;
}

async function initWorker() {
  if (worker) return worker;
  setStatus('Carregando OCR grátis...');
  if (!window.Tesseract?.createWorker) throw new Error('Tesseract não carregou.');
  worker = await window.Tesseract.createWorker('por');
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÀÂÃÉÊÍÓÔÕÚÜÇáàâãéêíóôõúüç0123456789|+-/.,: '
    });
  } catch {}
  return worker;
}

async function startCamera() {
  try {
    setStatus('Abrindo câmera em alta qualidade...');
    const constraintsList = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }, audio: false },
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false },
      { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: true, audio: false }
    ];

    let lastError;
    for (const constraints of constraintsList) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!stream) throw lastError || new Error('Não abriu câmera');

    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    await video.play();

    placeholder.style.display = 'none';
    cameraBtn.textContent = '⏹ Parar câmera';

    await applyBestCameraSettings();

    scanning = true;
    scanBtn.textContent = '⏸ Pausar automático';
    await initWorker();

    const settings = track.getSettings?.() || {};
    setQuality(`Qualidade: ${settings.width || video.videoWidth}x${settings.height || video.videoHeight} | zoom ${digitalZoom.toFixed(1)}x | automático ligado`);
    setStatus('Automático ligado. Centralize a DESCRIÇÃO no quadrado.');
  } catch (error) {
    console.error(error);
    setStatus(explainCameraError(error));
  }
}

async function applyBestCameraSettings() {
  if (!track?.getCapabilities) return;
  const caps = track.getCapabilities();
  const advanced = [];

  if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
  if (caps.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
  if (caps.whiteBalanceMode?.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' });
  if (caps.zoom) {
    nativeZoomLimits = caps.zoom;
    nativeZoom = Math.min(caps.zoom.max || 1, Math.max(caps.zoom.min || 1, 1.25));
    advanced.push({ zoom: nativeZoom });
  }

  if (advanced.length) {
    try { await track.applyConstraints({ advanced }); } catch (error) { console.warn('Ajustes avançados indisponíveis', error); }
  }
}

function stopCamera() {
  scanning = false;
  processing = false;
  torchEnabled = false;
  scanBtn.textContent = '▶ Automático';
  if (stream) stream.getTracks().forEach((item) => item.stop());
  stream = null;
  track = null;
  video.srcObject = null;
  placeholder.style.display = 'grid';
  cameraBtn.textContent = '📷 Abrir câmera HD';
  setStatus('Câmera parada.');
  setQuality('Qualidade: aguardando câmera.');
}

function drawEnhancedFrame(fromVideo = true, image = null) {
  const sourceWidth = fromVideo ? video.videoWidth : image.width;
  const sourceHeight = fromVideo ? video.videoHeight : image.height;
  if (!sourceWidth || !sourceHeight) return false;

  const cropW = sourceWidth / digitalZoom;
  const cropH = sourceHeight / digitalZoom;
  const sx = (sourceWidth - cropW) / 2;
  const sy = (sourceHeight - cropH) / 2;

  const targetW = 1800;
  const targetH = Math.round(targetW * (cropH / cropW));
  canvas.width = targetW;
  canvas.height = targetH;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(fromVideo ? video : image, sx, sy, cropW, cropH, 0, 0, targetW, targetH);

  const img = ctx.getImageData(0, 0, targetW, targetH);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const contrast = Math.max(0, Math.min(255, (gray - 128) * 1.75 + 128));
    const bw = contrast > 154 ? 255 : 0;
    data[i] = bw;
    data[i + 1] = bw;
    data[i + 2] = bw;
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

function extractTracking(raw) {
  const joined = normalizeText(raw);
  const patterns = [
    /(?:RASTREIO|CODIGO|OBJETO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/i,
    /\b([A-Z]{2}\d{9}[A-Z]{2})\b/i,
    /\b([A-Z0-9]{10,18})\b/
  ];
  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return '';
}

function extractDescription(raw) {
  const lines = (raw || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const normalizedLines = lines.map(normalizeText);

  for (let i = 0; i < normalizedLines.length; i += 1) {
    const line = normalizedLines[i];
    if (!line.includes('DESCRICAO') && !line.includes('DESCRICA0') && !line.includes('DESCRIC')) continue;

    const candidates = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 9); j += 1) {
      const n = normalizedLines[j];
      if (n.includes('QTD') || n.includes('QUANT') || n.includes('VALOR') || n.includes('PESO') || n.includes('TOTAL') || n.includes('ASSINATURA')) continue;
      if (n.includes('REMETENTE') || n.includes('DESTINATARIO') || n.includes('DECLARACAO')) continue;
      if (lines[j].length >= 3) candidates.push(lines[j]);
    }
    if (candidates.length) return cleanDescription(candidates.join(' '));
  }

  const hints = ['KIT', 'COMPRE', 'LEVE', 'SABORES', 'RASPADOR', 'FIO', 'HALITO', 'HÁLITO', 'ESCOVA', 'CREME', 'BUCAL'];
  const found = lines.filter((line) => hints.some((hint) => normalizeText(line).includes(normalizeText(hint))));
  if (found.length) return cleanDescription(found.slice(0, 2).join(' '));
  return '';
}

function isDeclaration(raw) {
  const t = normalizeText(raw);
  const score = ['SHIPFLOW', 'DECLARACAO', 'CONTEUDO', 'REMETENTE', 'DESTINATARIO', 'DESCRICAO'].filter((key) => t.includes(key)).length;
  return score >= 2 || t.includes('DESCRIC') || t.includes('KIT') || t.includes('COMPRE');
}

function localAI(raw) {
  const corrected = (raw || '')
    .replace(/DESCR1CAO|DESCRICÂO|DESCRICA0/gi, 'DESCRIÇÃO')
    .replace(/QUANT1DADE|QUANTlDADE/gi, 'QUANTIDADE')
    .replace(/REMETFNTE/gi, 'REMETENTE')
    .replace(/DESTINATARlO/gi, 'DESTINATARIO');

  const description = extractDescription(corrected);
  const tracking = extractTracking(corrected);
  const declaration = isDeclaration(corrected);
  let confidence = 0;
  if (declaration) confidence += 35;
  if (description) confidence += 45;
  if (tracking) confidence += 10;
  if (normalizeText(corrected).includes('SHIPFLOW')) confidence += 10;
  confidence = Math.min(99, confidence);

  return {
    tipo: declaration ? 'declaracao_shipflow' : 'indefinido',
    descricao: description,
    rastreio: tracking,
    quantidade: 1,
    confianca: confidence,
    texto_corrigido: corrected
  };
}

function updateDetected(ai, raw) {
  lastDescription = ai.descricao || '';
  lastTracking = ai.rastreio || '';
  lastConfidence = ai.confianca || 0;
  lastDescriptionEl.textContent = lastDescription || 'Nenhuma ainda';
  lastTrackingEl.textContent = lastTracking || 'Não encontrado';
  if (confidenceEl) confidenceEl.textContent = lastConfidence ? `${lastConfidence}%` : '-';
  manualBtn.disabled = !lastDescription;
  undoBtn.disabled = !lastDescription;
  rawTextEl.textContent = JSON.stringify(ai, null, 2) + '\n\n--- OCR bruto ---\n' + (raw || '');
}

async function analyzeCurrentFrame(autoCount = false) {
  if (!drawEnhancedFrame(true)) return;
  const ocr = await initWorker();
  setStatus('Lendo e separando automaticamente...');
  const result = await ocr.recognize(canvas);
  const raw = result?.data?.text || '';
  const ai = localAI(raw);
  updateDetected(ai, raw);

  if (!ai.descricao) {
    setStatus('Ainda não achei a descrição. Aproxime, use luz ou toque em 🔎+ Mais zoom.');
    return;
  }

  if (autoCount && ai.confianca >= 70) {
    maybeAutoCount(ai.descricao, ai.rastreio, ai.confianca);
  } else {
    setStatus(`Separado pela IA local: ${ai.descricao} (${ai.confianca}%).`);
  }
}

function maybeAutoCount(description, tracking, confidence) {
  const key = `${normalizeText(description)}|${tracking || ''}`;
  const now = Date.now();

  if (tracking && seenTrackings.has(tracking)) {
    setStatus(`Rastreio ${tracking} já contado. Ignorado.`);
    return;
  }

  if (key !== stableReading.key) {
    stableReading = { key, since: now };
    setStatus(`Detectei: ${description}. Segure parado...`);
    return;
  }

  if (now - stableReading.since >= 900 && !(lastCountedKey === key && now - lastCountedAt < 4500)) {
    addCount(description, tracking);
    lastCountedKey = key;
    lastCountedAt = now;
    stableReading = { key: '', since: 0 };
    setStatus(`Contado automaticamente (${confidence}%): ${description}`);
  }
}

function addCount(description, tracking = '') {
  const desc = findSimilarDescription(cleanDescription(description));
  if (!desc) return;
  if (tracking && seenTrackings.has(tracking)) return;
  counts[desc] = (counts[desc] || 0) + 1;
  if (tracking) seenTrackings.add(tracking);
  saveState();
  render();
}

async function autoLoop() {
  if (!scanning || processing || !stream) return;
  processing = true;
  try { await analyzeCurrentFrame(true); }
  catch (error) { console.error(error); setStatus('Erro na leitura automática. Tente melhorar foco/luz.'); }
  finally { processing = false; }
}

async function processImageFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = async () => {
    try {
      setStatus('Separando imagem com IA local grátis...');
      drawEnhancedFrame(false, image);
      const ocr = await initWorker();
      const result = await ocr.recognize(canvas);
      const raw = result?.data?.text || '';
      const ai = localAI(raw);
      updateDetected(ai, raw);
      if (ai.descricao && ai.confianca >= 55) addCount(ai.descricao, ai.rastreio);
      setStatus(ai.descricao ? `Separado: ${ai.descricao}` : 'Não encontrei a descrição nesta imagem.');
    } finally {
      URL.revokeObjectURL(url);
      fallbackInput.value = '';
    }
  };
  image.onerror = () => { URL.revokeObjectURL(url); setStatus('Não consegui abrir a imagem.'); };
  image.src = url;
}

async function changeZoom(delta) {
  digitalZoom = Math.max(1, Math.min(3.5, digitalZoom + delta));
  if (track && nativeZoomLimits) {
    nativeZoom = Math.max(nativeZoomLimits.min || 1, Math.min(nativeZoomLimits.max || 1, nativeZoom + delta));
    try { await track.applyConstraints({ advanced: [{ zoom: nativeZoom }] }); } catch {}
  }
  setQuality(`Qualidade: zoom ${digitalZoom.toFixed(1)}x | automático ${scanning ? 'ligado' : 'pausado'}`);
}

async function improveFocus() {
  if (!track?.applyConstraints) return setStatus('Foco manual não disponível neste aparelho.');
  try {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }, { exposureMode: 'continuous' }, { whiteBalanceMode: 'continuous' }] });
    setStatus('Foco/exposição ajustados. Segure a declaração parada.');
  } catch {
    setStatus('Este navegador não liberou ajuste de foco.');
  }
}

async function toggleTorch() {
  if (!track?.getCapabilities) return setStatus('Luz não disponível neste navegador.');
  const caps = track.getCapabilities();
  if (!caps.torch) return setStatus('Este celular/navegador não liberou a lanterna.');
  torchEnabled = !torchEnabled;
  try {
    await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    setStatus(torchEnabled ? 'Luz ligada.' : 'Luz desligada.');
  } catch {
    setStatus('Não consegui controlar a luz neste aparelho.');
  }
}

function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function render() {
  const rows = Object.entries(counts).map(([description, count]) => ({ description, count })).sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  totalCountEl.textContent = `${total} etiquetas contadas`;
  exportBtn.disabled = rows.length === 0;
  clearBtn.disabled = rows.length === 0;
  if (!rows.length) { tableEl.innerHTML = '<div class="empty">Nenhum produto contado ainda.</div>'; return; }
  tableEl.innerHTML = rows.map((row) => `<div class="row"><div><strong>${escapeHtml(row.description)}</strong><span>Produto agrupado pela IA local</span></div><b>${row.count}</b></div>`).join('');
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

cameraBtn.addEventListener('click', () => stream ? stopCamera() : startCamera());
fallbackBtn.addEventListener('click', () => fallbackInput.click());
fallbackInput.addEventListener('change', (event) => processImageFile(event.target.files?.[0]));
scanBtn.addEventListener('click', async () => {
  if (!stream) await startCamera();
  else {
    scanning = !scanning;
    scanBtn.textContent = scanning ? '⏸ Pausar automático' : '▶ Automático';
    setStatus(scanning ? 'Automático ligado.' : 'Automático pausado.');
  }
});
aiBtn?.addEventListener('click', async () => {
  if (!stream) await startCamera();
  if (stream) await analyzeCurrentFrame(true);
});
zoomInBtn?.addEventListener('click', () => changeZoom(0.25));
zoomOutBtn?.addEventListener('click', () => changeZoom(-0.25));
focusBtn?.addEventListener('click', improveFocus);
torchBtn?.addEventListener('click', toggleTorch);
manualBtn.addEventListener('click', () => addCount(lastDescription, lastTracking));
undoBtn.addEventListener('click', () => {
  const desc = findSimilarDescription(lastDescription);
  if (!desc || !counts[desc]) return;
  if (counts[desc] > 1) counts[desc] -= 1; else delete counts[desc];
  if (lastTracking) seenTrackings.delete(lastTracking);
  saveState();
  render();
  setStatus('Última contagem removida.');
});
clearBtn.addEventListener('click', () => {
  if (!confirm('Limpar toda a contagem deste lote?')) return;
  counts = {};
  seenTrackings = new Set();
  saveState();
  render();
  setStatus('Lote limpo.');
});
exportBtn.addEventListener('click', downloadCsv);

setInterval(autoLoop, 1500);
render();
