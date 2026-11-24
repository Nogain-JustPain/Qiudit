// Semua pengaturan template ada di sini
export default {
  photoSeconds: 4,      // durasi tiap foto
  fadeSeconds: 0.5,     // crossfade antar foto
  fps: 25,
  zoomAmount: 0.12,     // foto portrait: seberapa dekat zoom in/out (0.12 = 12%)
  panSpeedPct: 0.28,    // foto landscape: kecepatan geser (x lebar video per detik)
  panMaxSeconds: 8,     // foto landscape: durasi maksimal supaya satu foto tidak kelamaan
  title: { size: 52, color: '#ffffff', box: '#e8432a', bottomPct: 0.74 },      // judul di awal (gaya kotak merah)
  flash: { attack: 0.08, decay: 0.45, cutSeconds: 0.12 },                        // flash kamera di akhir judul
  titleTransition: { name: 'slideleft', seconds: 0.6 },                         // transisi dari judul ke isi berita
  logo: { src: '/logo.png', widthPct: 0.26, yPct: 0.08 },   // logo di tengah atas
  subtitle: {
    font: 'italic 600 {size}px Montserrat',
    size: 32,           // ukuran huruf (px pada lebar 1080, otomatis menyesuaikan resolusi)
    color: '#161616',
    box: '#ffffff',
    maxCharsPerCue: 70, // dipakai saat teks ditempel (tanpa SRT)
    bottomPct: 0.77,    // posisi bawah kotak subtitle (0-1 dari tinggi)
  },
};

export const MUSIC = { volume: 15, fadeOutSeconds: 2 }; // volume awal musik latar (%), fade out di akhir
