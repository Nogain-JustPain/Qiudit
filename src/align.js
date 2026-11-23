// Sinkron naskah ke audio VO lewat jeda napas (tanpa AI, tanpa download).
// Fungsi murni (tanpa API browser) supaya bisa dites di Node.

// ---- 1. Teks -> unit subtitle, tiap unit tahu "kekuatan" jeda setelahnya ----
// strength: 3 = akhir paragraf, 2 = akhir kalimat, 1 = koma/titik koma, 0 = potongan di tengah kalimat
export function textUnits(text, withTitle, max = 60) {
  const paras = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const units = []; let body = paras;
  if (withTitle && paras.length > 1) { units.push({ text: paras[0], isTitle: true, strength: 3 }); body = paras.slice(1); }
  for (const para of body) {
    for (const sent of para.match(/[^.!?]+[.!?]*/g) || []) {
      let cur = '';
      for (const w of sent.trim().split(/\s+/)) {
        if (cur && (cur + ' ' + w).length > max) { units.push({ text: cur }); cur = ''; }
        cur = cur ? cur + ' ' + w : w;
      }
      if (cur) units.push({ text: cur });
    }
    units[units.length - 1].paraEnd = true;
  }
  for (const u of units) {
    if (u.strength === 3) continue;
    u.strength = u.paraEnd ? 3 : /[.!?]$/.test(u.text) ? 2 : /[,;:]$/.test(u.text) ? 1 : 0;
  }
  return units;
}

// ---- 2. Audio -> rentang suara + daftar jeda ----
export function analyze(data, sr, mult = 0.07) {
  const win = Math.max(1, Math.round(sr * 0.02)), n = Math.floor(data.length / win), env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * win; j < (i + 1) * win; j++) s += data[j] * data[j]; env[i] = Math.sqrt(s / win); }
  const sorted = Float32Array.from(env).sort();
  const p95 = sorted[Math.floor(n * 0.95)] || 0, thr = Math.max(0.002, p95 * mult), dt = win / sr;
  let a = 0; while (a < n && env[a] < thr) a++;
  let b = n - 1; while (b > a && env[b] < thr) b--;
  const speech = a < b ? [Math.max(0, a * dt - 0.05), (b + 1) * dt] : [0, data.length / sr];
  const pauses = [];
  for (let i = a; i <= b;) {
    if (env[i] < thr) {
      let j = i; while (j <= b && env[j] < thr) j++;
      const dur = (j - i) * dt;
      if (dur >= 0.14) pauses.push({ start: i * dt, end: j * dt, dur, mid: ((i + j) * dt) / 2 });
      i = j;
    } else i++;
  }
  return { duration: data.length / sr, speech, pauses, env, dt, p95 };
}

const wtOf = (u) => u.text.length + (u.strength === 3 ? 20 : u.strength === 2 ? 14 : u.strength === 1 ? 7 : 0);

// Cadangan tanpa jeda: bagi proporsional berdasarkan panjang teks
export function fallbackCues(units, s, e, titleSec = 0) {
  if (!units.length) return [];
  const out = []; let t = s, rest = units;
  if (units[0].isTitle && titleSec > 0 && units.length > 1) { out.push({ text: units[0].text, isTitle: true, start: s, end: s + titleSec }); t = s + titleSec; rest = units.slice(1); }
  const total = rest.reduce((a, u) => a + wtOf(u), 0) || 1, span = e - t;
  for (const u of rest) { const d = (span * wtOf(u)) / total; out.push({ text: u.text, ...(u.isTitle ? { isTitle: true } : {}), start: t, end: t + d }); t += d; }
  return out;
}

