// Render batch: pilih satu folder induk, tiap subfolder = satu video. Hasil disimpan ke subfolder "hasil".
const OUT_DIR = 'hasil';
const PHOTO = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i;
const MUSIK = /^(musik|music|bgm)/i;
// akhiran nama foto menentukan gerakannya, mis. "2_zoomin.jpg"; tanpa akhiran = Otomatis
const FX_NAME = { zoomin: 'zin', zoomout: 'zout', kanan: 'panr', kiri: 'panl', diam: 'static' };
const fxOf = (name) => FX_NAME[name.match(/[\s_-](zoomin|zoomout|kanan|kiri|diam)\.[^.]+$/i)?.[1].toLowerCase()];
const byName = (a, b) => a.name.localeCompare(b.name, 'id', { numeric: true, sensitivity: 'base' });

async function listDir(dir) {
  const files = [], dirs = [];
  for await (const h of dir.values()) {
    if (h.name.startsWith('.')) continue;
    if (h.kind === 'directory') dirs.push(h); else files.push(await h.getFile());
  }
  return { files: files.sort(byName), dirs: dirs.sort(byName) };
}

// Pilah isi satu folder berita. Melempar Error kalau bahannya kurang atau membingungkan.
export function sortFiles(files, rootMusic = null) {
  const heic = files.find((f) => /\.hei[cf]$/i.test(f.name));
  if (heic) throw new Error(`"${heic.name}" format HEIC tidak didukung, convert ke JPG dulu`);
  // file berawalan "vo" boleh berekstensi mp4/mpeg (mis. kiriman WhatsApp)
  const isVo = (f) => /^vo([\s._\-0-9]|$)/i.test(f.name) && (AUDIO.test(f.name) || /\.(mp4|mpeg)$/i.test(f.name));
  const audios = files.filter((f) => AUDIO.test(f.name) || isVo(f));
  const music = audios.filter((f) => MUSIK.test(f.name));
  const others = audios.filter((f) => !MUSIK.test(f.name));
  const named = others.filter(isVo);
  const vos = named.length ? named : others;
  if (!vos.length) throw new Error('voice over tidak ada');
  if (vos.length > 1) throw new Error(`ada ${vos.length} audio, namai voice over "vo" dan musik "musik"`);
  if (music.length > 1) throw new Error('file musik lebih dari satu');
  const media = files.filter((f) => !audios.includes(f) && (PHOTO.test(f.name) || VIDEO.test(f.name)));
  if (!media.length) throw new Error('tidak ada foto atau video');
  const one = (re, preferred, label) => {
    const all = files.filter((f) => re.test(f.name));
    const pick = all.find((f) => preferred.test(f.name));
    if (!pick && all.length > 1) throw new Error(`file ${label} lebih dari satu`);
    return pick || all[0] || null;
  };
  const txt = one(/\.txt$/i, /^naskah\.txt$/i, '.txt');
  const srt = one(/\.srt$/i, /^naskah\.srt$/i, '.srt');
  if (!txt && !srt) throw new Error('naskah (.txt) atau .srt tidak ada');
  return { media, vo: vos[0], srt, txt, bgm: music[0] || rootMusic };
}

async function hasOutput(outDir, name) {
  try { return (await (await outDir.getFileHandle(name)).getFile()).size > 0; }
  catch (e) { if (e.name === 'NotFoundError') return false; throw e; }
}

async function save(outDir, name, blob) {
  const w = await (await outDir.getFileHandle(name, { create: true })).createWritable();
  try { await w.write(blob); await w.close(); }
  catch (e) { await w.abort().catch(() => {}); throw e; }
}

