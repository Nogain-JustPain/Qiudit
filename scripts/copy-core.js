// Salin core ffmpeg.wasm (single-thread) ke public/ supaya di-host sendiri, bukan dari CDN
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('public/ffmpeg', { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm'])
  copyFileSync(`node_modules/@ffmpeg/core/dist/umd/${f}`, `public/ffmpeg/${f}`);
