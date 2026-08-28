import React, { useEffect, useRef, useState } from 'react';
import { Camera, Play, Square, Trash2, Download, Plus, RotateCcw } from 'lucide-react';
import { createWorker } from 'tesseract.js';
import './style.css';

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

function extractTracking(raw) {
  const lines = (raw || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const joined = lines.join(' ');
  const patterns = [
    /(?:RASTREIO|C[OÓ]DIGO|OBJETO|TRACKING)[:\s-]*([A-Z0-9]{8,25})/i,
    /\b([A-Z]{2}\d{9}[A-Z]{2})\b/i,
    /\b([A-Z0-9]{10,18})\b/
  ];

  for (const p of patterns) {
    const m = joined.match(p);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return '';
}

function extractDescription(raw) {
  const lines = (raw || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const normalizedLines = lines.map(normalizeText);

  for (let i = 0; i < normalizedLines.length; i++) {
    if (normalizedLines[i].includes('DESCRICAO')) {
      const candidates = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
        const nl = normalizedLines[j];
        if (
          nl.includes('QTD') ||
          nl.includes('VALOR') ||
          nl.includes('PESO') ||
          nl.includes('TOTAL') ||
          nl.includes('DECLARACAO') ||
          nl.includes('REMETENTE') ||
          nl.includes('DESTINATARIO')
        ) continue;

        if (lines[j].length >= 4) candidates.push(lines[j]);
      }
      if (candidates.length) return cleanDescription(candidates.join(' '));
    }
  }

  const productHints = ['KIT', 'COMPRE', 'LEVE', 'SABORES', 'RASPADOR', 'FIO', 'HALITO', 'HÁLITO'];
  for (const line of lines) {
    const nl = normalizeText(line);
    if (productHints.some(h => nl.includes(normalizeText(h))) && line.length > 4) {
      return cleanDescription(line);
    }
  }

  return '';
}

function looksLikeDeclaration(raw) {
  const t = normalizeText(raw);
  const score = ['DECLARACAO', 'CONTEUDO', 'DESCRICAO', 'REMETENTE', 'DESTINATARIO', 'SHIPFLOW']
    .filter(k => t.includes(k)).length;

  return score >= 2 || t.includes('DESCRICAO') || t.includes('KIT') || t.includes('COMPRE');
}

function downloadCsv(rows) {
  const header = ['Descricao', 'Quantidade de etiquetas'];
  const csvRows = [header, ...rows.map(r => [r.description, String(r.count)])];
  const csv = csvRows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contagem-etiquetas-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const workerRef = useRef(null);
  const processingRef = useRef(false);
  const lastStableRef = useRef({ description: '', tracking: '', time: 0 });

  const [cameraOn, setCameraOn] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState('Pronto para iniciar');
  const [lastText, setLastText] = useState('');
  const [lastDescription, setLastDescription] = useState('');
  const [lastTracking, setLastTracking] = useState('');

  const [counts, setCounts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('shipflow_counts') || '{}'); }
    catch { return {}; }
  });

  const [seenTrackings, setSeenTrackings] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('shipflow_seen_trackings') || '[]')); }
    catch { return new Set(); }
  });

  const rows = Object.entries(counts)
    .map(([description, count]) => ({ description, count }))
    .sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));

  useEffect(() => {
    localStorage.setItem('shipflow_counts', JSON.stringify(counts));
  }, [counts]);

  useEffect(() => {
    localStorage.setItem('shipflow_seen_trackings', JSON.stringify([...seenTrackings]));
  }, [seenTrackings]);

  useEffect(() => () => stopCamera(), []);

  async function initWorker() {
    if (workerRef.current) return workerRef.current;
    setStatus('Carregando leitor OCR...');
    const worker = await createWorker('por');
    workerRef.current = worker;
    return worker;
  }

  async function startCamera() {
    try {
      setStatus('Abrindo câmera...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
      setStatus('Câmera ligada. Aponte para a declaração.');
    } catch (err) {
      setStatus('Não foi possível abrir a câmera. Verifique permissão e HTTPS.');
      console.error(err);
    }
  }

  function stopCamera() {
    setScanning(false);
    setCameraOn(false);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }

  function addCount(description, tracking = '') {
    const desc = cleanDescription(description);
    if (!desc) return;

    if (tracking && seenTrackings.has(tracking)) {
      setStatus(`Rastreio ${tracking} já contado. Ignorado.`);
      return;
    }

    setCounts(prev => ({ ...prev, [desc]: (prev[desc] || 0) + 1 }));

    if (tracking) {
      setSeenTrackings(prev => new Set([...prev, tracking]));
      setStatus(`Contado: ${desc} | Rastreio ${tracking}`);
    } else {
      setStatus(`Contado: ${desc}`);
    }
  }

  async function scanFrame() {
    if (!scanning || processingRef.current || !videoRef.current || !canvasRef.current) return;
    processingRef.current = true;

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, width, height);

      const worker = await initWorker();
      setStatus('Lendo declaração...');
      const result = await worker.recognize(canvas);
      const raw = result?.data?.text || '';
      setLastText(raw);

      const isDecl = looksLikeDeclaration(raw);
      const description = extractDescription(raw);
      const tracking = extractTracking(raw);

      setLastDescription(description);
      setLastTracking(tracking);

      if (isDecl && description) {
        const now = Date.now();
        const key = `${normalizeText(description)}|${tracking || ''}`;
        const lastKey = `${normalizeText(lastStableRef.current.description)}|${lastStableRef.current.tracking || ''}`;

        if (key === lastKey && now - lastStableRef.current.time > 1200) {
          addCount(description, tracking);
          lastStableRef.current = { description: '', tracking: '', time: now + 2500 };
        } else if (key !== lastKey) {
          lastStableRef.current = { description, tracking, time: now };
          setStatus('Descrição encontrada. Segure por 1 segundo...');
        }
      } else {
        setStatus('Procurando descrição...');
      }
    } catch (err) {
      console.error(err);
      setStatus('Erro na leitura. Tente aproximar ou melhorar a luz.');
    } finally {
      processingRef.current = false;
    }
  }

  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(scanFrame, 900);
    return () => clearInterval(id);
  }, [scanning]);

  async function startScanning() {
    if (!cameraOn) await startCamera();
    await initWorker();
    setScanning(true);
    setStatus('Leitura automática ligada.');
  }

  function clearAll() {
    if (!confirm('Limpar toda a contagem deste lote?')) return;
    setCounts({});
    setSeenTrackings(new Set());
    setLastDescription('');
    setLastTracking('');
    setLastText('');
    setStatus('Lote limpo.');
  }

  function undoLast() {
    if (!lastDescription) return;
    const desc = cleanDescription(lastDescription);
    setCounts(prev => {
      const next = { ...prev };
      if (next[desc] > 1) next[desc] -= 1;
      else delete next[desc];
      return next;
    });
    if (lastTracking) {
      setSeenTrackings(prev => {
        const next = new Set(prev);
        next.delete(lastTracking);
        return next;
      });
    }
    setStatus('Última leitura removida.');
  }

  return (
    <main className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">ShipFlow</p>
          <h1>Leitor de Declaração</h1>
          <p className="subtitle">Passe a declaração na frente da câmera. O app lê a descrição e soma as etiquetas por produto.</p>
        </div>
        <div className="badge"><Camera size={20} /> Ao vivo</div>
      </header>

      <section className="grid">
        <div className="card camera-card">
          <div className="video-wrap">
            <video ref={videoRef} playsInline muted />
            {!cameraOn && <div className="placeholder">Câmera desligada</div>}
            <div className="scan-box" />
          </div>
          <canvas ref={canvasRef} hidden />

          <div className="actions">
            {!cameraOn ? (
              <button onClick={startCamera} className="primary"><Camera size={18} /> Abrir câmera</button>
            ) : (
              <button onClick={stopCamera}><Square size={18} /> Parar câmera</button>
            )}

            {!scanning ? (
              <button onClick={startScanning} className="primary"><Play size={18} /> Ler automático</button>
            ) : (
              <button onClick={() => setScanning(false)}><Square size={18} /> Pausar leitura</button>
            )}
          </div>

          <div className="status">{status}</div>

          <div className="detected">
            <strong>Última descrição:</strong>
            <span>{lastDescription || 'Nenhuma ainda'}</span>
            <strong>Rastreio:</strong>
            <span>{lastTracking || 'Não encontrado'}</span>
          </div>

          <div className="actions">
            <button onClick={() => addCount(lastDescription, lastTracking)} disabled={!lastDescription} className="primary">
              <Plus size={18} /> Somar manual
            </button>
            <button onClick={undoLast} disabled={!lastDescription}>
              <RotateCcw size={18} /> Desfazer último
            </button>
          </div>
        </div>

        <div className="card results-card">
          <div className="results-head">
            <div>
              <h2>Contagem do lote</h2>
              <p>{rows.reduce((sum, r) => sum + r.count, 0)} etiquetas contadas</p>
            </div>
            <div className="actions small">
              <button onClick={() => downloadCsv(rows)} disabled={!rows.length}><Download size={16} /> Exportar</button>
              <button onClick={clearAll} disabled={!rows.length}><Trash2 size={16} /> Limpar</button>
            </div>
          </div>

          <div className="table">
            {rows.length === 0 ? (
              <div className="empty">Nenhum produto contado ainda.</div>
            ) : (
              rows.map(row => (
                <div className="row" key={row.description}>
                  <div>
                    <strong>{row.description}</strong>
                    <span>Descrição encontrada</span>
                  </div>
                  <b>{row.count}</b>
                </div>
              ))
            )}
          </div>

          <details className="raw">
            <summary>Ver texto OCR bruto</summary>
            <pre>{lastText || 'Nenhuma leitura ainda.'}</pre>
          </details>
        </div>
      </section>
    </main>
  );
}
