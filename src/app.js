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
let cameraMode = 'environment';

let counts = loadJson('shipflow_counts', {});
let seenTrackings = new Set(loadJson('shipflow_seen_trackings', []));

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function saveState() {
  localStorage.setItem('shipflow_counts', JSON.stringify(counts));
  localStorage.setItem('shipflow_seen_trackings', JSON.stringify([...seenTrackings]));
}

function setStatus(text) {
  statusEl.textContent = text;
}

function normalizeText(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function cleanDescription(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;|\-]+/, '')
    .replace(/[\s:;|\-]+$/, '')
    .trim();
}

function explainCameraError(err) {
  const name = err?.name || 'Erro desconhecido';
  const message = err?.message || '';

  if (!window.isSecureContext) {
    return 'A câmera ao vivo só funciona em HTTPS. Abra o link final do Cloudflare.';
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'Este navegador bloqueou a câmera ao vivo. Use o botão "📸 Usar câmera do celular".';
  }

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Permissão negada. Libere a câmera no navegador ou use o botão "📸 Usar câmera do celular".';
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Nenhuma câmera foi encontrada neste aparelho. Use o envio por arquivo.';
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'A câmera está em uso por outro app. Feche outros apps e tente de novo.';
  }

  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'A câmera traseira não abriu. Vou tentar outro modo de câmera.';
  }

  return `Erro ao abrir câmera: ${name} ${message}`.trim();
}

