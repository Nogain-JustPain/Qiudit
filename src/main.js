import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/600-italic.css';
import '@fontsource/montserrat/700.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import CFG, { MUSIC, WHISPER } from './config.js';
import { buildArgs, planSeq } from './ffgraph.js';
import { transcribeWords } from './whisper.js';
import { textUnits, analyze, autoCues, fallbackCues, alignToSrt, groupCues } from './align.js';

const $ = (id) => document.getElementById(id);
let ffmpeg = new FFmpeg();
let loaded = false;
const status = (t) => ($('status').textContent = t);
const progress = (v) => { $('bar').hidden = false; $('bar').value = v; };
const subFont = (size) => CFG.subtitle.font.replace('{size}', size);
const titleSize = (W) => Math.round((W * CFG.title.size) / 1080);
const subSize = (W) => Math.max(10, Math.round((W * (+$('subsize')?.value || CFG.subtitle.size)) / 1080));

// ---------- subtitle: SRT atau teks biasa ----------
const ts = (s) => {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
};
function parseSrt(t) {
  return t.replace(/\r/g, '').trim().split(/\n\n+/).map((b) => {
    const l = b.split('\n'); const i = l.findIndex((x) => x.includes('-->'));
    if (i < 0) return null;
    const [a, c] = l[i].split('-->');
    return { start: ts(a), end: ts(c), text: l.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim() };
  }).filter((c) => c && c.text);
}
// ---------- audio ----------
const mediaDuration = (file, tag) => new Promise((res, rej) => {
  const a = document.createElement(tag); a.preload = 'metadata';
  a.onloadedmetadata = () => res(a.duration);
  a.onerror = () => rej(new Error(tag === 'audio' ? 'Voice over tidak bisa dibaca' : `Video "${file.name}" tidak bisa dibaca browser. Pakai MP4 (H.264), HEVC dari sebagian HP perlu di-convert dulu.`));
  a.src = URL.createObjectURL(file);
});
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const isVideo = (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
// ---------- timing subtitle: otomatis dari jeda VO + editor geser manual ----------
const voCache = { key: '' };
async function decodeVo(file) {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  if (voCache.key === key) return voCache;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(await file.arrayBuffer()); ctx.close();
  Object.assign(voCache, { key, sr: buf.sampleRate, data: buf.getChannelData(0), duration: buf.duration });
  return voCache;
}
const wCache = { key: '', words: null };
let note = '';   // catatan yang ditampilkan setelah render selesai
async function whisperWords(vo) {
  const model = $('wmodel').value, key = `${fileSig(vo)}|${model}`;
  if (wCache.key === key) return wCache.words;
  status('Menyiapkan audio untuk Whisper...');
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  let buf; try { buf = await ctx.decodeAudioData(await vo.arrayBuffer()); } finally { ctx.close(); }
  const words = await transcribeWords(Float32Array.from(buf.getChannelData(0)), { model, language: WHISPER.language, onStatus: status });
  Object.assign(wCache, { key, words });
  return words;
}
let manual = null;   // hasil editor: { sig, cues }
const fileSig = (f) => (f ? `${f.name}|${f.size}|${f.lastModified}` : '');
const currentSig = () => [$('script').value, fileSig($('vo').files[0]), fileSig($('srt').files[0]), $('usetitle').value, $('titlesec').value, $('srtmode').value, $('timing').value].join('§');
async function getBaseCues(vo, srt, T, useTitle, titleSec, allowManual = true) {
  if (allowManual && manual && manual.sig === currentSig()) return manual.cues.map((c) => ({ ...c }));
  const units = textUnits($('script').value, useTitle, CFG.subtitle.maxCharsPerCue);
  if (srt) {
    const raw = parseSrt(await srt.text());
    if (units.length && $('srtmode').value === 'ref') {   // teks dari naskah, SRT hanya patokan waktu
      let pauses = [];
      try { const v = await decodeVo(vo); pauses = analyze(v.data, v.sr, 0.07).pauses; } catch { /* tanpa rekat ke jeda */ }
      const r = alignToSrt(units, raw, pauses);
      if (r.coverage >= 0.4) return groupCues(r.cues, CFG.subtitle.maxCharsPerCue);
      status(`SRT kurang cocok dengan naskah (${Math.round(r.coverage * 100)}% kata), memakai jeda napas VO.`);
    } else {
      if (useTitle && raw.length > 1) raw[0].isTitle = true;
      return raw;
    }
  }
  const max = CFG.subtitle.maxCharsPerCue;
  if ($('timing').value === 'whisper' && units.length) {
    try {
      const words = await whisperWords(vo);
      let pauses = [];
      try { const v = await decodeVo(vo); pauses = analyze(v.data, v.sr, 0.07).pauses; } catch { /* tanpa rekat ke jeda */ }
      const r = alignToSrt(units, words, pauses, true);
      if (r.coverage >= 0.4) return groupCues(r.cues, max);
      note = `Whisper kurang cocok dengan naskah (${Math.round(r.coverage * 100)}% kata), timing memakai jeda napas.`;
    } catch (e) { console.error('Whisper gagal', e); note = 'Whisper gagal (' + (e && e.message ? e.message : 'error') + '), timing memakai jeda napas.'; }
  }
  try { const v = await decodeVo(vo); return groupCues(autoCues(v.data, v.sr, units, titleSec).cues, max); }
  catch { return groupCues(fallbackCues(units, 0, T, titleSec), max); }
}
function refreshState() {
  if (manual && manual.sig !== currentSig()) manual = null;
  const srt = $('srt').files[0], hasScript = !!$('script').value.trim();
  $('tstate').textContent = manual ? `Timing diatur manual (${manual.cues.length} subtitle)`
    : srt ? (hasScript && $('srtmode').value === 'ref' ? 'Timing dari SRT, teks dari naskah' : 'Memakai SRT apa adanya') : $('timing').value === 'whisper' ? 'Timing otomatis dari pengenalan suara (Whisper)' : 'Timing otomatis dari jeda napas VO';
}
for (const id of ['script', 'usetitle', 'titlesec', 'vo', 'srt', 'srtmode', 'timing']) for (const ev of ['input', 'change']) $(id).addEventListener(ev, refreshState);

const ED = { cues: [], T: 0, env: null, dt: 0.02, pauses: [], pps: 70, cols: null, mx: 1, audio: null, drag: null, handles: [], raf: 0, stopAt: 0 };
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
function buildHandles() {   // satu garis untuk tiap batas; batas yang berimpit dipakai bersama
  const c = ED.cues, h = [];
  for (let i = 0; i <= c.length; i++) {
    const left = c[i - 1], right = c[i];
    if (left && right && Math.abs(left.end - right.start) < 0.06) h.push({ t: left.end, edges: [[i - 1, 'end'], [i, 'start']] });
    else { if (left) h.push({ t: left.end, edges: [[i - 1, 'end']] }); if (right) h.push({ t: right.start, edges: [[i, 'start']] }); }
  }
  ED.handles = h.sort((a, b) => a.t - b.t);
}
function layoutEditor() {
  const cv = $('twave'); ED.pps = +$('tzoom').value;
  cv.width = Math.ceil(ED.T * ED.pps); cv.height = 150; cv.style.width = cv.width + 'px'; cv.style.height = '150px';
  const per = 1 / ED.pps / ED.dt, cols = new Float32Array(cv.width); let mx = 0;
  for (let x = 0; x < cv.width; x++) {
    let m = 0; const a = Math.floor(x * per), b = Math.min(ED.env.length, Math.ceil((x + 1) * per));
    for (let i = a; i < b; i++) if (ED.env[i] > m) m = ED.env[i];
    cols[x] = m; if (m > mx) mx = m;
  }
  ED.cols = cols; ED.mx = mx || 1;
}
function drawEditor() {
  const cv = $('twave'), x = cv.getContext('2d'), H = cv.height;
  x.fillStyle = '#fffdf8'; x.fillRect(0, 0, cv.width, H);
  x.fillStyle = 'rgba(139,127,110,0.22)'; for (const p of ED.pauses) x.fillRect(p.start * ED.pps, 0, Math.max(1, p.dur * ED.pps), H);   // jeda napas
  const mid = H / 2 + 8, amp = H / 2 - 26; x.fillStyle = '#6b5f4e';
  for (let i = 0; i < ED.cols.length; i++) { const h = Math.max(1, (ED.cols[i] / ED.mx) * amp); x.fillRect(i, mid - h, 1, h * 2); }
  x.fillStyle = '#8b7f6e'; x.font = '600 12px Montserrat, sans-serif'; x.textAlign = 'center';
  ED.cues.forEach((c, i) => x.fillText(String(i + 1), ((c.start + c.end) / 2) * ED.pps, H - 6));
  for (const h of ED.handles) { const px = Math.round(h.t * ED.pps); x.fillStyle = '#d9472b'; x.fillRect(px - 1, 14, 2, H - 14); x.beginPath(); x.arc(px, 10, 6, 0, 7); x.fill(); }
  if (ED.audio) { const px = Math.round(ED.audio.currentTime * ED.pps); x.fillStyle = '#2b6cd9'; x.fillRect(px - 1, 0, 2, H); }
}
function renderList() {
  const box = $('tlist'); box.innerHTML = '';
  ED.cues.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'trow';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tp'; b.textContent = '\u25B6'; b.setAttribute('aria-label', `Putar subtitle ${i + 1}`);
    b.onclick = () => play(Math.max(0, ED.cues[i].start - 0.2), ED.cues[i].end + 0.15);
    const tm = document.createElement('span'); tm.className = 'tt';
    const inp = document.createElement('input'); inp.value = c.text; inp.oninput = () => { ED.cues[i].text = inp.value; };
    row.append(b, tm, inp); box.append(row);
  });
  updateTimes();
}
function updateTimes() { [...$('tlist').children].forEach((row, i) => { const c = ED.cues[i]; row.querySelector('.tt').textContent = `${fmt(c.start)} - ${fmt(c.end)}${c.isTitle ? ' (judul)' : ''}`; }); }
function markRow(t) { const i = ED.cues.findIndex((c) => t >= c.start && t < c.end); [...$('tlist').children].forEach((r, k) => r.classList.toggle('on', k === i)); }
function play(from, stopAt = 0) {
  const a = ED.audio; if (!a) return;
  if (from != null) a.currentTime = from;
  ED.stopAt = stopAt; a.play(); $('tplay').textContent = 'Jeda';
  cancelAnimationFrame(ED.raf);
  const step = () => {
    if (!ED.audio || ED.audio.paused) return;
    const t = ED.audio.currentTime;
    if (ED.stopAt && t >= ED.stopAt) return pause();
    drawEditor(); $('ttime').textContent = fmt(t); markRow(t);
    const wrap = $('twrap'), px = t * ED.pps;
    if (px < wrap.scrollLeft || px > wrap.scrollLeft + wrap.clientWidth - 40) wrap.scrollLeft = Math.max(0, px - wrap.clientWidth * 0.25);
    ED.raf = requestAnimationFrame(step);
  };
  ED.raf = requestAnimationFrame(step);
}
function pause() { if (ED.audio) ED.audio.pause(); cancelAnimationFrame(ED.raf); $('tplay').textContent = 'Putar'; if (ED.cols) drawEditor(); }
async function openEditor() {
  const vo = $('vo').files[0], srt = $('srt').files[0];
  if (!vo) return status('Pilih file voice over dulu, baru timing bisa diatur.');
  if (!srt && !$('script').value.trim()) return status('Isi teks naskah (atau pilih SRT) dulu.');
  $('tedit').disabled = true; status('Menganalisis suara...');
  try {
    const v = await decodeVo(vo), a = analyze(v.data, v.sr, 0.07);
    Object.assign(ED, { T: v.duration, env: a.env, dt: a.dt, pauses: a.pauses });
    ED.cues = (await getBaseCues(vo, srt, v.duration, $('usetitle').value === 'on', +$('titlesec').value || 0)).map((c) => ({ ...c }));
    ED.audio = new Audio(URL.createObjectURL(vo)); ED.audio.onended = pause;
    $('tdlg').showModal(); layoutEditor(); buildHandles(); renderList(); drawEditor(); $('ttime').textContent = fmt(0);
    if ($('status').textContent === 'Menganalisis suara...') status('');
  } catch (e) { status('Gagal membuka editor timing: ' + (e && e.message ? e.message : 'file audio tidak bisa dibaca')); }
  $('tedit').disabled = false;
}
const nearHandle = (px) => ED.handles.findIndex((h) => Math.abs(h.t * ED.pps - px) <= 8);
const pxOf = (ev) => ev.clientX - $('twave').getBoundingClientRect().left;
$('twave').addEventListener('pointerdown', (ev) => {
  const px = pxOf(ev), i = nearHandle(px);
  if (i >= 0) { ED.drag = i; $('twave').setPointerCapture(ev.pointerId); } else play(Math.max(0, px / ED.pps));
});
$('twave').addEventListener('pointermove', (ev) => {
  const px = pxOf(ev);
  if (ED.drag == null) { $('twave').style.cursor = nearHandle(px) >= 0 ? 'ew-resize' : 'pointer'; return; }
  const h = ED.handles[ED.drag], lo = (ED.handles[ED.drag - 1]?.t ?? 0) + 0.12, hi = (ED.handles[ED.drag + 1]?.t ?? ED.T) - 0.12;
  h.t = Math.min(hi, Math.max(lo, px / ED.pps));
  for (const [i, side] of h.edges) ED.cues[i][side] = h.t;
  drawEditor(); updateTimes();
});
$('twave').addEventListener('pointerup', () => { ED.drag = null; });
$('tedit').onclick = openEditor;
$('tplay').onclick = () => (ED.audio && !ED.audio.paused ? pause() : play(ED.audio.currentTime >= ED.T - 0.1 ? 0 : undefined));
$('tzoom').oninput = () => { layoutEditor(); drawEditor(); };
$('tdlg').addEventListener('close', () => { pause(); ED.audio = null; });
$('tdone').onclick = () => { manual = { sig: currentSig(), cues: ED.cues.map((c) => ({ ...c })) }; refreshState(); $('tdlg').close(); };
$('treset').onclick = async () => {
  ED.cues = (await getBaseCues($('vo').files[0], $('srt').files[0], ED.T, $('usetitle').value === 'on', +$('titlesec').value || 0, false)).map((c) => ({ ...c }));
  buildHandles(); renderList(); drawEditor();
};
refreshState();
export const _debug = { getBaseCues, ED, get manual() { return manual; } };

