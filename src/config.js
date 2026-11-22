// Semua pengaturan template ada di sini
export default {
  photoSeconds: 4,      // durasi tiap foto
  fadeSeconds: 0.5,     // crossfade antar foto
  fps: 25,
  logo: { src: '/logo.png', widthPct: 0.42, xPct: 0.05, yPct: 0.045 }, // relatif ke lebar/tinggi video
  subtitle: {
    font: '700 {size}px Montserrat',
    sizePct: 0.046,     // x lebar video (1080 -> ~50px)
    color: '#ffffff',
    box: 'rgba(0,0,0,0.65)',
    maxCharsPerCue: 64, // dipakai saat teks ditempel (tanpa SRT)
    bottomPct: 0.80,    // posisi bawah kotak subtitle (0-1 dari tinggi)
  },
};
