// Menyusun perintah ffmpeg (dipisah supaya bisa dites di luar browser)
export function buildArgs({ W, H, D, F, fps, n, nPhotos, cues, ext, T, logo, subBottomPct, zoom, pan, motion }) {
  const N = Math.round(D * fps);
  const args = [];
  for (let k = 0; k < n; k++) args.push('-loop', '1', '-framerate', String(fps), '-t', String(D), '-i', `p${k % nPhotos}.jpg`);
  args.push('-i', 'logo.png');
  cues.forEach((_, i) => args.push('-i', `s${i}.png`));
  args.push('-i', `vo.${ext}`);

  const f = [], p = `n/${N}`;
  const wz = (e) => `scale=w='${W}*(${e})':h='${H}*(${e})':eval=frame:flags=bicubic,crop=${W}:${H}:'(iw-ow)/2':'(ih-oh)/2'`;
  const wp = (e) => `scale=${Math.round(W * (1 + pan))}:${Math.round(H * (1 + pan))}:flags=bicubic,crop=${W}:${H}:'(iw-ow)*(${e})':'(ih-oh)/2'`;
  for (let k = 0; k < n; k++) {
    let chain = `scale=${W}:${H}`;
    if (motion) chain = [wz(`1+${zoom}*${p}`), wp(p), wz(`1+${zoom}*(1-${p})`), wp(`1-${p}`)][k % 4];
    f.push(`[${k}:v]${chain},setsar=1,format=yuv420p[c${k}]`);
  }
  let cur = '[c0]';
  for (let k = 1; k < n; k++) { f.push(`${cur}[c${k}]xfade=transition=fade:duration=${F}:offset=${(k * (D - F)).toFixed(3)}[x${k}]`); cur = `[x${k}]`; }

  f.push(`[${n}:v]scale=${Math.round(W * logo.widthPct)}:-1[lg]`);
  f.push(`${cur}[lg]overlay=x='(main_w-overlay_w)/2':y=${Math.round(H * logo.yPct)}[v0]`); cur = '[v0]';
  const yb = Math.round(H * subBottomPct);
  cues.forEach((c, i) => {
    f.push(`${cur}[${n + 1 + i}:v]overlay=x=0:y=${yb}-h:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[o${i}]`); cur = `[o${i}]`;
  });
  f.push(`${cur}format=yuv420p[vout]`);

  return [...args, '-filter_complex', f.join(';'), '-map', '[vout]', '-map', `${n + 1 + cues.length}:a`,
    '-t', T.toFixed(3), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4'];
}
