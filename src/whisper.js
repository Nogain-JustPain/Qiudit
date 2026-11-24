// Penghubung ke worker Whisper
let worker = null;
export function transcribeWords(audio16k, { model, language, onStatus }) {
  return new Promise((resolve, reject) => {
    worker ??= new Worker(new URL('./whisper.worker.js', import.meta.url), { type: 'module' });
    const w = worker;
    const fail = (err) => { w.terminate(); if (worker === w) worker = null; reject(err); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') onStatus(m.text);
      else if (m.type === 'done') resolve(m.words);
      else if (m.type === 'error') fail(new Error(m.message));
    };
    w.onerror = (e) => fail(new Error(e.message || 'Worker Whisper gagal dimuat'));
    w.postMessage({ audio: audio16k, model, language }, [audio16k.buffer]);
  });
}
