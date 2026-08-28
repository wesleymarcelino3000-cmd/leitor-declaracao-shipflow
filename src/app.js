const $ = (id) => document.getElementById(id);

const video = $('video');
const canvas = $('canvas');
const placeholder = $('placeholder');
const cameraBtn = $('cameraBtn');
const fallbackBtn = $('fallbackBtn');
const fallbackInput = $('fallbackInput');
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
let digitalZoom = 2.2;
let lastScanAt = 0;

let counts = loadJson('shipflow_counts', {});
let seenTrackings = new Set(loadJson('shipflow_seen_trackings', []));

const zoomBar = document.createElement('div');
zoomBar.className = 'actions';
zoomBar.innerHTML = `
  <button type="button" id="zoomMinus">🔎- Menos zoom</button>
  <button type="button" id="zoomPlus" class="primary">🔎+ Mais zoom</button>
`;
scanBtn.closest('.actions').insertAdjacentElement('afterend', zoomBar);
const zoomMinus = $('zoomMinus');
const zoomPlus = $('zoomPlus');

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
  if (!window.isSecureContext) return 'A câmera ao vivo só funciona em HTTPS. Abra o link final da Vercel.';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'Este navegador bloqueou a câmera ao vivo. Use o botão “📸 Usar câmera do celular”.';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Permissão negada. Libere a câmera no navegador.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Nenhuma câmera foi encontrada neste aparelho.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'A câmera está em uso por outro app. Feche outros apps e tente de novo.';
  return `Erro ao abrir câmera: ${name} ${message}`.trim();
}

function extractTracking(raw) {
  const lines = (raw || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const joined = lines.join(' ');
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

  const productHints = ['KIT', 'COMPRE', 'LEVE', 'SABORES', 'RASPADOR', 'FIO', 'HALITO', 'BOM', 'PREMIUM'];
  for (const line of lines) {
    const normalizedLine = normalizeText(line);
    if (productHints.some((hint) => normalizedLine.includes(hint)) && line.length > 4) return cleanDescription(line);
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
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1'
  });
  return worker;
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia indisponível');
    setStatus('Abrindo câmera ao vivo...');
    const constraintsList = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: 'continuous' }, audio: false },
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
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
    setStatus(`Câmera ligada. Use zoom ${digitalZoom.toFixed(1)}x e centralize a DESCRIÇÃO.`);
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
  cameraBtn.textContent = '📷 Abrir câmera';
  setStatus('Câmera parada.');
}

function addCount(description, tracking = '') {
  const normalizedDescription = cleanDescription(description);
  if (!normalizedDescription) return;
  if (tracking && seenTrackings.has(tracking)) { setStatus(`Rastreio ${tracking} já contado. Ignorado.`); return; }
  counts[normalizedDescription] = (counts[normalizedDescription] || 0) + 1;
  if (tracking) seenTrackings.add(tracking);
  saveState();
  render();
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

function drawFastReadingFrame(source, sourceWidth, sourceHeight, fromVideo = true) {
  // Pega o miolo da imagem e aplica zoom digital. Isso melhora muito para ler de longe.
  const cropW = sourceWidth / digitalZoom;
  const cropH = sourceHeight / digitalZoom;
  const sx = (sourceWidth - cropW) / 2;
  const sy = (sourceHeight - cropH) / 2;

  const outW = 1200;
  const outH = Math.round(outW * cropH / cropW);
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, sx, sy, cropW, cropH, 0, 0, outW, outH);

  // Pré-processamento: preto e branco forte para OCR rápido.
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const enhanced = gray < 150 ? 0 : 255;
    data[i] = enhanced;
    data[i + 1] = enhanced;
    data[i + 2] = enhanced;
  }
  ctx.putImageData(imageData, 0, 0);

  if (fromVideo) setStatus(`Lendo com zoom ${digitalZoom.toFixed(1)}x... centralize DESCRIÇÃO no quadrado.`);
}