// ---- 3. Cocokkan batas teks dengan jeda audio (urutan terjaga, DP) ----
export function alignUnits(units, speech, pauses, titleSec = 0) {
  const n = units.length; let [s, e] = speech;
  if (!n) return { cues: [], cost: 0, matched: 0, total: 0 };
  if (units[0].isTitle && titleSec > 0 && n > 1) {
    const ts = s + titleSec, r = alignUnits(units.slice(1), [ts, e], pauses.filter((p) => p.mid > ts + 0.3), 0);
    return { ...r, cues: [{ text: units[0].text, isTitle: true, start: s, end: ts }, ...r.cues] };
  }
    const bidx = []; for (let k = 0; k < n - 1; k++) if (units[k].strength >= 1) bidx.push(k);
  const NEED = { 3: 0.45, 2: 0.3, 1: 0.14 }, SKIP = 2.5, m = bidx.length, q = pauses.length;

  // Waktu akhir tiap unit. Di antara dua jangkar (jeda yang sudah cocok), durasi jeda terukur dikeluarkan,
  // lalu sisa waktu bicara dibagi menurut panjang teks. Batas tanpa jeda dianggap punya jeda perkiraan kecil.
  const bonus = (u) => (u.strength === 3 ? 20 : u.strength === 2 ? 14 : u.strength === 1 ? 7 : 0);
  const interp = (anchors) => {
    const T = new Float64Array(n), keys = [...anchors.keys()].sort((x, y) => x - y);
    let a = -1;
    for (const b of [...keys, n - 1]) {
      const ta = a < 0 ? s : anchors.get(a).end;
      let tb = b === n - 1 ? e : anchors.get(b).start; if (tb <= ta) tb = ta + 0.01;
      let total = 0; for (let u = a + 1; u <= b; u++) total += units[u].text.length + (u < b ? bonus(units[u]) : 0);
      let c = 0;
      for (let u = a + 1; u < b; u++) { c += units[u].text.length; T[u] = ta + ((tb - ta) * (c + bonus(units[u]) / 2)) / (total || 1); c += bonus(units[u]); }
      T[b] = b === n - 1 ? e : anchors.get(b).mid;
      a = b;
    }
    return T;
  };
  const run = (est, sigma) => {
    const W = q + 1, dp = new Float64Array((m + 1) * W), ch = new Int8Array((m + 1) * W);
    for (let i = 1; i <= m; i++) dp[i * W] = i * SKIP;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= q; j++) {
      const k = bidx[i - 1], p = pauses[j - 1], need = NEED[units[k].strength];
      const cost = Math.abs(p.mid - est[k]) / sigma + (Math.max(0, need - p.dur) / need) * 2 - (units[k].strength >= 2 ? 0.4 * Math.min(1, p.dur / 0.8) : 0);
      let best = dp[i * W + j - 1], c = 1;                       // jeda ini tidak dipakai
      const skip = dp[(i - 1) * W + j] + SKIP; if (skip < best) { best = skip; c = 2; }   // batas teks tanpa jeda
      const mt = dp[(i - 1) * W + j - 1] + cost; if (mt < best) { best = mt; c = 3; }    // cocok
      dp[i * W + j] = best; ch[i * W + j] = c;
    }
    const anchors = new Map(); let i = m, j = q;
    while (i > 0 && j >= 0) {
      if (j === 0) { i--; continue; }
      const c = ch[i * W + j];
      if (c === 3) { anchors.set(bidx[i - 1], pauses[j - 1]); i--; j--; } else if (c === 2) i--; else j--;
    }
    return { anchors, cost: dp[m * W + q] };
  };

  const est0 = interp(new Map());
  const p1 = run(est0, Math.max(1.2, 0.06 * (e - s)));          // putaran 1: toleransi lebar
  const p2 = run(interp(p1.anchors), 0.7);                      // putaran 2: perkiraan sudah dikoreksi jangkar
  const T = interp(p2.anchors), cues = [];
  for (let k = 0; k < n; k++) cues.push({ text: units[k].text, ...(units[k].isTitle ? { isTitle: true } : {}), start: k ? T[k - 1] : s, end: k < n - 1 ? T[k] : e });
  return { cues, cost: p2.cost, matched: p2.anchors.size, total: m };
}

// Coba beberapa ambang sunyi, pilih yang paling cocok dengan teks
export function autoCues(data, sr, units, titleSec = 0) {
  let best = null;
  for (const mult of [0.07, 0.12, 0.2]) {
    const a = analyze(data, sr, mult);
    if (a.pauses.length < 1 && best) continue;
    const r = alignUnits(units, a.speech, a.pauses, titleSec);
    const score = r.cost / Math.max(1, r.total);
    if (!best || score < best.score) best = { ...r, score, analysis: a };
  }
  return best || { cues: [], matched: 0, total: 0, score: 0 };
}
