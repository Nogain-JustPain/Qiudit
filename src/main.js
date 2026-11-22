import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/600-italic.css';
import '@fontsource/montserrat/700.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import CFG from './config.js';
import { buildArgs } from './ffgraph.js';

const $ = (id) => document.getElementById(id);
const ffmpeg = new FFmpeg();
let loaded = false;
const status = (t) => ($('status').textContent = t);
const progress = (v) => { $('bar').hidden = false; $('bar').value = v; };
const subFont = (size) => CFG.subtitle.font.replace('{size}', size);

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
// Timing dibagi di rentang suara saja (jeda awal/akhir VO diabaikan),
// dan kalimat yang berakhir titik/koma dapat bobot jeda tambahan.
function cuesFromText(text, s, e) {
  const max = CFG.subtitle.maxCharsPerCue, parts = [];
  for (const para of text.split(/\n+/).map((x) => x.trim()).filter(Boolean))
    for (const sent of para.match(/[^.!?]+[.!?]*/g) || []) {
      let cur = '';
      for (const w of sent.trim().split(/\s+/)) {
        if (cur && (cur + ' ' + w).length > max) { parts.push(cur); cur = ''; }
        cur = cur ? cur + ' ' + w : w;
      }
      if (cur) parts.push(cur);
    }
  const wt = parts.map((p) => p.length + (/[.!?]$/.test(p) ? 14 : /[,;:]$/.test(p) ? 7 : 0));
  const sum = wt.reduce((a, b) => a + b, 0) || 1;
  let t = s;
  return parts.map((p, i) => { const d = ((e - s) * wt[i]) / sum; const c = { start: t, end: t + d, text: p }; t += d; return c; });
}

// ---------- audio ----------
const audioDuration = (file) => new Promise((res, rej) => {
  const a = new Audio(URL.createObjectURL(file));
  a.onloadedmetadata = () => res(a.duration); a.onerror = () => rej(new Error('Voice over tidak bisa dibaca'));
});
async function speechBounds(file, T) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer()); ctx.close();
    const d = buf.getChannelData(0), win = Math.round(buf.sampleRate * 0.05);
    let s = -1, e = 0;
    for (let i = 0; i + win <= d.length; i += win) {
      let sum = 0; for (let j = i; j < i + win; j++) sum += d[j] * d[j];
      if (Math.sqrt(sum / win) > 0.015) { if (s < 0) s = i / buf.sampleRate; e = (i + win) / buf.sampleRate; }
    }
    if (s >= 0 && e - s > T * 0.5) return [Math.max(0, s - 0.05), Math.min(T, e)];
  } catch { /* pakai seluruh durasi */ }
  return [0, T];
}

// ---------- gambar via canvas ----------
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
  const c = new OffscreenCanvas(W, H); const x = c.getContext('2d');
  const k = Math.max(W / bw, H / bh);
  x.drawImage(bmp, (W - bw * k) / 2, (H - bh * k) / 2, bw * k, bh * k);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}
