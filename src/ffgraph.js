// Menyusun perintah ffmpeg (dipisah supaya bisa dites di luar browser)
// seq = daftar klip berurutan: { kind:'photo'|'video', file, dur, m } (m = nomor pola gerak foto)
export function buildArgs({ W, H, F, fps, seq, cues, ext, T, logo, subBottomPct, zoom, pan, motion, fit = 'crop', bgmExt, bgmVol = 0.15, bgmFade = 2 }) {
  const n = seq.length, args = [];
  for (const c of seq) {
    if (c.kind === 'photo') args.push('-loop', '1', '-framerate', String(fps), '-t', String(c.dur), '-i', c.file);
    else args.push('-t', c.dur.toFixed(2), '-i', c.file);
  }
  args.push('-i', 'logo.png');
  cues.forEach((_, i) => args.push('-i', `s${i}.png`));
  args.push('-i', `vo.${ext}`);
  if (bgmExt) args.push('-stream_loop', '-1', '-i', `bgm.${bgmExt}`);

  const f = [];
  const wz = (e, N) => `scale=w='${W}*(${e})':h='${H}*(${e})':eval=frame:flags=bicubic,crop=${W}:${H}:'(iw-ow)/2':'(ih-oh)/2'`;
  const wp = (e) => `scale=${Math.round(W * (1 + pan))}:${Math.round(H * (1 + pan))}:flags=bicubic,crop=${W}:${H}:'(iw-ow)*(${e})':'(ih-oh)/2'`;
  const sw = Math.round(W / 6 / 2) * 2, sh = Math.round(H / 6 / 2) * 2;

  seq.forEach((c, k) => {
    if (c.kind === 'photo') {
      const p = `n/${Math.round(c.dur * fps)}`;
      let chain = `scale=${W}:${H}`;
      if (motion) chain = [wz(`1+${zoom}*${p}`), wp(p), wz(`1+${zoom}*(1-${p})`), wp(`1-${p}`)][c.m % 4];
      f.push(`[${k}:v]${chain},setsar=1,format=yuv420p[c${k}]`);
    } else if (fit === 'blur') {
      f.push(`[${k}:v]fps=${fps},split[b${k}][g${k}]`);
      f.push(`[b${k}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${sw}:${sh},boxblur=4:2,scale=${W}:${H}[bb${k}]`);
      f.push(`[g${k}]scale=${W}:${H}:force_original_aspect_ratio=decrease[gg${k}]`);
      f.push(`[bb${k}][gg${k}]overlay=x='(main_w-overlay_w)/2':y='(main_h-overlay_h)/2',setsar=1,format=yuv420p[c${k}]`);
    } else {
      f.push(`[${k}:v]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[c${k}]`);
    }
  });

  let cur = '[c0]', cum = 0;
  for (let k = 1; k < n; k++) {
    cum += seq[k - 1].dur;
    f.push(`${cur}[c${k}]xfade=transition=fade:duration=${F}:offset=${(cum - k * F).toFixed(3)}[x${k}]`); cur = `[x${k}]`;
  }

  f.push(`[${n}:v]scale=${Math.round(W * logo.widthPct)}:-1[lg]`);
  f.push(`${cur}[lg]overlay=x='(main_w-overlay_w)/2':y=${Math.round(H * logo.yPct)}[v0]`); cur = '[v0]';
  const yb = Math.round(H * subBottomPct);
  cues.forEach((c, i) => {
    f.push(`${cur}[${n + 1 + i}:v]overlay=x=0:y=${yb}-h:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[o${i}]`); cur = `[o${i}]`;
  });
  f.push(`${cur}format=yuv420p[vout]`);

  const ai = n + 1 + cues.length;
  let aMap = `${ai}:a`;
  if (bgmExt) {
    f.push(`[${ai + 1}:a]volume=${bgmVol},afade=t=out:st=${Math.max(0, T - bgmFade).toFixed(2)}:d=${bgmFade}[bg]`);
    f.push(`[${ai}:a][bg]amix=inputs=2:duration=first,volume=2[aout]`);
    aMap = '[aout]';
  }

  return [...args, '-filter_complex', f.join(';'), '-map', '[vout]', '-map', aMap,
    '-t', T.toFixed(3), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4'];
}
