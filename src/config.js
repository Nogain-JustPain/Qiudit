// Semua pengaturan template ada di sini
export default {
  photoSeconds: 4,      // durasi tiap foto
  fadeSeconds: 0.5,     // crossfade antar foto
  fps: 25,
  zoomAmount: 0.12,     // seberapa dekat zoom in/out (0.12 = 12%)
  panAmount: 0.18,      // seberapa jauh geser kanan/kiri
  logo: { src: '/logo.png', widthPct: 0.26, yPct: 0.05 },   // logo di tengah atas
  subtitle: {
    font: 'italic 600 {size}px Montserrat',
    size: 32,           // ukuran huruf (px pada lebar 1080, otomatis menyesuaikan resolusi)
    color: '#161616',
    box: '#ffffff',
    maxCharsPerCue: 60, // dipakai saat teks ditempel (tanpa SRT)
    bottomPct: 0.80,    // posisi bawah kotak subtitle (0-1 dari tinggi)
  },
};

export const MUSIC = { volume: 15, fadeOutSeconds: 2 }; // volume awal musik latar (%), fade out di akhir