function extractTracking(raw) {
  const lines = (raw || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join(' ');
  const patterns = [
    /(?:RASTREIO|C[OÓ]DIGO|OBJETO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/i,
    /\b([A-Z]{2}\d{9}[A-Z]{2})\b/i,
    /\b([A-Z0-9]{10,18})\b/,
  ];

  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (match && match[1]) {
      return match[1].toUpperCase();
    }
  }

  return '';
}

function extractDescription(raw) {
  const lines = (raw || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLines = lines.map(normalizeText);

  for (let index = 0; index < normalizedLines.length; index += 1) {
    if (!normalizedLines[index].includes('DESCRICAO')) {
      continue;
    }

    const candidates = [];
    for (let next = index + 1; next < Math.min(lines.length, index + 7); next += 1) {
      const normalizedLine = normalizedLines[next];
      if (
        normalizedLine.includes('QTD') ||
        normalizedLine.includes('VALOR') ||
        normalizedLine.includes('PESO') ||
        normalizedLine.includes('TOTAL') ||
        normalizedLine.includes('DECLARACAO') ||
        normalizedLine.includes('REMETENTE') ||
        normalizedLine.includes('DESTINATARIO')
      ) {
        continue;
      }

      if (lines[next].length >= 4) {
        candidates.push(lines[next]);
      }
    }

    if (candidates.length) {
      return cleanDescription(candidates.join(' '));
    }
  }

  const productHints = ['KIT', 'COMPRE', 'LEVE', 'SABORES', 'RASPADOR', 'FIO', 'HALITO'];
  for (const line of lines) {
    const normalizedLine = normalizeText(line);
    if (productHints.some((hint) => normalizedLine.includes(normalizeText(hint))) && line.length > 4) {
      return cleanDescription(line);
    }
  }

  return '';
}

function looksLikeDeclaration(raw) {
  const normalized = normalizeText(raw);
  const score = ['DECLARACAO', 'CONTEUDO', 'DESCRICAO', 'REMETENTE', 'DESTINATARIO', 'SHIPFLOW'].filter((key) =>
    normalized.includes(key),
  ).length;

  return score >= 2 || normalized.includes('DESCRICAO') || normalized.includes('KIT') || normalized.includes('COMPRE');
}

async function initWorker() {
  if (worker) {
    return worker;
  }

  setStatus('Carregando leitor OCR...');
  if (!window.Tesseract || !window.Tesseract.createWorker) {
    throw new Error('Tesseract não carregou pelo window.Tesseract.');
  }

  worker = await window.Tesseract.createWorker('por');
  return worker;
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia indisponível');
    }

    setStatus('Abrindo câmera ao vivo...');

    const constraintsList = [
      {
        video: {
          facingMode: { ideal: cameraMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      },
      {
        video: { facingMode: cameraMode },
        audio: false,
      },
      {
        video: true,
        audio: false,
      },
    ];

    let lastError = null;
    for (const constraints of constraintsList) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!stream) {
      throw lastError || new Error('Não foi possível abrir a câmera.');
    }

    video.setAttribute('playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.muted = true;
    video.srcObject = stream;
    await video.play();

    placeholder.style.display = 'none';
    cameraBtn.textContent = '⏹ Parar câmera';
    setStatus('Câmera ao vivo ligada. Aponte para a declaração.');
  } catch (error) {
    console.error(error);
    setStatus(explainCameraError(error));
  }
}

function stopCamera() {
  scanning = false;
  processing = false;
  scanBtn.textContent = '▶ Ler automático';

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  video.srcObject = null;
  placeholder.style.display = 'grid';
  cameraBtn.textContent = '📷 Abrir câmera';
  setStatus('Câmera parada.');
}

function addCount(description, tracking = '') {
  const normalizedDescription = cleanDescription(description);
  if (!normalizedDescription) {
    return;
  }

  if (tracking && seenTrackings.has(tracking)) {
    setStatus(`Rastreio ${tracking} já contado. Ignorado.`);
    return;
  }

  counts[normalizedDescription] = (counts[normalizedDescription] || 0) + 1;
  if (tracking) {
    seenTrackings.add(tracking);
  }

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

async function processCanvas(autoCount = false) {
  const ocrWorker = await initWorker();
  setStatus('Lendo declaração...');

  const result = await ocrWorker.recognize(canvas);
  const raw = result?.data?.text || '';
  const isDeclaration = looksLikeDeclaration(raw);
  const description = extractDescription(raw);
  const tracking = extractTracking(raw);

  updateDetectedFields(description, tracking, raw);

  if (isDeclaration && description) {
    if (autoCount) {
      addCount(description, tracking);
    } else {
      setStatus('Descrição encontrada. Clique em Somar manual ou use leitura automática.');
    }
  } else {
    setStatus('Não consegui encontrar a descrição. Tente aproximar e melhorar a luz.');
  }
}

async function scanFrame() {
  if (!scanning || processing || !stream) {
    return;
  }

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
      const currentKey = `${normalizeText(lastDescription)}|${lastTracking || ''}`;
      const previousKey = `${normalizeText(lastStable.description)}|${lastStable.tracking || ''}`;

      if (currentKey === previousKey && now - lastStable.time > 1200) {
        addCount(lastDescription, lastTracking);
        lastStable = { description: '', tracking: '', time: now + 2500 };
      } else if (currentKey !== previousKey) {
        lastStable = { description: lastDescription, tracking: lastTracking, time: now };
        setStatus('Descrição encontrada. Segure por 1 segundo...');
      }
    }
  } catch (error) {
    console.error(error);
    setStatus('Erro na leitura. Tente aproximar ou melhorar a luz.');
  } finally {
    processing = false;
  }
}

async function processImageFile(file) {
  if (!file) {
    return;
  }

  try {
    setStatus('Carregando imagem da declaração...');
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = async () => {
      try {
        const maxWidth = 1400;
        const scale = Math.min(1, maxWidth / image.width);
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        await processCanvas(true);
      } catch (error) {
        console.error(error);
        setStatus('Erro ao processar imagem.');
      } finally {
        URL.revokeObjectURL(url);
        fallbackInput.value = '';
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      fallbackInput.value = '';
      setStatus('Não consegui abrir esta imagem.');
    };

    image.src = url;
  } catch (error) {
    console.error(error);
    fallbackInput.value = '';
    setStatus('Erro ao processar imagem.');
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function render() {
  const rows = Object.entries(counts)
    .map(([description, count]) => ({ description, count }))
    .sort((left, right) => right.count - left.count || left.description.localeCompare(right.description));

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  totalCountEl.textContent = `${total} etiquetas contadas`;
  exportBtn.disabled = rows.length === 0;
  clearBtn.disabled = rows.length === 0;

  if (!rows.length) {
    tableEl.innerHTML = '<div class="empty">Nenhum produto contado ainda.</div>';
    return;
  }

  tableEl.innerHTML = rows
    .map(
      (row) =>
        `<div class="row"><div><strong>${escapeHtml(row.description)}</strong><span>Descrição encontrada</span></div><b>${row.count}</b></div>`,
    )
    .join('');
}

function downloadCsv() {
  const rows = Object.entries(counts).map(([description, count]) => [description, String(count)]);
  const csvRows = [['Descricao', 'Quantidade de etiquetas'], ...rows];
  const csv = csvRows
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';'))
    .join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `contagem-etiquetas-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

cameraBtn.addEventListener('click', () => {
  if (stream) {
    stopCamera();
  } else {
    startCamera();
  }
});

fallbackBtn.addEventListener('click', () => fallbackInput.click());
fallbackInput.addEventListener('change', (event) => processImageFile(event.target.files?.[0]));

scanBtn.addEventListener('click', async () => {
  if (!stream) {
    await startCamera();
  }

  if (!stream) {
    return;
  }

  await initWorker();
  scanning = !scanning;
  scanBtn.textContent = scanning ? '⏸ Pausar leitura' : '▶ Ler automático';
  setStatus(scanning ? 'Leitura automática ligada.' : 'Leitura pausada.');
});

manualBtn.addEventListener('click', () => addCount(lastDescription, lastTracking));

undoBtn.addEventListener('click', () => {
  const description = cleanDescription(lastDescription);
  if (!description || !counts[description]) {
    return;
  }

  if (counts[description] > 1) {
    counts[description] -= 1;
  } else {
    delete counts[description];
  }

  if (lastTracking) {
    seenTrackings.delete(lastTracking);
  }

  saveState();
  render();
  setStatus('Última leitura removida.');
});

clearBtn.addEventListener('click', () => {
  if (!confirm('Limpar toda a contagem deste lote?')) {
    return;
  }

  counts = {};
  seenTrackings = new Set();
  saveState();
  render();
  setStatus('Lote limpo.');
});

exportBtn.addEventListener('click', downloadCsv);

setInterval(scanFrame, 900);
render();
