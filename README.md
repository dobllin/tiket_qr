# Tiket QR Event

Website pendaftaran event dengan tiket QR, scanner untuk petugas, dan dashboard admin. Dibuat untuk acara sekitar 300 peserta.

Cukup buka satu alamat (halaman pendaftaran). Panitia klik **"Kamu panitia? Masuk di sini"** di bawah form, login, lalu pilih menu **Dashboard**, **Scanner**, atau **Pendaftaran**. Dari dashboard dan scanner ada tombol **← Menu** untuk kembali.

| Halaman | Alamat | Untuk siapa |
| --- | --- | --- |
| Pendaftaran | `/` | Peserta |
| Tiket | `/tiket#kode` | Peserta (muncul otomatis setelah daftar) |
| Menu panitia | `/panitia` | Admin / petugas (setelah login) |
| Dashboard | `/admin` | Admin / panitia |
| Scanner | `/scan` | Petugas pintu masuk |

Fiturnya: form pendaftaran dengan kuota otomatis, tiket QR bertanda tangan digital (QR palsu ditolak), kode cadangan 5 huruf di tiket yang bisa diketik petugas kalau QR tidak terbaca, tiket bisa diunduh sebagai gambar, scanner lewat kamera HP atau webcam laptop, tiket ditolak kalau discan dua kali, admin bisa mengubah status tiket jadi sudah/belum discan, reset semua status setelah uji coba, dan export data ke Excel.

## Menjalankan di komputer sendiri

Butuh Node.js versi 22.13 ke atas (disarankan versi LTS terbaru). Tidak perlu install Visual Studio atau compiler apa pun.

```bash
npm install
cp .env.example .env      # lalu edit isinya
npm start
```

Buka `http://localhost:3000`. Isi `.env` yang wajib diganti:

- `EVENT_NAME`, `EVENT_DATE`, `EVENT_PLACE`, `QUOTA` untuk info acara.
- `EVENT_START` (opsional) jam mulai acara untuk hitung mundur di halaman depan, contoh `2026-11-14T08:00:00+07:00`.
- `ADMIN_ACCOUNTS` untuk akun panitia, format `user:password`, dipisah koma. Semua akun bisa membuka dashboard dan scanner.
- `SECRET` untuk kunci tanda tangan tiket. Buat yang acak dengan perintah di bawah. **Jangan diganti setelah pendaftaran dibuka**, karena semua tiket lama akan jadi tidak valid.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Bukti transfer (acara berbayar)

Atur dua variabel ini di `.env` (atau di Environment Variables Vercel):

- `TICKET_PRICE` harga tiket dalam rupiah, angka saja. Bawaannya `160000` (Rp160.000). Isi `0` kalau acaranya gratis.
- `PAYMENT_INFO` nomor rekening tujuan transfer. Pakai `\n` untuk ganti baris.

Alurnya:

1. Form pendaftaran menampilkan harga, info rekening (dengan tombol salin), dan **wajib upload gambar bukti transfer**. Foto dari HP otomatis dikecilkan (biasanya jadi 100-300 KB) sebelum dikirim.
2. Tiket langsung muncul, dengan keterangan "bukti transfer lagi dicek panitia".
3. Di dashboard, filter **Cek bayar** menampilkan bukti yang belum dicek. Buka **Cek bukti**, cocokkan nominal & tanggal, lalu klik **Terima (lunas)** atau **Tolak**. Setelah menerima, bukti berikutnya langsung terbuka.
4. Kartu pemasukan di dashboard menghitung total uang dari peserta yang lunas, plus jumlah yang menunggu dan ditolak.
5. Tiket yang pembayarannya **ditolak** akan ditolak scanner. Tiket yang belum dicek tetap bisa masuk, tapi scanner memberi tanda peringatan.
6. **Export Excel** berisi kolom nominal, status pembayaran, siapa yang mengecek, dan link **Lihat bukti** ke gambar transfer (buka saat sudah login di browser). Ada juga sheet **Ringkasan** berisi total pemasukan.

## Mencoba scanner di HP

Browser hanya mengizinkan kamera lewat `https://` (kecuali `localhost`). Untuk mencoba dari HP sebelum online, buat tunnel https sementara, misalnya dengan Cloudflare:

```bash
cloudflared tunnel --url http://localhost:3000
```

Buka alamat `https://....trycloudflare.com/scan` yang muncul di HP.

## Alur uji coba sebelum acara

1. Daftarkan beberapa peserta percobaan, atau pakai tiket peserta asli.
2. Login di `/scan` dengan akun petugas, lalu scan tiketnya.
3. Buka `/admin`, lalu klik **Reset semua status** (atau **Jadikan belum** per peserta). Tiket kembali bisa dipakai di hari H.
4. Hapus peserta percobaan dari dashboard kalau tidak dipakai.

## Online gratis di Vercel + Turso

Web jalan di **Vercel**, data peserta disimpan di **Turso** (database SQLite online). Keduanya gratis dan bisa daftar pakai akun GitHub, tanpa kartu kredit. Kode harus sudah ada di GitHub.

**1. Buat database di Turso**

