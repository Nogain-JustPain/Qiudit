// Pengenalan suara (Whisper) di browser, jalan di worker supaya halaman tidak macet.
import { pipeline, env } from '@huggingface/transformers';
env.allowLocalModels = false;

let pipe = null, pipeModel = '';
const say = (text) => self.postMessage({ type: 'status', text });

self.onmessage = async (e) => {
  const { audio, model, language } = e.data;
  try {
    if (!pipe || pipeModel !== model) {
      const files = new Map();
      const progress_callback = (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, { l: p.loaded, t: p.total });
        let l = 0, t = 0; for (const v of files.values()) { l += v.l; t += v.t; }
        say(`Mengunduh model Whisper (sekali saja)... ${Math.round((100 * l) / t)}% dari ${(t / 1048576).toFixed(0)} MB`);
      };
      say('Menyiapkan model Whisper...');
      pipe = await pipeline('automatic-speech-recognition', model, { progress_callback });
      pipeModel = model;
    }
    say('Mengenali suara... (beberapa detik sampai menit, tergantung panjang VO)');
    const out = await pipe(audio, { language, task: 'transcribe', return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    const words = (out.chunks || [])
      .map((c) => ({ text: (c.text || '').trim(), start: c.timestamp?.[0], end: c.timestamp?.[1] }))
      .filter((c) => c.text && typeof c.start === 'number')
      .map((c) => ({ ...c, end: typeof c.end === 'number' && c.end > c.start ? c.end : c.start + 0.25 }));
    self.postMessage({ type: 'done', words });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
