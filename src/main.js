import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/600-italic.css';
import '@fontsource/montserrat/700.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import CFG, { MUSIC } from './config.js';
import { buildArgs, planSeq } from './ffgraph.js';

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
// Paragraf pertama = judul (tidak dipecah). Sisanya dipecah per kalimat.
// Timing dibagi di rentang suara saja (jeda awal/akhir VO diabaikan),
// kalimat yang berakhir titik/koma dapat bobot jeda tambahan.
function cuesFromText(text, s, e, withTitle, titleSec) {
  const max = CFG.subtitle.maxCharsPerCue, paras = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const list = [];
  let body = paras;
  if (withTitle && paras.length > 1) { list.push({ text: paras[0], isTitle: true }); body = paras.slice(1); }
  for (const para of body)
    for (const sent of para.match(/[^.!?]+[.!?]*/g) || []) {
      let cur = '';
      for (const w of sent.trim().split(/\s+/)) {
        if (cur && (cur + ' ' + w).length > max) { list.push({ text: cur }); cur = ''; }
        cur = cur ? cur + ' ' + w : w;
      }
      if (cur) list.push({ text: cur });
    }
  const wt = (p) => p.text.length + (/[.!?]$/.test(p.text) ? 14 : /[,;:]$/.test(p.text) ? 7 : 0);
  let t = s, span = e - s, items = list;
  const out = [];
  if (list[0]?.isTitle && titleSec > 0) { out.push({ ...list[0], start: s, end: s + titleSec }); t = s + titleSec; span = e - t; items = list.slice(1); }
  const sum = items.reduce((a, p) => a + wt(p), 0) || 1;
  for (const p of items) { const d = (span * wt(p)) / sum; out.push({ ...p, start: t, end: t + d }); t += d; }
  return out;
}

// ---------- audio ----------
const mediaDuration = (file, tag) => new Promise((res, rej) => {
  const a = document.createElement(tag); a.preload = 'metadata';
  a.onloadedmetadata = () => res(a.duration);
  a.onerror = () => rej(new Error(tag === 'audio' ? 'Voice over tidak bisa dibaca' : `Video "${file.name}" tidak bisa dibaca browser. Pakai MP4 (H.264), HEVC dari sebagian HP perlu di-convert dulu.`));
  a.src = URL.createObjectURL(file);
});
const isVideo = (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
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
  const MB = files.reduce((a, f) => a + f.size, 0) / 1048576;
  if (MB > 500) throw new Error(`Total bahan ${Math.round(MB)} MB, terlalu besar untuk render di browser. Kompres video ke 720p atau kurangi jumlah klip (batas sekitar 500 MB).`);
  const W = $('res').value === '1080' ? 1080 : 720, H = Math.round((W * 16) / 9);
  const F = CFG.fadeSeconds, D = Math.max(+$('dur').value || CFG.photoSeconds, F + 0.5);
  const shift = +$('shift').value || 0, motion = $('motion').value === 'on', fit = $('fit').value;
  const useTitle = $('usetitle').value === 'on', titleSec = +$('titlesec').value || 0;

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
      await ffmpeg.writeFile(name, await fetchFile(f));
      items.push({ kind: 'video', file: name, dur });
    } else {
      const r = await photoToJpeg(f, W, H);
      await ffmpeg.writeFile(`p${i}.jpg`, r.bytes);
      // foto landscape: durasi menyesuaikan lebar supaya geser penuh tidak terlalu cepat
      let dur = D;
      if (motion && r.landscape) dur = Math.min(CFG.panMaxSeconds, Math.max(D, (r.width - W) / (CFG.panSpeedPct * W)));
      items.push({ kind: 'photo', file: `p${i}.jpg`, dur, landscape: r.landscape });
    }
  }

  const ext = (vo.name.split('.').pop() || 'mp3').toLowerCase();
  await ffmpeg.writeFile(`vo.${ext}`, await fetchFile(vo));
  await ffmpeg.writeFile('logo.png', await fetchFile(CFG.logo.src));
  const bgm = $('bgm').files[0];
  const bgmExt = bgm ? (bgm.name.split('.').pop() || 'mp3').toLowerCase() : null;
  if (bgm) await ffmpeg.writeFile(`bgm.${bgmExt}`, await fetchFile(bgm));

  status('Menyiapkan teks...');
  let cues;
  if (srt) { cues = parseSrt(await srt.text()); if (useTitle && cues.length > 1) cues[0].isTitle = true; }
  else { const [s, e] = await speechBounds(vo, T); cues = cuesFromText($('script').value, s, e, useTitle, titleSec); }
  cues = cues.map((c) => ({ ...c, start: Math.max(0, c.start + shift), end: Math.min(T, c.end + shift) })).filter((c) => c.end > c.start);
  const tc = cues[0];
  let titleEnd = 0;
  if (tc?.isTitle) { tc.start = 0; if (tc.end > 1.2 && tc.end < T - 2) titleEnd = tc.end; else tc.isTitle = false; }
  for (let i = 0; i < cues.length; i++) await ffmpeg.writeFile(`s${i}.png`, await (cues[i].isTitle ? titleToPng : cueToPng)(cues[i].text, W));
  progress(0.1);

  const seq = planSeq(items, { T, F, titleEnd, titleTr: CFG.titleTransition.seconds, titleTrName: CFG.titleTransition.name });
  const args = buildArgs({ W, H, fps: CFG.fps, seq, cues, ext, T, logo: CFG.logo, subBottomPct: CFG.subtitle.bottomPct, titleBottomPct: CFG.title.bottomPct,
    zoom: CFG.zoomAmount, motion, fit,
    bgmExt, bgmVol: Math.min(1, Math.max(0, (+$('bgmvol').value || 0) / 100)), bgmFade: MUSIC.fadeOutSeconds });

  status('Merender video... (tab jangan ditutup)');
  const code = await ffmpeg.exec(args);
  if (code !== 0) throw new Error('ffmpeg gagal (kode ' + code + '). Coba resolusi 720, kurangi jumlah klip, atau pakai video MP4 yang lebih kecil.');

  const data = await ffmpeg.readFile('out.mp4');
  const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
  $('out').innerHTML = `<video src="${url}" controls playsinline></video>`;
  $('dl').innerHTML = `<a href="${url}" download="bali-express-video.mp4">Download MP4</a>`;
  progress(1); status('Selesai.');
  for (const name of (await ffmpeg.listDir('.')).map((e) => e.name))
    if (/^(p|s|v)\d+\./.test(name) || /^(vo|bgm|logo)\./.test(name) || name === 'out.mp4') await ffmpeg.deleteFile(name);
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