1. Daftar di [turso.tech](https://turso.tech) (login dengan GitHub).
2. Buat database baru, misalnya `tiket`. Pilih lokasi terdekat (Singapore / Tokyo).
3. Salin **URL database** (bentuknya `libsql://tiket-namakamu.turso.io`).
4. Buat **token** untuk database itu, lalu salin.

Tabel dibuat otomatis waktu web pertama kali dibuka, tidak perlu bikin manual.

**2. Deploy di Vercel**

1. Daftar di [vercel.com](https://vercel.com) (login dengan GitHub), klik **Add New → Project**, pilih repo `tiket_qr`.
2. Framework Preset: **Other**. Pengaturan build lain biarkan, sudah diatur di `vercel.json`.
3. Buka **Environment Variables**, isi:

   | Nama | Isi |
   | --- | --- |
   | `TURSO_DATABASE_URL` | URL database dari Turso |
   | `TURSO_AUTH_TOKEN` | token dari Turso |
   | `SECRET` | kunci acak (lihat cara bikin di atas) |
   | `ADMIN_ACCOUNTS` | akun panitia, misalnya `admin:passwordkuat,petugas1:pass1` |
   | `EVENT_NAME`, `EVENT_DATE`, `EVENT_PLACE`, `QUOTA` | info acara |
   | `EVENT_START` | jam mulai untuk hitung mundur (opsional), contoh `2026-11-14T08:00:00+07:00` |
   | `TIMEZONE` | `Asia/Jakarta` |
   | `NODE_ENV` | `production` |

4. Klik **Deploy**. Setelah selesai, web bisa dibuka di alamat `https://namaproject.vercel.app` (sudah https, scanner kamera di HP langsung jalan).

Kalau isi Environment Variables diubah, buka tab **Deployments** lalu **Redeploy** supaya perubahannya dipakai. Vercel memakai branch utama (`main`) untuk alamat utama, jadi pastikan perubahan sudah di-merge ke `main`.

Paket gratis Vercel (Hobby) ditujukan untuk pemakaian pribadi / non-komersial. Untuk acara berbayar atau komersial, cek ketentuan Vercel dulu.

## Online di VPS (Ubuntu)

Contoh untuk VPS Ubuntu dengan domain `namaevent.com` yang sudah diarahkan ke IP VPS.

```bash
# 1. Install Node.js 22, nginx, certbot
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx

# 2. Upload folder project ke /var/www/tiket, lalu
cd /var/www/tiket
npm install --omit=dev
cp .env.example .env && nano .env     # isi data acara, akun, SECRET, NODE_ENV=production

# 3. Jalankan terus-menerus dengan pm2
sudo npm install -g pm2
pm2 start npm --name tiket -- start
pm2 save && pm2 startup
```

Konfigurasi nginx (`/etc/nginx/sites-available/tiket`):

```nginx
server {
    server_name namaevent.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tiket /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d namaevent.com     # pasang https gratis
```

Setelah https aktif, pastikan `NODE_ENV=production` di `.env`, lalu `pm2 restart tiket`.

## Data dan backup

Kalau pakai Vercel + Turso, data ada di Turso. Backup paling gampang lewat tombol **Export Excel** di dashboard.

Kalau jalan di komputer sendiri atau VPS, semua data tersimpan di satu file `data.db` (SQLite). Untuk backup, cukup salin file itu, misalnya setiap malam:

```bash
cp /var/www/tiket/data.db ~/backup-$(date +%F).db
```

Sebelum masa sewa hosting habis, export data lewat tombol **Export Excel** di dashboard dan simpan salinan `data.db`.

## Mengubah kolom form

Kolom form ada di `public/index.html` (tampilan) dan di bagian `/api/register` pada `server.js` (validasi dan penyimpanan). Kolom bawaan: nama, email, nomor HP, dan instansi/kampus (opsional). Satu email hanya bisa mendaftar sekali.

## Tema & logo

Tampilan mengikuti tema **F1 x Fast & Furious** (Y2K, retro, kertas, dominan biru). Warna dan font diatur di bagian atas `public/style.css`. Tagline "RADIANCE: From rising flames to ultimate glory" ada di `public/index.html`.

Logo penyelenggara ada di `public/logos.png` dan tampil di halaman pendaftaran, tiket (termasuk gambar yang diunduh), menu panitia, dan login. Mau logonya lebih tajam? Export ulang deretan logo dari Canva sebagai PNG (latar transparan atau gelap, tinggi minimal 200px), lalu timpa file `public/logos.png` dengan nama yang sama.

## Struktur folder

```
server.js          backend: pendaftaran, tiket, login, scan, dashboard, export
api/index.js       pintu masuk untuk Vercel (memakai server.js)
vercel.json        pengaturan Vercel
public/index.html  halaman pendaftaran
public/tiket.html  halaman tiket + unduh gambar
public/panitia.html menu panitia setelah login
public/admin.html  login & dashboard admin
public/scan.html   scanner kamera
public/style.css   gaya bersama (warna & font tema)
public/logos.png   deretan logo penyelenggara
.env.example       contoh konfigurasi
```