// Kotak putih membulat, teks hitam miring
async function cueToPng(text, W) {
  const S = CFG.subtitle, size = Math.round(W * S.sizePct);
  const padX = Math.round(size * 0.55), padY = Math.round(size * 0.32), lh = Math.round(size * 1.3);
  const probe = new OffscreenCanvas(10, 10).getContext('2d'); probe.font = subFont(size);
  const limit = W * 0.86 - padX * 2, lines = []; let cur = '';
  for (const w of text.split(' ')) {
    const tryLine = cur ? cur + ' ' + w : w;
    if (probe.measureText(tryLine).width > limit && cur) { lines.push(cur); cur = w; } else cur = tryLine;
  }
  lines.push(cur);
  const boxW = Math.ceil(Math.max(...lines.map((l) => probe.measureText(l).width)) + padX * 2);
  const boxH = lines.length * lh + padY * 2;
  const c = new OffscreenCanvas(W, boxH); const x = c.getContext('2d');
  x.fillStyle = S.box; x.beginPath(); x.roundRect((W - boxW) / 2, 0, boxW, boxH, size * 0.28); x.fill();
  x.font = subFont(size); x.fillStyle = S.color; x.textAlign = 'center'; x.textBaseline = 'middle';
  lines.forEach((l, i) => x.fillText(l, W / 2, padY + lh * i + lh / 2));
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

// ---------- render ----------
async function render() {
  const photos = [...$('photos').files], vo = $('vo').files[0], srt = $('srt').files[0];
  if (!photos.length) return status('Upload minimal satu foto.');
  if (!vo) return status('Upload file voice over.');
  const W = $('res').value === '1080' ? 1080 : 720, H = Math.round((W * 16) / 9);
  const F = CFG.fadeSeconds, D = Math.max(+$('dur').value || CFG.photoSeconds, F + 0.5);
  const shift = +$('shift').value || 0, motion = $('motion').value === 'on';

  if (!loaded) {
    status('Memuat ffmpeg (sekali saja, ~30 MB)...');
    ffmpeg.on('log', ({ message }) => console.log('[ffmpeg]', message));
    ffmpeg.on('progress', ({ progress: p }) => progress(Math.min(0.99, 0.2 + p * 0.8)));
    await ffmpeg.load({
      coreURL: await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
    });
    loaded = true;
  }
  progress(0.02); status('Menyiapkan foto...');
  const T = await audioDuration(vo);
  const n = Math.max(1, Math.ceil((T - F) / (D - F)));
  await document.fonts.load(subFont(Math.round(W * CFG.subtitle.sizePct)));

  for (let i = 0; i < photos.length; i++) await ffmpeg.writeFile(`p${i}.jpg`, await photoToJpeg(photos[i], W, H));
  const ext = (vo.name.split('.').pop() || 'mp3').toLowerCase();
  await ffmpeg.writeFile(`vo.${ext}`, await fetchFile(vo));
  await ffmpeg.writeFile('logo.png', await fetchFile(CFG.logo.src));

  status('Menyiapkan subtitle...');
  let cues;
  if (srt) cues = parseSrt(await srt.text());
  else { const [s, e] = await speechBounds(vo, T); cues = cuesFromText($('script').value, s, e); }
  cues = cues.map((c) => ({ ...c, start: Math.max(0, c.start + shift), end: Math.min(T, c.end + shift) })).filter((c) => c.end > c.start);
  for (let i = 0; i < cues.length; i++) await ffmpeg.writeFile(`s${i}.png`, await cueToPng(cues[i].text, W));
  progress(0.1);

  const args = buildArgs({ W, H, D, F, fps: CFG.fps, n, nPhotos: photos.length, cues, ext, T, logo: CFG.logo,
    subBottomPct: CFG.subtitle.bottomPct, zoom: CFG.zoomAmount, pan: CFG.panAmount, motion });

  status('Merender video... (tab jangan ditutup)');
  const code = await ffmpeg.exec(args);
  if (code !== 0) throw new Error('ffmpeg gagal (kode ' + code + '). Coba resolusi 720 atau kurangi jumlah foto.');

  const data = await ffmpeg.readFile('out.mp4');
  const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
  $('out').innerHTML = `<video src="${url}" controls playsinline></video>`;
  $('dl').innerHTML = `<a href="${url}" download="bali-express-video.mp4">Download MP4</a>`;
  progress(1); status('Selesai.');
  for (const name of (await ffmpeg.listDir('.')).map((e) => e.name)) if (/^(p|s)\d+\.(jpg|png)$/.test(name) || name === 'out.mp4') await ffmpeg.deleteFile(name);
}

// nama file terpilih
for (const id of ['photos', 'vo', 'srt']) $(id).onchange = () => {
  const f = [...$(id).files]; $(id + 'Name').textContent = !f.length ? 'Belum ada file' : f.length > 1 ? `${f.length} file dipilih` : f[0].name;
};
$('go').onclick = async () => {
  $('go').disabled = true; $('out').innerHTML = ''; $('dl').innerHTML = '';
  try { await render(); } catch (e) { console.error(e); status('Gagal: ' + (e && e.message ? e.message : String(e) || 'error tidak diketahui, buka Console (F12)')); }
  $('go').disabled = false;
};
