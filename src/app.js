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

let stream = null, worker = null, scanning = false, busy = false;
let lastDescription = '', lastTracking = '', lastStableKey = '', lastStableAt = 0;
let digitalZoom = Number(localStorage.getItem('shipflow_zoom') || '1.35');
let torchOn = false;
let counts = readJson('shipflow_counts', {});
let seenTrackings = new Set(readJson('shipflow_seen_trackings', []));

const FREE_AI_PRODUCTS = [
  'KIT BOM HÁLITO | 4 SABORES + RASPADOR + FIO',
  'COMPRE 1 LEVE 2'
];

function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } }
function saveState() { localStorage.setItem('shipflow_counts', JSON.stringify(counts)); localStorage.setItem('shipflow_seen_trackings', JSON.stringify([...seenTrackings])); localStorage.setItem('shipflow_zoom', String(digitalZoom)); }
function setStatus(text) { statusEl.textContent = text; }
function clean(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function normalize(text) { return clean(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[|]/g, ' | ').replace(/[^A-Z0-9+|\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function fixOcr(text) { return String(text || '').replace(/DECLARAC[AÃ]O/gi, 'DECLARACAO').replace(/DESCR[CÇ][AÃ]O/gi, 'DESCRICAO').replace(/RASTREI[O0]/gi, 'RASTREIO').replace(/H[ÁA]LIT[O0]/gi, 'HÁLITO').replace(/SAB[O0]RES/gi, 'SABORES').replace(/RASPAD[O0]R/gi, 'RASPADOR').replace(/C[O0]MPRE/gi, 'COMPRE').replace(/LEV[E3]/gi, 'LEVE'); }
function similarity(a, b) { a = normalize(a); b = normalize(b); if (!a || !b) return 0; const sa = new Set(a.split(' ').filter(Boolean)); const sb = new Set(b.split(' ').filter(Boolean)); const inter = [...sa].filter(x => sb.has(x)).length; return inter / (new Set([...sa, ...sb]).size || 1); }
function canonicalProduct(desc) { const known = [...FREE_AI_PRODUCTS, ...Object.keys(counts)]; let best = { value: clean(desc).toUpperCase(), score: 0 }; for (const item of known) { const score = similarity(desc, item); if (score > best.score) best = { value: item, score }; } return best.score >= 0.58 ? best.value : clean(desc).toUpperCase(); }
function explainCameraError(e) { const n = e?.name || 'erro'; if (!window.isSecureContext) return 'A câmera ao vivo só funciona em HTTPS.'; if (!navigator.mediaDevices?.getUserMedia) return 'Este navegador bloqueou câmera ao vivo. Use “Usar câmera do celular”.'; if (n === 'NotAllowedError') return 'Permissão negada. Libere a câmera no navegador.'; if (n === 'NotFoundError') return 'Nenhuma câmera encontrada.'; if (n === 'NotReadableError') return 'A câmera está em uso por outro app.'; return `Erro ao abrir câmera: ${n}`; }
function extractTracking(text) { const joined = fixOcr(text).split(/\n+/).map(clean).filter(Boolean).join(' '); const patterns = [/(?:RASTREIO|CODIGO|OBJETO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/i, /\b([A-Z]{2}\d{9}[A-Z]{2})\b/i]; for (const p of patterns) { const m = joined.match(p); if (m?.[1]) return m[1].toUpperCase(); } return ''; }
function extractDescriptionByRules(text) { const fixed = fixOcr(text); const lines = fixed.split(/\n+/).map(clean).filter(Boolean); const norm = lines.map(normalize); for (let i = 0; i < norm.length; i++) { if (!norm[i].includes('DESCRICAO')) continue; const out = []; for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) { const n = norm[j]; if (n.includes('QTD') || n.includes('VALOR') || n.includes('TOTAL') || n.includes('DECLARACAO') || n.includes('REMETENTE') || n.includes('DESTINATARIO')) continue; if (lines[j].length >= 4) out.push(lines[j]); } if (out.length) return out.join(' '); } const hints = ['KIT', 'COMPRE', 'LEVE', 'SABORES', 'RASPADOR', 'FIO', 'HALITO']; for (const line of lines) { const n = normalize(line); if (hints.some(h => n.includes(normalize(h))) && line.length > 4) return line; } return ''; }
function freeLocalAI(text) { const fixed = fixOcr(text); let desc = extractDescriptionByRules(fixed); const n = normalize(fixed); if (!desc) { if (n.includes('COMPRE') && n.includes('LEVE')) desc = 'COMPRE 1 LEVE 2'; else if (n.includes('KIT') && (n.includes('HALITO') || n.includes('SABORES') || n.includes('RASPADOR'))) desc = 'KIT BOM HÁLITO | 4 SABORES + RASPADOR + FIO'; } desc = desc ? canonicalProduct(desc) : ''; const tracking = extractTracking(fixed); const valid = ['DECLARACAO','CONTEUDO','DESCRICAO','REMETENTE','DESTINATARIO','SHIPFLOW'].filter(w => n.includes(w)).length; const prodScore = desc ? Math.max(...FREE_AI_PRODUCTS.map(p => similarity(desc, p)), 0.65) : 0; const confidence = Math.min(0.99, (valid / 6) * 0.45 + prodScore * 0.55); return { tipo: valid >= 2 || desc ? 'declaracao_shipflow' : 'desconhecido', rastreio: tracking, descricao: desc, quantidade: 1, confianca: confidence }; }
async function initWorker() { if (worker) return worker; if (!window.Tesseract?.createWorker) throw new Error('Tesseract não carregou.'); setStatus('Carregando IA grátis local...'); worker = await window.Tesseract.createWorker('por'); try { await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }); } catch {} return worker; }
async function startCamera() { try { if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia indisponível'); setStatus('Abrindo câmera em qualidade alta...'); const tries = [{ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }, audio: false }, { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }, { video: { facingMode: 'environment' }, audio: false }, { video: true, audio: false }]; let err; for (const c of tries) { try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { err = e; } } if (!stream) throw err; video.srcObject = stream; await video.play(); placeholder.style.display = 'none'; cameraBtn.textContent = '⏹ Parar câmera'; await applyCameraQuality(); setStatus('Câmera HD ligada. Use zoom e centralize a DESCRIÇÃO.'); } catch (e) { console.error(e); setStatus(explainCameraError(e)); } }
function stopCamera() { scanning = false; scanBtn.textContent = '▶ OCR automático'; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; placeholder.style.display = 'grid'; cameraBtn.textContent = '📷 Abrir câmera HD'; setStatus('Câmera parada.'); }
async function applyCameraQuality() { const track = stream?.getVideoTracks?.()[0]; if (!track?.applyConstraints) return; const caps = track.getCapabilities ? track.getCapabilities() : {}; const advanced = []; if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' }); if (caps.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' }); if (caps.whiteBalanceMode?.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' }); if (caps.zoom) advanced.push({ zoom: Math.min(caps.zoom.max, Math.max(caps.zoom.min, digitalZoom)) }); if (advanced.length) { try { await track.applyConstraints({ advanced }); } catch {} } qualityStatusEl.textContent = `Qualidade: ${video.videoWidth || '?'}x${video.videoHeight || '?'} | zoom ${digitalZoom.toFixed(1)}x`; }
async function toggleTorch() { const track = stream?.getVideoTracks?.()[0]; const caps = track?.getCapabilities ? track.getCapabilities() : {}; if (!caps.torch) return setStatus('Este celular/navegador não liberou a luz.'); torchOn = !torchOn; try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); setStatus(torchOn ? 'Luz ligada.' : 'Luz desligada.'); } catch { setStatus('Não consegui controlar a luz.'); } }
function enhanceCanvas() { const ctx = canvas.getContext('2d', { willReadFrequently: true }); const img = ctx.getImageData(0, 0, canvas.width, canvas.height); const d = img.data; for (let i = 0; i < d.length; i += 4) { let g = d[i] * .299 + d[i+1] * .587 + d[i+2] * .114; g = g > 150 ? 255 : g < 105 ? 0 : (g - 105) * 255 / 45; d[i] = d[i+1] = d[i+2] = g; } ctx.putImageData(img, 0, 0); }
function drawFrameToCanvasFromVideo() { const vw = video.videoWidth || 1280, vh = video.videoHeight || 720; const cropW = vw / digitalZoom, cropH = vh / digitalZoom; const sx = (vw - cropW) / 2, sy = (vh - cropH) / 2; canvas.width = 1600; canvas.height = Math.round(1600 * cropH / cropW); const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingEnabled = true; ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height); enhanceCanvas(); }
async function runOCRAndAI(autoCount = false) { const ocr = await initWorker(); setStatus('IA grátis separando pedido...'); const result = await ocr.recognize(canvas); const raw = result?.data?.text || ''; const parsed = freeLocalAI(raw); lastDescription = parsed.descricao || ''; lastTracking = parsed.rastreio || ''; lastDescriptionEl.textContent = lastDescription || 'Nenhuma ainda'; lastTrackingEl.textContent = lastTracking || 'Não encontrado'; confidenceEl.textContent = parsed.confianca ? `${Math.round(parsed.confianca * 100)}%` : '-'; rawTextEl.textContent = JSON.stringify({ ia_gratis_local: parsed, texto_ocr: raw }, null, 2); manualBtn.disabled = !lastDescription; undoBtn.disabled = !lastDescription; if (!lastDescription) return setStatus('Não achei a descrição. Aproxime mais ou use mais zoom.'); if (parsed.confianca < 0.55) return setStatus('Baixa confiança. Confira antes de somar.'); if (autoCount) addCount(lastDescription, lastTracking); else setStatus('Pedido separado pela IA grátis. Pode somar manualmente.'); }
async function scanFrame() { if (!scanning || busy || !stream) return; busy = true; try { drawFrameToCanvasFromVideo(); await runOCRAndAI(false); const key = `${normalize(lastDescription)}|${lastTracking}`; const now = Date.now(); if (lastDescription && key === lastStableKey && now - lastStableAt > 1100) { addCount(lastDescription, lastTracking); lastStableKey = ''; lastStableAt = now + 2500; } else if (key && key !== lastStableKey) { lastStableKey = key; lastStableAt = now; setStatus('Descrição encontrada. Segure por 1 segundo...'); } } catch (e) { console.error(e); setStatus('Erro na leitura. Tente mais luz/zoom.'); } finally { busy = false; } }
function addCount(description, tracking = '') { const desc = canonicalProduct(description); if (!desc) return; if (tracking && seenTrackings.has(tracking)) return setStatus(`Rastreio ${tracking} já contado. Ignorado.`); counts[desc] = (counts[desc] || 0) + 1; if (tracking) seenTrackings.add(tracking); saveState(); render(); setStatus(`Contado: ${desc}`); }
async function processImageFile(file) { if (!file) return; setStatus('Lendo imagem com IA grátis...'); const url = URL.createObjectURL(file); const img = new Image(); img.onload = async () => { try { const maxW = 1800; const scale = Math.min(1, maxW / img.width); canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale); canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height); enhanceCanvas(); await runOCRAndAI(true); } finally { URL.revokeObjectURL(url); fallbackInput.value = ''; } }; img.onerror = () => { URL.revokeObjectURL(url); setStatus('Não consegui abrir a imagem.'); }; img.src = url; }
function render() { const rows = Object.entries(counts).map(([description, count]) => ({ description, count })).sort((a,b) => b.count - a.count || a.description.localeCompare(b.description)); totalCountEl.textContent = `${rows.reduce((s,r)=>s+r.count,0)} etiquetas contadas`; exportBtn.disabled = rows.length === 0; clearBtn.disabled = rows.length === 0; tableEl.innerHTML = rows.length ? rows.map(r => `<div class="row"><div><strong>${escapeHtml(r.description)}</strong><span>Separado pela IA local grátis</span></div><b>${r.count}</b></div>`).join('') : '<div class="empty">Nenhum produto contado ainda.</div>'; }
function escapeHtml(text) { return String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function exportCsv() { const rows = [['Descricao','Quantidade de etiquetas'], ...Object.entries(counts).map(([d,c]) => [d, String(c)])]; const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n'); const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `contagem-etiquetas-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url); }

cameraBtn.onclick = () => stream ? stopCamera() : startCamera();
fallbackBtn.onclick = () => fallbackInput.click();
fallbackInput.onchange = (e) => processImageFile(e.target.files?.[0]);
scanBtn.onclick = async () => { if (!stream) await startCamera(); if (!stream) return; await initWorker(); scanning = !scanning; scanBtn.textContent = scanning ? '⏸ Pausar leitura' : '▶ OCR automático'; setStatus(scanning ? 'Leitura automática ligada.' : 'Leitura pausada.'); };
aiBtn.onclick = async () => { if (stream) drawFrameToCanvasFromVideo(); if (!stream && !canvas.width) return setStatus('Abra a câmera ou use “Usar câmera do celular”.'); await runOCRAndAI(false); };
zoomInBtn.onclick = async () => { digitalZoom = Math.min(5, digitalZoom + 0.25); saveState(); await applyCameraQuality(); setStatus(`Zoom ${digitalZoom.toFixed(1)}x`); };
zoomOutBtn.onclick = async () => { digitalZoom = Math.max(1, digitalZoom - 0.25); saveState(); await applyCameraQuality(); setStatus(`Zoom ${digitalZoom.toFixed(1)}x`); };
focusBtn.onclick = () => applyCameraQuality().then(() => setStatus('Foco/qualidade reforçados.'));
torchBtn.onclick = toggleTorch;
manualBtn.onclick = () => addCount(lastDescription, lastTracking);
undoBtn.onclick = () => { const d = canonicalProduct(lastDescription); if (!d || !counts[d]) return; counts[d] > 1 ? counts[d]-- : delete counts[d]; if (lastTracking) seenTrackings.delete(lastTracking); saveState(); render(); setStatus('Última leitura removida.'); };
clearBtn.onclick = () => { if (!confirm('Limpar toda a contagem deste lote?')) return; counts = {}; seenTrackings = new Set(); saveState(); render(); setStatus('Lote limpo.'); };
exportBtn.onclick = exportCsv;
setInterval(scanFrame, 1200);
render();