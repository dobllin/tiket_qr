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
- `ADMIN_ACCOUNTS` untuk akun panitia, format `user:password`, dipisah koma. Semua akun bisa membuka dashboard dan scanner.
- `SECRET` untuk kunci tanda tangan tiket. Buat yang acak dengan perintah di bawah. **Jangan diganti setelah pendaftaran dibuka**, karena semua tiket lama akan jadi tidak valid.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Bukti transfer (acara berbayar)

Isi `PAYMENT_INFO` di `.env` (atau di Environment Variables Vercel) dengan nomor rekening dan nominal. Begitu diisi:

1. Form pendaftaran menampilkan info pembayaran dan **wajib upload gambar bukti transfer**. Foto dari HP otomatis dikecilkan (biasanya jadi 100-300 KB) sebelum dikirim.
2. Tiket langsung muncul seperti biasa.
3. Panitia bisa melihat gambarnya di dashboard lewat tombol **Lihat bukti**. Kalau buktinya tidak sesuai, peserta bisa dihapus dari dashboard.

Kosongkan `PAYMENT_INFO` kalau acaranya gratis; form kembali tanpa upload.

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
public/style.css   gaya bersama
.env.example       contoh konfigurasi
```
