import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/600-italic.css';
import '@fontsource/montserrat/700.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import CFG, { MUSIC } from './config.js';
import { buildArgs, planSeq } from './ffgraph.js';
import { textUnits, analyze, autoCues, fallbackCues, alignToSrt } from './align.js';

const $ = (id) => document.getElementById(id);
const ffmpeg = new FFmpeg();
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
let manual = null;   // hasil editor: { sig, cues }
const fileSig = (f) => (f ? `${f.name}|${f.size}|${f.lastModified}` : '');
const currentSig = () => [$('script').value, fileSig($('vo').files[0]), fileSig($('srt').files[0]), $('usetitle').value, $('titlesec').value, $('srtmode').value].join('§');
async function getBaseCues(vo, srt, T, useTitle, titleSec, allowManual = true) {
  if (allowManual && manual && manual.sig === currentSig()) return manual.cues.map((c) => ({ ...c }));
  const units = textUnits($('script').value, useTitle, CFG.subtitle.maxCharsPerCue);
  if (srt) {
    const raw = parseSrt(await srt.text());
    if (units.length && $('srtmode').value === 'ref') {   // teks dari naskah, SRT hanya patokan waktu
      let pauses = [];
      try { const v = await decodeVo(vo); pauses = analyze(v.data, v.sr, 0.07).pauses; } catch { /* tanpa rekat ke jeda */ }
      const r = alignToSrt(units, raw, pauses);
      if (r.coverage >= 0.4) return r.cues;
      status(`SRT kurang cocok dengan naskah (${Math.round(r.coverage * 100)}% kata), memakai jeda napas VO.`);
    } else {
      if (useTitle && raw.length > 1) raw[0].isTitle = true;
      return raw;
    }
  }
  try { const v = await decodeVo(vo); return autoCues(v.data, v.sr, units, titleSec).cues; }
  catch { return fallbackCues(units, 0, T, titleSec); }
}
function refreshState() {
  if (manual && manual.sig !== currentSig()) manual = null;
  const srt = $('srt').files[0], hasScript = !!$('script').value.trim();
  $('tstate').textContent = manual ? `Timing diatur manual (${manual.cues.length} subtitle)`
    : srt ? (hasScript && $('srtmode').value === 'ref' ? 'Timing dari SRT, teks dari naskah' : 'Memakai SRT apa adanya') : 'Timing otomatis dari jeda napas VO';
}
for (const id of ['script', 'usetitle', 'titlesec', 'vo', 'srt', 'srtmode']) for (const ev of ['input', 'change']) $(id).addEventListener(ev, refreshState);

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