// ---------- gambar via canvas ----------
// Portrait: dipotong pas 9:16 (nanti di-zoom). Landscape: tinggi penuh, lebar utuh (nanti digeser dari sisi ke sisi).
async function photoToJpeg(file, W, H) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    try {
      bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
    } catch {
      throw new Error(`Foto "${file.name}" tidak bisa dibaca browser (format ${file.type || file.name.split('.').pop()}). Convert ke JPG/PNG dulu, HEIC dari iPhone tidak didukung.`);
    }
  }
  const bw = bmp.naturalWidth || bmp.width, bh = bmp.naturalHeight || bmp.height;
  const landscape = bw / bh >= 1.1;
  const cw = landscape ? Math.min(Math.round((H * bw) / bh / 2) * 2, W * 5) : W;
  const c = new OffscreenCanvas(cw, H); const x = c.getContext('2d');
  const k = Math.max(cw / bw, H / bh);
  x.drawImage(bmp, (cw - bw * k) / 2, (H - bh * k) / 2, bw * k, bh * k);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), landscape, width: cw };
}
// Kotak putih per baris, lebarnya mengikuti teks, teks hitam miring
async function cueToPng(text, W) {
  const S = CFG.subtitle, size = subSize(W);
  const padX = Math.round(size * 0.5), boxH = Math.round(size * 1.5), gap = Math.round(size * 0.1);
  const probe = new OffscreenCanvas(10, 10).getContext('2d'); probe.font = subFont(size);
  const limit = W * 0.86 - padX * 2, lines = []; let cur = '';
  for (const w of text.split(' ')) {
    const tryLine = cur ? cur + ' ' + w : w;
    if (probe.measureText(tryLine).width > limit && cur) { lines.push(cur); cur = w; } else cur = tryLine;
  }
  lines.push(cur);
  const H = lines.length * boxH + (lines.length - 1) * gap;
  const c = new OffscreenCanvas(W, H); const x = c.getContext('2d');
  x.font = subFont(size); x.textAlign = 'center'; x.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const bw = Math.ceil(x.measureText(l).width + padX * 2), y = i * (boxH + gap);
    x.fillStyle = S.box; x.beginPath(); x.roundRect((W - bw) / 2, y, bw, boxH, size * 0.22); x.fill();
    x.fillStyle = S.color; x.fillText(l, W / 2, y + boxH / 2 + size * 0.04);
  });
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
// Judul: kotak merah Bali Express, teks putih tebal, rata kiri
async function titleToPng(text, W) {
  const S = CFG.title, size = titleSize(W), font = `700 ${size}px Montserrat`;
  const padX = Math.round(size * 0.6), padY = Math.round(size * 0.5), lh = Math.round(size * 1.25), x0 = Math.round(W * 0.06);
  const probe = new OffscreenCanvas(10, 10).getContext('2d'); probe.font = font;
  const limit = W * 0.88 - padX * 2, lines = []; let cur = '';
  for (const w of text.split(' ')) {
    const tryLine = cur ? cur + ' ' + w : w;
    if (probe.measureText(tryLine).width > limit && cur) { lines.push(cur); cur = w; } else cur = tryLine;
  }
  lines.push(cur);
  const boxW = Math.ceil(Math.max(...lines.map((l) => probe.measureText(l).width)) + padX * 2), boxH = lines.length * lh + padY * 2;
  const c = new OffscreenCanvas(W, boxH); const x = c.getContext('2d');
  x.fillStyle = S.box; x.beginPath(); x.roundRect(x0, 0, boxW, boxH, size * 0.2); x.fill();
  x.font = font; x.fillStyle = S.color; x.textAlign = 'left'; x.textBaseline = 'middle';
  lines.forEach((l, i) => x.fillText(l, x0 + padX, padY + lh * i + lh / 2 + size * 0.04));
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
export { cueToPng, titleToPng };

// ---------- muat ffmpeg: unduh dengan indikator, deteksi macet, cadangan CDN ----------
async function downloadBlobURL(url, type, label) {
  const ctl = new AbortController(); let timer;
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 15000); };
  kick();
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`${label}: server membalas HTTP ${res.status}`);
    if ((res.headers.get('content-type') || '').includes('text/html')) throw new Error(`${label}: file tidak ada (server membalas halaman HTML)`);
    const total = +res.headers.get('content-length') || 0, rd = res.body.getReader(), chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      chunks.push(value); got += value.length; kick();
      status(`Mengunduh ${label}... ${(got / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`);
    }
    return URL.createObjectURL(new Blob(chunks, { type }));
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`${label}: unduhan macet (tidak ada data selama 15 detik)`);
    throw e;
  } finally { clearTimeout(timer); }
}
// CDN dulu (cepat, di-cache dekat pengguna); file milik situs sendiri jadi cadangan
const FF_SOURCES = ['https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm', '/ffmpeg'];
async function loadFfmpeg() {
  const errors = [];
  for (const base of FF_SOURCES) {
    const f = new FFmpeg();
    f.on('log', ({ message }) => console.log('[ffmpeg]', message));
    f.on('progress', ({ progress: p }) => progress(Math.min(0.99, 0.2 + p * 0.8)));
    try {
      const coreURL = await downloadBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript', 'ffmpeg-core.js');
      const wasmURL = await downloadBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm', 'ffmpeg-core.wasm');
      status('Menyalakan ffmpeg...');
      await withTimeout(f.load({ coreURL, wasmURL }), 60000, 'ffmpeg tidak merespons setelah diunduh');
      ffmpeg = f; loaded = true; return;
    } catch (e) {
      console.error('load ffmpeg gagal dari', base, e);
      errors.push(`${base.startsWith('/') ? 'situs ini' : 'CDN'}: ${e.message}`);
      try { f.terminate(); } catch { /* abaikan */ }
      if (base === FF_SOURCES[0]) status('CDN gagal, mencoba file dari situs ini...');
    }
  }
  throw new Error('ffmpeg gagal dimuat. ' + errors.join(' | '));
}

