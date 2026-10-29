import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

env.allowLocalModels = false;

const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), vid = $('vid'), overlay = $('overlay');
const goBtn = $('go'), bar = $('bar'), statusEl = $('status'), listEl = $('list');

let videoFile = null;
let captions = []; // {start, end, text}
let transcriber = null;
let transcriberModel = null;
let recording = false;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}
function setProgress(pct) { bar.value = Math.max(0, Math.min(100, pct)); }

function fmt(t, sep) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms).padStart(3, '0')}`;
}
const fmtSrt = (t) => fmt(t, ',');
const fmtVtt = (t) => fmt(t, '.');
const fmtShort = (t) => { const p2 = (n) => String(n).padStart(2, '0'); return `${p2(Math.floor(t / 60))}:${p2(Math.floor(t % 60))}`; };

// ---------- file picking ----------
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files.length) pickFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) pickFile(fileInput.files[0]); });

function pickFile(f) {
  videoFile = f;
  captions = [];
  renderList();
  updateExportButtons();
  vid.src = URL.createObjectURL(f);
  goBtn.disabled = false;
  setStatus(`Loaded: ${f.name} (${(f.size / 1048576).toFixed(1)} MB). Pick a model and hit Generate captions.`);
}

// ---------- audio extraction: decode and resample to 16kHz mono ----------
async function extractAudio(file) {
  const buf = await file.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await ac.decodeAudioData(buf);
  } finally {
    ac.close();
  }
  const targetRate = 16000;
  const nCh = decoded.numberOfChannels;
  const srcRate = decoded.sampleRate;
  const srcLen = decoded.length;
  const outLen = Math.floor(srcLen * targetRate / srcRate);
  const out = new Float32Array(outLen);
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(decoded.getChannelData(c));
  for (let i = 0; i < outLen; i++) {
    const pos = i * srcRate / targetRate;
    const i0 = Math.floor(pos), i1 = Math.min(i0 + 1, srcLen - 1), frac = pos - i0;
    let v = 0;
    for (let c = 0; c < nCh; c++) v += chans[c][i0] * (1 - frac) + chans[c][i1] * frac;
    out[i] = v / nCh;
  }
  return out;
}

// ---------- transcription ----------
goBtn.addEventListener('click', async () => {
  if (!videoFile || recording) return;
  goBtn.disabled = true;
  try {
    const modelId = $('model').value;
    if (!transcriber || transcriberModel !== modelId) {
      setStatus('Loading the speech model (one-time download, please wait)...');
      transcriber = await pipeline('automatic-speech-recognition', modelId, {
        quantized: true,
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            setProgress((p.loaded / p.total) * 100);
            setStatus(`Downloading model file ${p.file}: ${Math.round((p.loaded / p.total) * 100)}%`);
          } else if (p.status === 'ready') {
            setProgress(100);
          }
        },
      });
      transcriberModel = modelId;
    }
    setProgress(0);
    setStatus('Reading the audio track...');
    const audio = await extractAudio(videoFile);
    setStatus('Transcribing on your PC. Long videos take a while; keep this tab open...');
    const lang = $('lang').value;
    const opts = {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
    };
    if (lang) opts.language = lang;
    const result = await transcriber(audio, opts);
    const chunks = (result.chunks && result.chunks.length)
      ? result.chunks
      : [{ timestamp: [0, vid.duration || 0], text: result.text || '' }];
    captions = chunks
      .map((c) => ({
        start: c.timestamp[0] ?? 0,
        end: c.timestamp[1] ?? ((c.timestamp[0] ?? 0) + 3),
        text: (c.text || '').trim(),
      }))
      .filter((c) => c.text.length > 0);
    if (!captions.length) throw new Error('No speech was found in this file.');
    renderList();
    updateExportButtons();
    setProgress(100);
    setStatus(`Done. ${captions.length} captions created. Edit any text, then export.`);
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${err.message || err}. If the file is an unusual format, try an MP4 or WebM copy of it.`, true);
  } finally {
    goBtn.disabled = !videoFile;
  }
});

// ---------- caption list editor ----------
function renderList() {
  listEl.innerHTML = '';
  if (!captions.length) {
    listEl.innerHTML = '<p class="hint">No captions yet.</p>';
    return;
  }
  captions.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'cap';
    div.dataset.idx = i;
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = `${fmtShort(c.start)} → ${fmtShort(c.end)}`;
    const ta = document.createElement('textarea');
    ta.value = c.text;
    ta.addEventListener('input', () => { captions[i].text = ta.value; drawOverlay(); });
    ta.addEventListener('click', (e) => e.stopPropagation());
    div.appendChild(t);
    div.appendChild(ta);
    div.addEventListener('click', () => { vid.currentTime = c.start + 0.01; vid.play(); });
    listEl.appendChild(div);
  });
}

function activeCaption() {
  const t = vid.currentTime;
  return captions.find((c) => t >= c.start && t < c.end) || null;
}

