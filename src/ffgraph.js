// Menyusun perintah ffmpeg (dipisah supaya bisa dites di luar browser)

// Menyusun urutan klip: bahan diulang sampai durasi VO terpenuhi.
// Kalau ada judul, klip pertama dibuat berakhir pas saat judul selesai dibaca,
// lalu transisi ke klip kedua memakai gaya yang berbeda.
export function planSeq(items, { T, F, titleEnd = 0, titleTr = 0.6, titleTrName = 'slideleft' }) {
  const seq = []; let end = 0, pl = 0, po = 0;
  for (let k = 0; (k === 0 || end < T) && k < 500; k++) {
    const it = items[k % items.length];
    const special = titleEnd > 0;
    const tr = k === 0 ? 0 : k === 1 && special ? titleTr : F;
    const start = k === 0 ? 0 : end - tr;
    const dur = k === 0 && special ? titleEnd + titleTr / 2 : it.dur;
    const m = it.kind === 'photo' ? (it.landscape ? pl++ : po++) : 0;
    // efek: 'auto' bergantian (landscape geser kanan/kiri, portrait zoom in/out); selain itu sesuai pilihan
    const effect = it.kind !== 'photo' ? undefined : it.effect && it.effect !== 'auto' ? it.effect : it.landscape ? (m % 2 === 0 ? 'panr' : 'panl') : (m % 2 === 0 ? 'zin' : 'zout');
    seq.push({ ...it, dur, tr, start, m, effect, first: k === 0 && special, trName: k === 1 && special ? titleTrName : 'fade' });
    end = start + dur;
  }
  return seq;
}