async function processCanvas(autoCount = false) {
  const ocrWorker = await initWorker();
  setStatus('Lendo texto da declaração...');
  const result = await ocrWorker.recognize(canvas);
  const raw = result?.data?.text || '';
  const description = extractDescription(raw);
  const tracking = extractTracking(raw);
  updateDetectedFields(description, tracking, raw);
  if ((looksLikeDeclaration(raw) || description) && description) {
    if (autoCount) addCount(description, tracking);
    else setStatus('Descrição encontrada. Clique em Somar manual ou segure para contar automático.');
  } else {
    setStatus('Ainda não li. Aproxime um pouco ou use 🔎+ Mais zoom.');
  }
}

async function scanFrame() {
  if (!scanning || processing || !stream) return;
  const nowTime = Date.now();
  if (nowTime - lastScanAt < 1600) return;
  lastScanAt = nowTime;
  processing = true;
  try {
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    drawFastReadingFrame(video, width, height, true);
    await processCanvas(false);
    if (lastDescription) {
      const now = Date.now();
      const currentKey = `${normalizeText(lastDescription)}|${lastTracking || ''}`;
      const previousKey = `${normalizeText(lastStable.description)}|${lastStable.tracking || ''}`;
      if (currentKey === previousKey && now - lastStable.time > 900) {
        addCount(lastDescription, lastTracking);
        lastStable = { description: '', tracking: '', time: now + 2000 };
      } else if (currentKey !== previousKey) {
        lastStable = { description: lastDescription, tracking: lastTracking, time: now };
        setStatus('Descrição encontrada. Segure parado só mais um instante...');
      }
    }
  } catch (error) {
    console.error(error);
    setStatus('Erro na leitura. Aproxime ou melhore a luz.');
  } finally {
    processing = false;
  }
}

async function processImageFile(file) {
  if (!file) return;
  try {
    setStatus('Carregando imagem da declaração...');
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = async () => {
      try {
        drawFastReadingFrame(image, image.width, image.height, false);
        URL.revokeObjectURL(url);
        await processCanvas(true);
      } catch (error) {
        console.error(error);
        setStatus('Erro ao processar imagem.');
      } finally {
        fallbackInput.value = '';
      }
    };
    image.onerror = () => { URL.revokeObjectURL(url); fallbackInput.value = ''; setStatus('Não consegui abrir esta imagem.'); };
    image.src = url;
  } catch (error) {
    console.error(error);
    fallbackInput.value = '';
    setStatus('Erro ao processar imagem.');
  }
}

function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function render() {
  const rows = Object.entries(counts).map(([description, count]) => ({ description, count })).sort((left, right) => right.count - left.count || left.description.localeCompare(right.description));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  totalCountEl.textContent = `${total} etiquetas contadas`;
  exportBtn.disabled = rows.length === 0;
  clearBtn.disabled = rows.length === 0;
  if (!rows.length) { tableEl.innerHTML = '<div class="empty">Nenhum produto contado ainda.</div>'; return; }
  tableEl.innerHTML = rows.map((row) => `<div class="row"><div><strong>${escapeHtml(row.description)}</strong><span>Descrição encontrada</span></div><b>${row.count}</b></div>`).join('');
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
zoomPlus.addEventListener('click', () => { digitalZoom = Math.min(3.8, digitalZoom + 0.4); setStatus(`Zoom digital: ${digitalZoom.toFixed(1)}x. Centralize a DESCRIÇÃO.`); });
zoomMinus.addEventListener('click', () => { digitalZoom = Math.max(1.2, digitalZoom - 0.4); setStatus(`Zoom digital: ${digitalZoom.toFixed(1)}x.`); });
scanBtn.addEventListener('click', async () => {
  if (!stream) await startCamera();
  if (!stream) return;
  await initWorker();
  scanning = !scanning;
  scanBtn.textContent = scanning ? '⏸ Pausar leitura' : '▶ Ler automático';
  setStatus(scanning ? `Leitura rápida ligada. Zoom ${digitalZoom.toFixed(1)}x.` : 'Leitura pausada.');
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
setInterval(scanFrame, 350);
render();
setStatus('Pronto. Use 🔎+ se estiver lendo de longe.');