// ---------- render ----------
async function render() {
  const files = [...$('photos').files], vo = $('vo').files[0], srt = $('srt').files[0];
  if (!files.length) return status('Upload minimal satu foto atau video.');
  if (!vo) return status('Upload file voice over.');
  const local = await detectLocal();
  const store = new Map();
  const put = async (name, data) => {
    if (local) store.set(name, data instanceof Blob ? data : new Blob([data]));
    else await ffmpeg.writeFile(name, data instanceof Blob ? await fetchFile(data) : data);
  };
  const MB = files.reduce((a, f) => a + f.size, 0) / 1048576;
  if (!local && MB > 500) throw new Error(`Total bahan ${Math.round(MB)} MB, terlalu besar untuk render di browser. Kompres video ke 720p atau kurangi jumlah klip (batas sekitar 500 MB).`);
  const W = $('res').value === '1080' ? 1080 : 720, H = Math.round((W * 16) / 9);
  const F = CFG.fadeSeconds, D = Math.max(+$('dur').value || CFG.photoSeconds, F + 0.5);
  const shift = +$('shift').value || 0, motion = $('motion').value === 'on', fit = $('fit').value;
  const useTitle = $('usetitle').value === 'on', titleSec = +$('titlesec').value || 0;

  if (!local && !loaded) {
    status('Memuat ffmpeg (sekali saja, ~30 MB)...');
    ffmpeg.on('log', ({ message }) => console.log('[ffmpeg]', message));
    ffmpeg.on('progress', ({ progress: p }) => progress(Math.min(0.99, 0.2 + p * 0.8)));
    await ffmpeg.load({
      coreURL: await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
    });
    loaded = true;
  }
  progress(0.02); status('Menyiapkan bahan...');
  const T = await mediaDuration(vo, 'audio');
  await document.fonts.load(subFont(subSize(W)));
  await document.fonts.load(`700 ${titleSize(W)}px Montserrat`);

  const items = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
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
  await put(`vo.${ext}`, vo);
  await put('logo.png', await (await fetch(CFG.logo.src)).blob());
  const bgm = $('bgm').files[0];
  const bgmExt = bgm ? (bgm.name.split('.').pop() || 'mp3').toLowerCase() : null;
  if (bgm) await put(`bgm.${bgmExt}`, bgm);

  status('Menyiapkan teks...');
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
  let sfx = null;
  const sfxVol = Math.min(1, Math.max(0, (+$('sfxvol').value || 0) / 100));
  if (useFlash && sfxVol > 0) {
    try {
      const r = await fetch(CFG.sfx.src);
      if (r.ok) {
        const ext = CFG.sfx.src.split('.').pop();
        await put(`sfx.${ext}`, await r.blob());
        sfx = { ext, volume: sfxVol, at: Math.max(0, titleEnd - CFG.sfx.lead) };
      }
    } catch { /* lanjut tanpa SFX */ }
  }
  const seq = planSeq(items, { T, F, titleEnd, titleTr: tr.seconds, titleTrName: tr.name });
  const common = { W, H, fps: CFG.fps, seq, cues, ext, T, logo: CFG.logo, subBottomPct: CFG.subtitle.bottomPct, titleBottomPct: CFG.title.bottomPct,
    zoom: CFG.zoomAmount, motion, fit, flash, sfx,
    bgmExt, bgmVol: Math.min(1, Math.max(0, (+$('bgmvol').value || 0) / 100)), bgmFade: MUSIC.fadeOutSeconds };

  let blob;
  if (local) {
    const kind = $('enc').value === 'cpu' ? 'cpu' : (['nvenc', 'qsv', 'amf'].find((k) => local.encoders.includes(k)) || 'cpu');
    const br = W >= 1080 ? '10M' : '6M';
    const vc = { cpu: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22'], nvenc: ['-c:v', 'h264_nvenc', '-b:v', br], qsv: ['-c:v', 'h264_qsv', '-b:v', br], amf: ['-c:v', 'h264_amf', '-b:v', br] };
    const args = buildArgs({ ...common, vcodec: vc[kind] });
    const argsCpu = kind === 'cpu' ? null : buildArgs({ ...common, vcodec: vc.cpu });
    status(`Merender di komputer ini (${kind === 'cpu' ? 'CPU' : 'GPU ' + kind.toUpperCase()})...`);
    blob = await runLocal(store, args, argsCpu, T, $('mode').value);
  } else {
    status('Merender di browser... (tab jangan ditutup)');
    const code = await ffmpeg.exec(buildArgs(common));
    if (code !== 0) throw new Error('ffmpeg gagal (kode ' + code + '). Coba resolusi 720, kurangi jumlah klip, atau pakai video MP4 yang lebih kecil.');
    const data = await ffmpeg.readFile('out.mp4');
    blob = new Blob([data.buffer], { type: 'video/mp4' });
    for (const name of (await ffmpeg.listDir('.')).map((e) => e.name))
      if (/^(p|s|v)\d+\./.test(name) || /^(vo|bgm|logo|sfx)\./.test(name) || name === 'out.mp4') await ffmpeg.deleteFile(name);
  }

  const url = URL.createObjectURL(blob);
  $('out').innerHTML = `<video src="${url}" controls playsinline></video>`;
  $('dl').innerHTML = `<a href="${url}" download="bali-express-video.mp4">Download MP4</a>`;
  progress(1); status('Selesai.');
}

// ---------- server lokal ----------
async function detectLocal() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ffmpeg ? j : null;
  } catch { return null; }
}
async function runLocal(store, args, argsCpu, T, mode) {
  const fd = new FormData();
  fd.append('meta', JSON.stringify({ args, argsCpu, mode }));
  for (const [name, blob] of store) fd.append(name, blob, name);
  const res = await fetch('/api/render', { method: 'POST', body: fd });
  if (!res.ok || !res.body) throw new Error('Server lokal menolak permintaan (kode ' + res.status + ').');
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.t != null) progress(Math.min(0.99, 0.1 + (0.9 * msg.t) / T));
      if (msg.info) status(msg.info);
      if (msg.error) throw new Error(msg.error);
      if (msg.done) done = msg;
    }
  }
  if (!done) throw new Error('Render terputus sebelum selesai.');
  return await (await fetch(`/api/result/${done.id}`)).blob();
}
detectLocal().then((l) => {
  $('engine').textContent = l
    ? `Render: ffmpeg di komputer ini (${l.encoders.length ? 'GPU ' + l.encoders.join(', ').toUpperCase() : 'CPU'})`
    : 'Render: di browser (lebih lambat)';
});

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