// seq = hasil planSeq
export function buildArgs({ W, H, fps, seq, cues, ext, T, logo, subBottomPct, titleBottomPct, zoom, motion, panCover = 0.8, fit = 'crop', bgmExt, bgmVol = 0.15, bgmFade = 2, vcodec = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24'], flash = null, sfx = null }) {
  const n = seq.length, args = [];
  for (const c of seq) {
    if (c.kind === 'photo') args.push('-loop', '1', '-framerate', String(fps), '-t', c.dur.toFixed(3), '-i', c.file);
    else args.push('-t', c.dur.toFixed(2), '-i', c.file);
  }
  args.push('-i', 'logo.png');
  cues.forEach((_, i) => args.push('-i', `s${i}.png`));
  args.push('-i', `vo.${ext}`);
  if (bgmExt) args.push('-stream_loop', '-1', '-i', `bgm.${bgmExt}`);
  if (sfx) args.push('-i', `sfx.${sfx.ext}`);

  const f = [];
  // zoom dari tengah dengan filter perspective (resampling sub-piksel, jauh lebih mulus daripada scale+crop yang dibulatkan ke piksel per frame)
  const wz = (e) => {
    const a = `(W/2*(1-1/(${e})))`, b = `(H/2*(1-1/(${e})))`;
    return `perspective=x0='${a}':y0='${b}':x1='W-${a}':y1='${b}':x2='${a}':y2='H-${b}':x3='W-${a}':y3='H-${b}':interpolation=linear:eval=frame`;
  };
  const sw = Math.round(W / 6 / 2) * 2, sh = Math.round(H / 6 / 2) * 2;

  seq.forEach((c, k) => {
    if (c.kind === 'photo') {
      const p = `n/${Math.round(c.dur * fps)}`, pz = `in/${Math.round(c.dur * fps)}`;   // pz: nomor frame untuk perspective
      const base = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;   // potong tengah, pas 9:16
      let chain = base;                                                                       // 'static'
      if (c.effect === 'panr' || c.effect === 'panl') chain = `crop=${W}:${H}:'(iw-ow)*(${((1 - panCover) / 2).toFixed(4)}+${panCover}*(${c.effect === 'panr' ? p : `1-${p}`}))':0`;   // geser penuh sisi ke sisi
      else if (c.effect === 'zin' || c.effect === 'zout') chain = (c.wide ? base + ',' : '') + wz(c.effect === 'zin' ? `1+${zoom}*${pz}` : `1+${zoom}*(1-${pz})`);   // zoom in / out
      f.push(`[${k}:v]${chain},setsar=1,format=yuv420p[c${k}]`);
      return;
    }
    // video; klip pertama (visual judul) ditahan di frame terakhir kalau lebih pendek dari durasi judul
    const pre = `fps=${fps}` + (c.first ? `,tpad=stop_mode=clone:stop_duration=${c.dur.toFixed(2)},trim=duration=${c.dur.toFixed(2)},setpts=PTS-STARTPTS` : '');
    if (fit === 'blur') {
      f.push(`[${k}:v]${pre},split[b${k}][g${k}]`);
      f.push(`[b${k}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${sw}:${sh},boxblur=4:2,scale=${W}:${H}[bb${k}]`);
      f.push(`[g${k}]scale=${W}:${H}:force_original_aspect_ratio=decrease[gg${k}]`);
      f.push(`[bb${k}][gg${k}]overlay=x='(main_w-overlay_w)/2':y='(main_h-overlay_h)/2',setsar=1,format=yuv420p[c${k}]`);
    } else {
      f.push(`[${k}:v]${pre},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[c${k}]`);
    }
  });

  let cur = '[c0]';
  for (let k = 1; k < n; k++) {
    f.push(`${cur}[c${k}]xfade=transition=${seq[k].trName}:duration=${seq[k].tr}:offset=${seq[k].start.toFixed(3)}[x${k}]`); cur = `[x${k}]`;
  }

  if (flash) {   // kilatan putih: naik cepat, turun pelan; klip berganti persis di puncaknya
    const t0 = (flash.at - flash.attack).toFixed(3), t1 = (flash.at + flash.decay).toFixed(3);
    const e = `max(0,min((t-${t0})/${flash.attack},1-(t-${flash.at.toFixed(3)})/${flash.decay}))`;
    f.push(`${cur}eq=brightness='${e}':saturation='1-${e}':eval=frame:enable='between(t,${t0},${t1})'[fl]`); cur = '[fl]';
  }

  f.push(`[${n}:v]scale=${Math.round(W * logo.widthPct)}:-1[lg]`);
  f.push(`${cur}[lg]overlay=x='(main_w-overlay_w)/2':y=${Math.round(H * logo.yPct)}[v0]`); cur = '[v0]';
  cues.forEach((c, i) => {
    const yb = Math.round(H * (c.isTitle ? titleBottomPct : subBottomPct));
    f.push(`${cur}[${n + 1 + i}:v]overlay=x=0:y=${yb}-h:enable='gte(t,${c.start.toFixed(3)})*lt(t,${c.end.toFixed(3)})'[o${i}]`); cur = `[o${i}]`;
  });
  f.push(`${cur}format=yuv420p[vout]`);

  const ai = n + 1 + cues.length;
  let aMap = `${ai}:a`;
  const extra = []; let next = ai + 1;
  if (bgmExt) { f.push(`[${next}:a]volume=${bgmVol},afade=t=out:st=${Math.max(0, T - bgmFade).toFixed(2)}:d=${bgmFade}[bg]`); extra.push('[bg]'); next++; }
  if (sfx) { const ms = Math.max(0, Math.round(sfx.at * 1000)); f.push(`[${next}:a]volume=${sfx.volume},adelay=${ms}|${ms},apad[sx]`); extra.push('[sx]'); }
  if (extra.length) {
    const N = extra.length + 1;   // semua input dibuat tak berujung (apad / loop), jadi level VO stabil
    f.push(`[${ai}:a]${extra.join('')}amix=inputs=${N}:duration=first,volume=${N}[aout]`); aMap = '[aout]';
  }

  return [...args, '-filter_complex', f.join(';'), '-map', '[vout]', '-map', aMap,
    '-t', T.toFixed(3), ...vcodec, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4'];
}
