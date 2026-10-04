# Tiket QR Event

Website pendaftaran event dengan tiket QR, scanner untuk petugas, dan dashboard admin. Dibuat untuk acara sekitar 300 peserta.

| Halaman | Alamat | Untuk siapa |
| --- | --- | --- |
| Pendaftaran | `/` | Peserta |
| Tiket | `/tiket#kode` | Peserta (muncul otomatis setelah daftar) |
| Dashboard | `/admin` | Admin / panitia |
| Scanner | `/scan` | Petugas pintu masuk |

Fiturnya: form pendaftaran dengan kuota otomatis, tiket QR bertanda tangan digital (QR palsu ditolak), tiket bisa diunduh sebagai gambar, scanner lewat kamera HP atau webcam laptop, tiket ditolak kalau discan dua kali, admin bisa mengubah status tiket jadi sudah/belum discan, reset semua status setelah uji coba, dan export data ke Excel.

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

Semua data tersimpan di satu file `data.db` (SQLite). Untuk backup, cukup salin file itu, misalnya setiap malam:

```bash
cp /var/www/tiket/data.db ~/backup-$(date +%F).db
```

Sebelum masa sewa hosting habis, export data lewat tombol **Export Excel** di dashboard dan simpan salinan `data.db`.

## Mengubah kolom form

Kolom form ada di `public/index.html` (tampilan) dan di bagian `/api/register` pada `server.js` (validasi dan penyimpanan). Kolom bawaan: nama, email, nomor HP, dan instansi/kampus (opsional). Satu email hanya bisa mendaftar sekali.

## Struktur folder

```
server.js          backend: pendaftaran, tiket, login, scan, dashboard, export
public/index.html  halaman pendaftaran
public/tiket.html  halaman tiket + unduh gambar
public/admin.html  login & dashboard admin
public/scan.html   scanner kamera
public/style.css   gaya bersama
.env.example       contoh konfigurasi
```