function currentStyle() {
  return {
    size: parseInt($('fsize').value, 10),
    color: $('fcolor').value,
    box: $('fbox').checked,
    pos: $('fpos').value,
  };
}

function drawOverlay() {
  const c = activeCaption();
  const st = currentStyle();
  overlay.className = st.pos;
  overlay.style.fontSize = st.size + 'px';
  overlay.style.color = st.color;
  if (!c) { overlay.innerHTML = ''; markActiveRow(-1); return; }
  overlay.innerHTML = '';
  const span = document.createElement('span');
  if (st.box) span.className = 'box';
  span.textContent = c.text;
  overlay.appendChild(span);
  markActiveRow(captions.indexOf(c));
}
function markActiveRow(idx) {
  listEl.querySelectorAll('.cap').forEach((el) => {
    el.classList.toggle('active', parseInt(el.dataset.idx, 10) === idx);
  });
}
vid.addEventListener('timeupdate', drawOverlay);
['fsize', 'fcolor', 'fpos', 'fbox'].forEach((id) => $(id).addEventListener('input', drawOverlay));

// ---------- exports: SRT / VTT ----------
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function baseName() {
  return (videoFile ? videoFile.name.replace(/\.[^.]+$/, '') : 'captions');
}
$('dlSrt').addEventListener('click', () => {
  const body = captions.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(c.end)}\n${c.text}\n`).join('\n');
  download(`${baseName()}.srt`, new Blob([body], { type: 'text/plain' }));
});
$('dlVtt').addEventListener('click', () => {
  const body = 'WEBVTT\n\n' + captions.map((c) => `${fmtVtt(c.start)} --> ${fmtVtt(c.end)}\n${c.text}\n`).join('\n');
  download(`${baseName()}.vtt`, new Blob([body], { type: 'text/vtt' }));
});
function updateExportButtons() {
  const has = captions.length > 0;
  $('dlSrt').disabled = !has;
  $('dlVtt').disabled = !has;
  $('dlBurn').disabled = !has || recording;
}

// ---------- burned-in export: canvas record in real time ----------
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

$('dlBurn').addEventListener('click', async () => {
  if (!captions.length || recording) return;
  if (!vid.videoWidth) { setStatus('Load a video first (audio-only files have nothing to burn into).', true); return; }
  recording = true;
  updateExportButtons();
  goBtn.disabled = true;
  try {
    const scale = Math.min(1, 1280 / vid.videoWidth);
    const W = Math.round(vid.videoWidth * scale), H = Math.round(vid.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const canvasStream = canvas.captureStream(30);
    const tracks = [canvasStream.getVideoTracks()[0]];
    let audioNote = '';
    try {
      const vs = vid.captureStream ? vid.captureStream() : (vid.mozCaptureStream ? vid.mozCaptureStream() : null);
      const at = vs && vs.getAudioTracks()[0];
      if (at) tracks.push(at); else audioNote = ' (no audio track could be captured, video only)';
    } catch (e) { audioNote = ' (audio capture failed, video only)'; }
    const stream = new MediaStream(tracks);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('MediaRecorder is not supported in this browser. Use Chrome or Edge.');
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });

    const wasMuted = vid.muted;
    vid.pause();
    vid.currentTime = 0;
    await new Promise((res) => { vid.onseeked = res; });
    setStatus('Recording the captioned video in real time. Do not switch tabs...');
    rec.start(250);
    vid.play();
    const st = currentStyle();
    const fontPx = Math.max(16, Math.round(st.size * (W / (vid.clientWidth || W))));
    const draw = () => {
      if (!recording) return;
      ctx.drawImage(vid, 0, 0, W, H);
      const c = activeCaption();
      if (c) {
        ctx.font = `700 ${fontPx}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        const lines = wrapText(ctx, c.text, W * 0.88);
        const lh = fontPx * 1.25;
        const blockH = lines.length * lh;
        const yBase = st.pos === 'top' ? H * 0.05 : H - H * 0.07 - blockH;
        if (st.box) {
          const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          const bx = (W - widest) / 2 - 14, by = yBase - 6, bw = widest + 28, bh = blockH + 12;
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, bh, 8);
          ctx.fill();
        }
        ctx.fillStyle = st.color;
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 4;
        lines.forEach((l, i) => ctx.fillText(l, W / 2, yBase + (i + 1) * lh - (lh - fontPx) / 2));
        ctx.shadowBlur = 0;
      }
      if (!vid.ended) requestAnimationFrame(draw);
    };
    draw();
    await new Promise((res) => { vid.onended = res; });
    recording = false;
    rec.stop();
    await done;
    vid.muted = wasMuted;
    download(`${baseName()}-captioned.webm`, new Blob(parts, { type: 'video/webm' }));
    setStatus(`Burned-in video saved${audioNote}.`);
  } catch (err) {
    console.error(err);
    recording = false;
    setStatus(`Burn-in failed: ${err.message || err}`, true);
  } finally {
    updateExportButtons();
    goBtn.disabled = !videoFile;
  }
});