export function initBatch({ render, resetForm, resetEngine }) {
  const $ = (id) => document.getElementById(id);
  if (!window.showDirectoryPicker) {
    $('bpick').disabled = true;
    $('bhint').textContent = 'Render batch butuh Chrome atau Edge di komputer.';
    return;
  }
  let stop = false, running = false;
  const setBusy = (busy) => {
    running = busy;
    for (const id of ['go', 'cfg', 'tedit', 'bpick', 'photos', 'vo', 'srt', 'bgm', 'script']) $(id).disabled = busy;
    $('bstop').hidden = !busy; $('bstop').disabled = false;
  };
  const row = (name) => {
    const li = document.createElement('li');
    const b = document.createElement('b'); b.textContent = name;
    const s = document.createElement('span'); s.textContent = 'antre';
    li.append(b, s); $('blist').append(li);
    return (text, kind = '') => { s.textContent = text; li.className = kind; };
  };
  const setInput = (id, files) => {
    const dt = new DataTransfer(); files.filter(Boolean).forEach((f) => dt.items.add(f));
    $(id).files = dt.files; $(id).dispatchEvent(new Event('change'));
  };
  const fill = async (job) => {
    resetForm();
    setInput('photos', job.media); setInput('vo', [job.vo]); setInput('srt', [job.srt]); setInput('bgm', [job.bgm]);
    job.media.forEach((f, i) => {
      const fx = fxOf(f.name), sel = $('fxlist').children[i]?.querySelector('select');   // video tidak punya pilihan
      if (fx && sel) { sel.value = fx; sel.dispatchEvent(new Event('change')); }
    });
    $('script').value = job.txt ? (await job.txt.text()).trim() : '';
    $('script').dispatchEvent(new Event('input'));
  };

  window.addEventListener('beforeunload', (e) => { if (running) e.preventDefault(); });
  $('bstop').onclick = () => { stop = true; $('bstop').disabled = true; $('bsum').textContent = 'Berhenti setelah video yang sedang dirender selesai...'; };

  $('bpick').onclick = async () => {
    let root;
    try { root = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { if (e.name !== 'AbortError') $('bsum').textContent = 'Folder tidak bisa dibuka: ' + e.message; return; }
    stop = false; setBusy(true); $('blist').innerHTML = ''; $('bsum').textContent = 'Membaca folder...';
    let lock = null, done = 0, skipped = 0, failed = 0;
    try {
      lock = await navigator.wakeLock?.request('screen').catch(() => null);   // cegah layar tidur selagi tab terlihat
      const { files, dirs } = await listDir(root);
      const jobs = dirs.filter((d) => d.name.toLowerCase() !== OUT_DIR);
      if (!jobs.length) { $('bsum').textContent = 'Tidak ada subfolder. Pilih folder induk yang berisi satu folder per berita.'; return; }
      const rootMusic = files.find((f) => MUSIK.test(f.name) && AUDIO.test(f.name)) || null;
      const outDir = await root.getDirectoryHandle(OUT_DIR, { create: true });
      const rows = jobs.map((d) => row(d.name));
      for (let i = 0; i < jobs.length && !stop; i++) {
        const dir = jobs[i], set = rows[i], name = `${dir.name}.mp4`;
        try {
          if (await hasOutput(outDir, name)) { skipped++; set('dilewati, hasil sudah ada', 'skip'); continue; }
          $('bsum').textContent = `Video ${i + 1} dari ${jobs.length}: ${dir.name}`;
          set('merender...', 'run');
          const job = sortFiles((await listDir(dir)).files, rootMusic);
          let blob;
          for (let attempt = 1; !blob; attempt++) {
            try {
              await fill(job);
              blob = await render();
              if (!blob) throw new Error($('status').textContent || 'render gagal');
            } catch (e) {
              console.error(dir.name, e); resetEngine();   // ffmpeg dimulai bersih setelah gagal
              if (attempt >= 2) throw e;
              set('gagal, mencoba sekali lagi...', 'run');
            }
          }
          await save(outDir, name, blob);
          done++; const warn = $('status').textContent.replace(/^Selesai\.\s*/, '');
          set(`selesai: ${OUT_DIR}/${name}${warn ? ' (' + warn + ')' : ''}`, 'ok');
        } catch (e) {
          failed++; set('gagal: ' + (e?.message || String(e)), 'bad');
        }
      }
      $('bsum').textContent = `${stop ? 'Dihentikan' : 'Batch selesai'}: ${done} jadi, ${skipped} dilewati, ${failed} gagal.`;
    } catch (e) {
      console.error(e); $('bsum').textContent = 'Batch gagal: ' + (e?.message || String(e));
    } finally {
      lock?.release().catch(() => {});
      resetForm(); setBusy(false);
    }
  };
}