// ---------- render ----------
async function render() {
  const files = [...$('photos').files], vo = $('vo').files[0], srt = $('srt').files[0];
  if (!files.length) return status('Upload minimal satu foto atau video.');
  if (!vo) return status('Upload file voice over.');
  const put = async (name, data) => ffmpeg.writeFile(name, data instanceof Blob ? await fetchFile(data) : data);
  const MB = files.reduce((a, f) => a + f.size, 0) / 1048576;
  if (MB > 500) throw new Error(`Total bahan ${Math.round(MB)} MB, terlalu besar untuk render di browser. Kompres video ke 720p atau kurangi jumlah klip (batas sekitar 500 MB).`);
  const W = $('res').value === '1080' ? 1080 : 720, H = Math.round((W * 16) / 9);
  const F = CFG.fadeSeconds, D = Math.max(+$('dur').value || CFG.photoSeconds, F + 0.5);
  const shift = +$('shift').value || 0, motion = $('motion').value === 'on', fit = $('fit').value;
  const useTitle = $('usetitle').value === 'on', titleSec = +$('titlesec').value || 0;

  if (!loaded) await loadFfmpeg();
  progress(0.02); status('Menyiapkan bahan...');
  status('Membaca voice over...');
  let T;
  try { T = (await withTimeout(decodeVo(vo), 30000, 'timeout')).duration; }   // decode WAV langsung, lebih tahan banting daripada elemen <audio>
  catch { T = await withTimeout(mediaDuration(vo, 'audio'), 15000, 'Voice over tidak bisa dibaca browser (timeout). Coba convert ke MP3 atau WAV PCM 16-bit.'); }
  if (!isFinite(T) || T <= 0) throw new Error('Durasi voice over tidak terbaca. Coba convert ke MP3 atau WAV PCM 16-bit.');
  status('Memuat font...');
  try {
    await withTimeout(Promise.all([document.fonts.load(subFont(subSize(W))), document.fonts.load(`700 ${titleSize(W)}px Montserrat`)]), 8000, 'font');
  } catch { /* lanjut dengan font bawaan */ }

  const items = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    status(`Memproses bahan ${i + 1} dari ${files.length}...`);
    if (isVideo(f)) {
      const dur = Math.max(1, (await mediaDuration(f, 'video')) - 0.05);
      const name = `v${i}.${(f.name.split('.').pop() || 'mp4').toLowerCase()}`;
      await put(name, f);
      items.push({ kind: 'video', file: name, dur });
    } else {
      const r = await photoToJpeg(f, W, H);
      await put(`p${i}.jpg`, r.bytes);
      // foto landscape: durasi menyesuaikan lebar supaya geser penuh tidak terlalu cepat
      let dur = D;
      if (motion && r.landscape) dur = Math.min(CFG.panMaxSeconds, Math.max(D, (r.width - W) / (CFG.panSpeedPct * W)));
      items.push({ kind: 'photo', file: `p${i}.jpg`, dur, landscape: r.landscape });
    }
  }

  const ext = (vo.name.split('.').pop() || 'mp3').toLowerCase();
  status('Menyalin voice over dan logo...');
  await put(`vo.${ext}`, vo);
  const logoRes = await fetch(CFG.logo.src);
  if (!logoRes.ok) throw new Error('logo.png tidak ditemukan di folder public/.');
  await put('logo.png', await logoRes.blob());
  const bgm = $('bgm').files[0];
  const bgmExt = bgm ? (bgm.name.split('.').pop() || 'mp3').toLowerCase() : null;
  if (bgm) await put(`bgm.${bgmExt}`, bgm);

  status('Menyiapkan teks...'); note = '';
  let cues = await getBaseCues(vo, srt, T, useTitle, titleSec);
  cues = cues.map((c) => ({ ...c, start: Math.max(0, c.start + shift), end: Math.min(T, c.end + shift) })).filter((c) => c.end > c.start);
  const tc = cues[0];
  let titleEnd = 0;
  if (tc?.isTitle) { tc.start = 0; if (tc.end > 1.2 && tc.end < T - 2) titleEnd = tc.end; else tc.isTitle = false; }
  for (let i = 0; i < cues.length; i++) await put(`s${i}.png`, await (cues[i].isTitle ? titleToPng : cueToPng)(cues[i].text, W));
  progress(0.1);

  const useFlash = titleEnd > 0 && $('titlefx').value === 'flash';
  const tr = useFlash ? { name: 'fade', seconds: CFG.flash.cutSeconds } : CFG.titleTransition;
  const flash = useFlash ? { at: titleEnd, attack: CFG.flash.attack, decay: CFG.flash.decay } : null;
  const seq = planSeq(items, { T, F, titleEnd, titleTr: tr.seconds, titleTrName: tr.name });
  const common = { W, H, fps: CFG.fps, seq, cues, ext, T, logo: CFG.logo, subBottomPct: CFG.subtitle.bottomPct, titleBottomPct: CFG.title.bottomPct,
    zoom: CFG.zoomAmount, motion, fit, flash,
    bgmExt, bgmVol: Math.min(1, Math.max(0, (+$('bgmvol').value || 0) / 100)), bgmFade: MUSIC.fadeOutSeconds };

  status('Merender di browser... (tab jangan ditutup)');
  const code = await ffmpeg.exec(buildArgs(common));
  if (code !== 0) throw new Error('ffmpeg gagal (kode ' + code + '). Coba resolusi 720, kurangi jumlah klip, atau pakai video MP4 yang lebih kecil.');
  const data = await ffmpeg.readFile('out.mp4');
  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  for (const name of (await ffmpeg.listDir('.')).map((e) => e.name))
    if (/^(p|s|v)\d+\./.test(name) || /^(vo|bgm|logo)\./.test(name) || name === 'out.mp4') await ffmpeg.deleteFile(name);

  const url = URL.createObjectURL(blob);
  $('out').innerHTML = `<video src="${url}" controls playsinline></video>`;
  $('dl').innerHTML = `<a href="${url}" download="bali-express-video.mp4">Download MP4</a>`;
  progress(1); status('Selesai.' + (note ? ' ' + note : ''));
}

// nama file terpilih
for (const id of ['photos', 'vo', 'srt', 'bgm']) $(id).onchange = () => {
  const f = [...$(id).files], v = f.filter(isVideo).length;
  $(id + 'Name').textContent = !f.length ? 'Belum ada file' : id === 'photos' ? `${f.length - v} foto, ${v} video` : f[0].name;
};
$('go').onclick = async () => {
  $('go').disabled = true; $('out').innerHTML = ''; $('dl').innerHTML = '';
  try { await render(); } catch (e) { console.error(e); status('Gagal: ' + (e && e.message ? e.message : String(e) || 'error tidak diketahui, buka Console (F12)')); }
  $('go').disabled = false;
};

// jendela pengaturan
const dlg = $('dlg');
$('cfg').onclick = () => dlg.showModal();
$('dlgClose').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
