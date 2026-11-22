import '@fontsource/montserrat/700.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import CFG from './config.js';

const $ = (id) => document.getElementById(id);
const ffmpeg = new FFmpeg();
let loaded = false;
const status = (t) => ($('status').textContent = t);
const progress = (v) => { $('bar').hidden = false; $('bar').value = v; };

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
function cuesFromText(text, total) {
  const max = CFG.subtitle.maxCharsPerCue;
  const parts = [];
  for (const s of text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*/g) || []) {
    let cur = '';
    for (const w of s.trim().split(' ')) {
      if ((cur + ' ' + w).trim().length > max && cur) { parts.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
    if (cur) parts.push(cur);
  }
  const sum = parts.reduce((a, p) => a + p.length, 0) || 1;
  let t = 0;
  return parts.map((p) => { const d = (p.length / sum) * total; const c = { start: t, end: t + d, text: p }; t += d; return c; });
}

// ---------- gambar via canvas ----------
async function photoToJpeg(file, W, H) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    try {
      bmp = await new Promise((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file);
      });
    } catch {
      throw new Error(`Foto "${file.name}" tidak bisa dibaca browser (format ${file.type || file.name.split('.').pop()}). Convert ke JPG/PNG dulu, HEIC dari iPhone tidak didukung.`);
    }
  }
  const c = new OffscreenCanvas(W, H); const x = c.getContext('2d');
  const k = Math.max(W / (bmp.naturalWidth || bmp.width), H / (bmp.naturalHeight || bmp.height));
  x.drawImage(bmp, (W - (bmp.naturalWidth || bmp.width) * k) / 2, (H - (bmp.naturalHeight || bmp.height) * k) / 2, (bmp.naturalWidth || bmp.width) * k, (bmp.naturalHeight || bmp.height) * k);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}
async function cueToPng(text, W) {
  const S = CFG.subtitle, size = Math.round(W * S.sizePct), pad = Math.round(size * 0.45);
  const font = S.font.replace('{size}', size);
  const probe = new OffscreenCanvas(10, 10).getContext('2d'); probe.font = font;
  const limit = W * 0.86 - pad * 2, lines = []; let cur = '';
  for (const w of text.split(' ')) {
    const tryLine = cur ? cur + ' ' + w : w;
    if (probe.measureText(tryLine).width > limit && cur) { lines.push(cur); cur = w; } else cur = tryLine;
  }
  lines.push(cur);
  const lh = Math.round(size * 1.3), boxW = Math.min(W * 0.92, Math.max(...lines.map((l) => probe.measureText(l).width)) + pad * 2);
  const H = lines.length * lh + pad * 1.2;
  const c = new OffscreenCanvas(W, Math.ceil(H)); const x = c.getContext('2d');
  x.fillStyle = S.box; x.beginPath(); x.roundRect((W - boxW) / 2, 0, boxW, H, size * 0.25); x.fill();
  x.font = font; x.fillStyle = S.color; x.textAlign = 'center'; x.textBaseline = 'middle';
  lines.forEach((l, i) => x.fillText(l, W / 2, pad * 0.6 + lh * i + lh / 2));
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
const audioDuration = (file) => new Promise((res, rej) => {
  const a = new Audio(URL.createObjectURL(file));
  a.onloadedmetadata = () => res(a.duration); a.onerror = () => rej(new Error('Voice over tidak bisa dibaca'));
});

// ---------- render ----------
async function render() {
  const photos = [...$('photos').files], vo = $('vo').files[0], srt = $('srt').files[0];
  if (!photos.length) return status('Upload minimal satu foto.');
  if (!vo) return status('Upload file voice over.');
  const W = $('res').value === '1080' ? 1080 : 720, H = Math.round((W * 16) / 9);
  const D = Math.max(+$('dur').value || CFG.photoSeconds, CFG.fadeSeconds + 0.5), F = CFG.fadeSeconds;

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
  await document.fonts.load(`700 ${Math.round(W * CFG.subtitle.sizePct)}px Montserrat`);

  for (let i = 0; i < photos.length; i++) await ffmpeg.writeFile(`p${i}.jpg`, await photoToJpeg(photos[i], W, H));
  const ext = (vo.name.split('.').pop() || 'mp3').toLowerCase();
  await ffmpeg.writeFile(`vo.${ext}`, await fetchFile(vo));
  await ffmpeg.writeFile('logo.png', await fetchFile(CFG.logo.src));

  status('Menyiapkan subtitle...');
  let cues = srt ? parseSrt(await srt.text()) : cuesFromText($('script').value, T);
  for (let i = 0; i < cues.length; i++) await ffmpeg.writeFile(`s${i}.png`, await cueToPng(cues[i].text, W));
  progress(0.1);

  // input: n klip foto | logo | subtitle | audio
  const args = [];
  for (let k = 0; k < n; k++) args.push('-loop', '1', '-framerate', String(CFG.fps), '-t', String(D), '-i', `p${k % photos.length}.jpg`);
  args.push('-i', 'logo.png');
  cues.forEach((_, i) => args.push('-i', `s${i}.png`));
  args.push('-i', `vo.${ext}`);

  const f = []; let cur = '[0:v]';
  for (let k = 1; k < n; k++) { f.push(`${cur}[${k}:v]xfade=transition=fade:duration=${F}:offset=${(k * (D - F)).toFixed(3)}[x${k}]`); cur = `[x${k}]`; }
  const L = CFG.logo;
  f.push(`[${n}:v]scale=${Math.round(W * L.widthPct)}:-1[lg]`);
  f.push(`${cur}[lg]overlay=x=${Math.round(W * L.xPct)}:y=${Math.round(H * L.yPct)}[v0]`); cur = '[v0]';
  const yb = Math.round(H * CFG.subtitle.bottomPct);
  cues.forEach((c, i) => {
    f.push(`${cur}[${n + 1 + i}:v]overlay=x=0:y=${yb}-h:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[o${i}]`); cur = `[o${i}]`;
  });
  f.push(`${cur}format=yuv420p[vout]`);

  status('Merender video... (tab jangan ditutup)');
  const code = await ffmpeg.exec([...args, '-filter_complex', f.join(';'), '-map', '[vout]', '-map', `${n + 1 + cues.length}:a`,
    '-t', T.toFixed(3), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4']);
  if (code !== 0) throw new Error('ffmpeg gagal (kode ' + code + '). Coba resolusi 720 atau kurangi jumlah foto.');

  const data = await ffmpeg.readFile('out.mp4');
  const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
  $('out').innerHTML = `<video src="${url}" controls playsinline></video><br><a href="${url}" download="bali-express-video.mp4">Download MP4</a>`;
  progress(1); status('Selesai.');
  // bersihkan memori
  for (const name of (await ffmpeg.listDir('.')).map((e) => e.name)) if (/^(p|s)\d+\.(jpg|png)$/.test(name) || name === 'out.mp4') await ffmpeg.deleteFile(name);
}

$('go').onclick = async () => {
  $('go').disabled = true; $('out').innerHTML = '';
  try { await render(); } catch (e) { console.error(e); status('Gagal: ' + (e && e.message ? e.message : String(e) || 'error tidak diketahui, buka Console (F12)')); }
  $('go').disabled = false;
};
