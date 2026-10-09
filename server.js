require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");
const { createClient } = require("@libsql/client"); // SQLite: file lokal atau Turso (online)
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");

// ---------- Konfigurasi (atur lewat file .env) ----------
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SECRET;
const EVENT_NAME = process.env.EVENT_NAME || "Nama Event";
const EVENT_DATE = process.env.EVENT_DATE || "";
const EVENT_PLACE = process.env.EVENT_PLACE || "";
// Jam mulai acara untuk hitung mundur di halaman depan, contoh: 2026-11-14T08:00:00+07:00 (boleh kosong)
const EVENT_START = Number.isNaN(Date.parse(process.env.EVENT_START || "")) ? null : new Date(process.env.EVENT_START).toISOString();
const QUOTA = Number(process.env.QUOTA || 300);
const TIMEZONE = process.env.TIMEZONE || "Asia/Jakarta";
// Info pembayaran (rekening, nominal). Kalau diisi, peserta wajib upload gambar bukti transfer saat daftar,
// dan panitia bisa melihatnya di dashboard.
const PAYMENT_INFO = (process.env.PAYMENT_INFO || "").replace(/\\n/g, "\n").trim();
// Harga tiket dalam rupiah. Isi 0 kalau acaranya gratis (tidak perlu bukti transfer).
const TICKET_PRICE = Math.max(0, Number(process.env.TICKET_PRICE ?? 160000) || 0);
const PAYMENT_REQUIRED = TICKET_PRICE > 0 || Boolean(PAYMENT_INFO);
const PROOF_MAX_BYTES = 2 * 1024 * 1024; // gambar sudah dikecilkan di browser, biasanya cuma 100-300 KB
// Format: user:password,user2:password2
const ACCOUNTS = Object.fromEntries(
  (process.env.ADMIN_ACCOUNTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(":");
      return [s.slice(0, i), s.slice(i + 1)];
    })
);

const runDirect = require.main === module; // dijalankan pakai "npm start", bukan di Vercel
// Di Vercel jangan crash: simpan pesannya, lalu tampilkan lewat /api supaya jelas apa yang kurang
let CONFIG_ERROR = null;
function fail(msg) {
  console.error(msg);
  if (runDirect) process.exit(1);
  CONFIG_ERROR ||= msg;
}
if (!SECRET || SECRET.length < 24) fail("SECRET di .env wajib diisi, minimal 24 karakter.");
if (!Object.keys(ACCOUNTS).length) fail("ADMIN_ACCOUNTS di .env wajib diisi, contoh: admin:passwordku");

// ---------- Database ----------
// Di komputer sendiri / VPS: file data.db. Di Vercel: Turso (isi TURSO_DATABASE_URL & TURSO_AUTH_TOKEN).
const TURSO_URL = process.env.TURSO_DATABASE_URL;
if (process.env.VERCEL && !TURSO_URL) fail("Di Vercel wajib isi TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN.");
const db = createClient(
  TURSO_URL
    ? { url: TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: "file:" + (process.env.DB_PATH || path.join(__dirname, "data.db")) }
);
const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const run = async (sql, args = []) => (await db.execute({ sql, args })).rowsAffected;
const isUnique = (e, col) => /UNIQUE constraint failed/i.test(e.message) && e.message.includes("participants." + col);

// ---------- Kode cadangan 5 karakter (kalau QR tidak bisa discan) ----------
// Tanpa huruf/angka yang mirip (O/0, I/1/L) supaya gampang dibaca & diketik petugas
const SHORT_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SHORT_LEN = 5;
const makeShort = () => Array.from({ length: SHORT_LEN }, () => SHORT_CHARS[crypto.randomInt(SHORT_CHARS.length)]).join("");

async function initDb() {
  if (!TURSO_URL) {
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA busy_timeout = 5000");
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS participants (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone       TEXT NOT NULL,
      institution TEXT,
      created_at  TEXT NOT NULL,
      scanned_at  TEXT,
      scanned_by  TEXT,
      short_code  TEXT
    )
  `);
  // Database lama belum punya kolom kode cadangan -> tambahkan & isi otomatis
  if (!(await all("PRAGMA table_info(participants)")).some((c) => c.name === "short_code")) {
    await db.execute("ALTER TABLE participants ADD COLUMN short_code TEXT");
  }
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_short_code ON participants(short_code)");
  // Gambar bukti transfer disimpan terpisah supaya daftar peserta tetap ringan
  await db.execute(`
    CREATE TABLE IF NOT EXISTS proofs (
      participant_id TEXT PRIMARY KEY,
      mime           TEXT NOT NULL,
      data           BLOB NOT NULL,
      created_at     TEXT NOT NULL
    )
  `);
  // Status pembayaran: pending (bukti belum dicek), paid (lunas), rejected (ditolak). Kosong = tidak perlu bayar.
  const cols = (await all("PRAGMA table_info(participants)")).map((c) => c.name);
  for (const c of ["pay_status", "pay_by", "pay_at"]) {
    if (!cols.includes(c)) await db.execute(`ALTER TABLE participants ADD COLUMN ${c} TEXT`);
  }
  // Peserta lama yang sudah upload bukti tapi belum punya status -> menunggu dicek
  await db.execute("UPDATE participants SET pay_status = 'pending' WHERE pay_status IS NULL AND id IN (SELECT participant_id FROM proofs)");
  for (const { id } of await all("SELECT id FROM participants WHERE short_code IS NULL")) {
    for (;;) {
      try { await run("UPDATE participants SET short_code = ? WHERE id = ?", [makeShort(), id]); break; }
      catch (e) { if (!isUnique(e, "short_code")) throw e; }
    }
  }
}
// Disiapkan sekali; kalau gagal (misal koneksi Turso putus), dicoba lagi di request berikutnya
let ready;
const dbReady = () => (ready ??= initDb().catch((e) => { ready = undefined; throw e; }));

const q = {
  count: async () => (await one("SELECT COUNT(*) AS n FROM participants")).n,
  countScanned: async () => (await one("SELECT COUNT(*) AS n FROM participants WHERE scanned_at IS NOT NULL")).n,
  byId: (id) => one("SELECT * FROM participants WHERE id = ?", [id]),
  byShort: (s) => one("SELECT id FROM participants WHERE short_code = ?", [s]),
  byEmail: (email) => one("SELECT id FROM participants WHERE email = ?", [email]),
  all: () => all(`SELECT p.*, EXISTS (SELECT 1 FROM proofs WHERE participant_id = p.id) AS has_proof
                  FROM participants p ORDER BY p.created_at DESC, p.rowid DESC`),
  // Hanya berhasil kalau tiket belum pernah discan -> aman dari scan dobel bersamaan
  markScanned: (at, by, id) => run("UPDATE participants SET scanned_at = ?, scanned_by = ? WHERE id = ? AND scanned_at IS NULL", [at, by, id]),
  setScanned: (at, by, id) => run("UPDATE participants SET scanned_at = ?, scanned_by = ? WHERE id = ?", [at, by, id]),
  resetOne: (id) => run("UPDATE participants SET scanned_at = NULL, scanned_by = NULL WHERE id = ?", [id]),
  resetAll: () => run("UPDATE participants SET scanned_at = NULL, scanned_by = NULL"),
  setPay: (status, by, at, id) => run("UPDATE participants SET pay_status = ?, pay_by = ?, pay_at = ? WHERE id = ?", [status, by, at, id]),
  remove: async (id) => {
    await db.batch([
      { sql: "DELETE FROM proofs WHERE participant_id = ?", args: [id] },
      { sql: "DELETE FROM participants WHERE id = ?", args: [id] },
    ], "write");
  },
  proof: (id) => one("SELECT mime, data FROM proofs WHERE participant_id = ?", [id]),
};

// Waktu lokal acara, format "2026-11-14 19:05:12"
const fmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const now = () => fmt.format(new Date());

// Cek kuota & simpan dalam satu perintah supaya kuota tidak jebol saat banyak yang daftar bersamaan
const DUPLICATE = { error: "Email ini sudah terdaftar. Hubungi panitia kalau tiketmu hilang.", status: 409 };
async function registerTx(p, proof) {
  if (await q.byEmail(p.email)) return DUPLICATE;
  for (;;) {
    p.short_code = makeShort();
    try {
      // Peserta & bukti transfer disimpan bersamaan: dua-duanya masuk, atau tidak sama sekali
      const steps = [{
        sql: `INSERT INTO participants (id, short_code, name, email, phone, institution, created_at, pay_status)
              SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM participants) < ?`,
        args: [p.id, p.short_code, p.name, p.email, p.phone, p.institution, p.created_at, proof ? "pending" : null, QUOTA],
      }];
      if (proof) steps.push({
        sql: "INSERT INTO proofs (participant_id, mime, data, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM participants WHERE id = ?)",
        args: [p.id, proof.mime, proof.data, p.created_at, p.id],
      });
      const [added] = await db.batch(steps, "write");
      return added.rowsAffected ? { ok: true } : { error: "Kuota pendaftaran sudah penuh.", status: 409 };
    } catch (e) {
      if (isUnique(e, "email")) return DUPLICATE;
      if (!isUnique(e, "short_code")) throw e; // kode cadangan kebetulan sama -> coba kode lain
    }
  }
}

// ---------- Kode tiket ----------
const sign = (id) => crypto.createHmac("sha256", SECRET).update(id).digest("base64url").slice(0, 16);
const makeCode = (id) => `${id}.${sign(id)}`;
function parseCode(code) {
  const [id, sig] = String(code || "").trim().split(".");
  if (!id || !sig) return null;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return id;
}

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
// Pendaftaran boleh lebih besar karena membawa gambar bukti transfer
const smallJson = express.json({ limit: "20kb" });
const bigJson = express.json({ limit: "4mb" });
app.use((req, res, next) => (req.path === "/api/register" ? bigJson : smallJson)(req, res, next));
app.use(
  cookieSession({
    name: "sesi",
    keys: [SECRET || "belum-diisi"],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  })
);
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.use("/api", async (req, res, next) => {
  if (CONFIG_ERROR) return res.status(500).json({ error: CONFIG_ERROR + " (cek Environment Variables di Vercel, lalu Redeploy)" });
  try {
    await dbReady();
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal konek ke database Turso: " + e.message });
  }
});

const auth = (req, res, next) =>
  req.session && req.session.user ? next() : res.status(401).json({ error: "Silakan login dulu." });

const clean = (v, max = 120) => String(v || "").trim().slice(0, max);

// Info acara (dipakai halaman depan)
app.get("/api/event", async (req, res) => {
  const used = await q.count();
  res.json({
    name: EVENT_NAME, date: EVENT_DATE, place: EVENT_PLACE, start: EVENT_START, quota: QUOTA, remaining: Math.max(0, QUOTA - used),
    payment: { required: PAYMENT_REQUIRED, info: PAYMENT_INFO, price: TICKET_PRICE },
  });
});

// Pendaftaran
app.post("/api/register", async (req, res) => {
  const p = {
    id: crypto.randomBytes(9).toString("base64url"),
    name: clean(req.body.name, 80),
    email: clean(req.body.email, 120).toLowerCase(),
    phone: clean(req.body.phone, 20).replace(/[^\d+]/g, ""),
    institution: clean(req.body.institution, 100) || null,
    created_at: now(),
  };
  if (p.name.length < 2) return res.status(400).json({ error: "Nama wajib diisi." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return res.status(400).json({ error: "Format email tidak valid." });
  if (p.phone.length < 9) return res.status(400).json({ error: "Nomor HP tidak valid." });

  let proof = null;
  if (PAYMENT_REQUIRED) {
    proof = readProof(req.body.proof);
    if (!proof) return res.status(400).json({ error: "Upload gambar bukti transfer dulu (JPG/PNG, maksimal 2 MB)." });
  }

  const r = await registerTx(p, proof);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ code: makeCode(p.id) });
});

// Gambar bukti transfer dikirim sebagai data URL ("data:image/jpeg;base64,...").
// Dicek isi filenya beneran gambar, bukan cuma namanya.
function readProof(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > PROOF_MAX_BYTES) return null;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.subarray(0, 4).toString("hex") === "89504e47";
  const isWebp = buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
  if (!isJpeg && !isPng && !isWebp) return null;
  return { mime: isJpeg ? "image/jpeg" : isPng ? "image/png" : "image/webp", data: buf };
}

// Data tiket (untuk halaman tiket peserta)
app.get("/api/ticket", async (req, res) => {
  const id = parseCode(req.query.code);
  const p = id && (await q.byId(id));
  if (!p) return res.status(404).json({ error: "Tiket tidak ditemukan." });
  const qr = await QRCode.toDataURL(makeCode(p.id), { width: 600, margin: 1, errorCorrectionLevel: "M" });
  res.json({
    name: p.name,
    institution: p.institution,
    ticketNo: p.short_code,
    payStatus: p.pay_status,
    event: { name: EVENT_NAME, date: EVENT_DATE, place: EVENT_PLACE },
    qr,
  });
});

// ---------- Login admin / petugas ----------
const fails = new Map(); // ip -> {n, until}
app.post("/api/login", (req, res) => {
  const ip = req.ip;
  const f = fails.get(ip);
  if (f && f.n >= 8 && Date.now() < f.until)
    return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi 15 menit lagi." });

  const user = clean(req.body.username, 40);
  const pass = String(req.body.password || "");
  const real = ACCOUNTS[user];
  const ok =
    real !== undefined &&
    real.length === pass.length &&
    crypto.timingSafeEqual(Buffer.from(real), Buffer.from(pass));
  if (!ok) {
    const n = (f && Date.now() < f.until ? f.n : 0) + 1;
    fails.set(ip, { n, until: Date.now() + 15 * 60 * 1000 });
    return res.status(401).json({ error: "Username atau password salah." });
  }
  fails.delete(ip);
  req.session.user = user;
  res.json({ user });
});
app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});
app.get("/api/me", (req, res) => res.json({ user: (req.session && req.session.user) || null }));

// ---------- Scan ----------
// Kode cadangan yang diketik petugas, misalnya "K7PXM" (huruf kecil, spasi & strip diabaikan).
// Hanya diterima di scanner (wajib login), bukan di halaman tiket publik.
async function parseShort(code) {
  const s = String(code || "").toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== SHORT_LEN || ![...s].every((c) => SHORT_CHARS.includes(c))) return undefined;
  const row = await q.byShort(s);
  return row ? row.id : null;
}

app.post("/api/scan", auth, async (req, res) => {
  const short = await parseShort(req.body.code);
  if (short === null) return res.json({ status: "invalid", message: "Kode tiket tidak terdaftar." });
  const id = short || parseCode(req.body.code);
  if (!id) return res.json({ status: "invalid", message: "QR tidak dikenali / palsu." });
  const p = await q.byId(id);
  if (!p) return res.json({ status: "invalid", message: "Tiket tidak terdaftar." });
  if (p.pay_status === "rejected")
    return res.json({ status: "invalid", message: `${p.name}: pembayaran ditolak panitia. Arahkan ke meja registrasi.` });

  const changed = await q.markScanned(now(), req.session.user, id);
  if (!changed) {
    const again = await q.byId(id);
    return res.json({
      status: "used",
      message: "Tiket sudah dipakai.",
      participant: { name: again.name, institution: again.institution, scannedAt: again.scanned_at, scannedBy: again.scanned_by },
    });
  }
  const row = await q.byId(id);
  res.json({
    status: "ok",
    message: "Silakan masuk.",
    participant: { name: row.name, institution: row.institution, scannedAt: row.scanned_at, payStatus: row.pay_status },
  });
});

// ---------- Dashboard admin ----------
app.get("/api/participants", auth, async (req, res) => {
  const rows = (await q.all()).map((p) => ({
    id: p.id,
    code: makeCode(p.id),
    short: p.short_code,
    name: p.name,
    email: p.email,
    phone: p.phone,
    institution: p.institution,
    createdAt: p.created_at,
    scannedAt: p.scanned_at,
    scannedBy: p.scanned_by,
    hasProof: Boolean(p.has_proof),
    payStatus: p.pay_status,
    payBy: p.pay_by,
    payAt: p.pay_at,
  }));
  const count = (st) => rows.filter((r) => r.payStatus === st).length;
  const payment = {
    required: PAYMENT_REQUIRED, price: TICKET_PRICE,
    paid: count("paid"), pending: count("pending"), rejected: count("rejected"),
  };
  payment.revenue = payment.paid * TICKET_PRICE;
  res.json({ quota: QUOTA, total: rows.length, scanned: await q.countScanned(), payment, rows });
});

app.post("/api/participants/:id/status", auth, async (req, res) => {
  if (!(await q.byId(req.params.id))) return res.status(404).json({ error: "Peserta tidak ditemukan." });
  if (req.body.scanned) await q.setScanned(now(), req.session.user + " (manual)", req.params.id);
  else await q.resetOne(req.params.id);
  res.json({ ok: true });
});

// Verifikasi bukti transfer oleh panitia
app.post("/api/participants/:id/payment", auth, async (req, res) => {
  const status = String(req.body.status || "");
  if (!["paid", "rejected", "pending"].includes(status)) return res.status(400).json({ error: "Status pembayaran tidak dikenal." });
  if (!(await q.byId(req.params.id))) return res.status(404).json({ error: "Peserta tidak ditemukan." });
  const done = status !== "pending";
  await q.setPay(status, done ? req.session.user : null, done ? now() : null, req.params.id);
  res.json({ ok: true });
});

app.get("/api/proof/:id", auth, async (req, res) => {
  const f = await q.proof(req.params.id);
  if (!f) return res.status(404).json({ error: "Bukti transfer tidak ada." });
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(Buffer.from(f.data));
});

app.post("/api/participants/reset-all", auth, async (req, res) => {
  const n = await q.resetAll();
  res.json({ ok: true, reset: n });
});

app.delete("/api/participants/:id", auth, async (req, res) => {
  await q.remove(req.params.id);
  res.json({ ok: true });
});

app.get("/api/export.xlsx", auth, async (req, res) => {
  const PAY_LABEL = { paid: "Lunas", pending: "Menunggu cek", rejected: "Ditolak" };
  const base = `${req.protocol}://${req.get("host")}`;
  const list = (await q.all()).reverse();
  const head = (ws, last) => {
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF26324C" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (last) ws.autoFilter = { from: "A1", to: last + "1" };
  };

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Peserta");
  ws.columns = [
    { header: "No", key: "no", width: 6 },
    { header: "Kode Tiket", key: "ticket", width: 12 },
    { header: "Nama", key: "name", width: 28 },
    { header: "Email", key: "email", width: 30 },
    { header: "No. HP", key: "phone", width: 16 },
    { header: "Instansi / Kampus", key: "institution", width: 26 },
    { header: "Waktu Daftar", key: "created", width: 20 },
    { header: "Nominal", key: "price", width: 14 },
    { header: "Status Pembayaran", key: "pay", width: 18 },
    { header: "Dicek Oleh", key: "payBy", width: 16 },
    { header: "Waktu Dicek", key: "payAt", width: 20 },
    { header: "Bukti Transfer", key: "proof", width: 16 },
    { header: "Status Masuk", key: "status", width: 14 },
    { header: "Waktu Masuk", key: "scanned", width: 20 },
    { header: "Discan Oleh", key: "by", width: 18 },
  ];
  list.forEach((p, i) => {
    const row = ws.addRow({
      no: i + 1,
      ticket: p.short_code,
      name: p.name,
      email: p.email,
      phone: p.phone,
      institution: p.institution || "",
      created: p.created_at,
      price: p.pay_status ? TICKET_PRICE : "",
      pay: PAY_LABEL[p.pay_status] || "-",
      payBy: p.pay_by || "",
      payAt: p.pay_at || "",
      proof: p.has_proof ? { text: "Lihat bukti", hyperlink: `${base}/api/proof/${encodeURIComponent(p.id)}` } : "-",
      status: p.scanned_at ? "Sudah masuk" : "Belum",
      scanned: p.scanned_at || "",
      by: p.scanned_by || "",
    });
    if (p.has_proof) row.getCell("proof").font = { color: { argb: "FF2B5BD7" }, underline: true };
    const color = { paid: "FFE1F3EA", pending: "FFFFF1D6", rejected: "FFFDE2E2" }[p.pay_status];
    if (color) row.getCell("pay").fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  });
  ws.getColumn("price").numFmt = '"Rp"#,##0';
  head(ws, "O");

  // Ringkasan pembayaran
  const sum = wb.addWorksheet("Ringkasan");
  sum.columns = [{ header: "Keterangan", key: "k", width: 30 }, { header: "Jumlah", key: "v", width: 20 }];
  const n = (st) => list.filter((p) => p.pay_status === st).length;
  [
    ["Harga tiket", TICKET_PRICE, true],
    ["Total pendaftar", list.length],
    ["Lunas", n("paid")],
    ["Menunggu cek bukti", n("pending")],
    ["Ditolak", n("rejected")],
    ["Total pemasukan (lunas)", n("paid") * TICKET_PRICE, true],
    ["Potensi pemasukan (lunas + menunggu)", (n("paid") + n("pending")) * TICKET_PRICE, true],
    ["Sudah masuk venue", list.filter((p) => p.scanned_at).length],
    ["Diekspor pada", now()],
  ].forEach(([k, v, money]) => {
    const r = sum.addRow({ k, v });
    if (money) r.getCell("v").numFmt = '"Rp"#,##0';
  });
  head(sum);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="peserta-${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// Di Vercel, file ini dipakai lewat api/index.js; di komputer sendiri / VPS dijalankan langsung
module.exports = app;
if (runDirect) {
  dbReady().then(() =>
    app.listen(PORT, () => {
      console.log(`Server jalan, buka http://localhost:${PORT}`);
      console.log(`Panitia: klik "Kamu panitia? Masuk di sini" di bawah form untuk ke dashboard & scanner.`);
    })
  ).catch((e) => fail("Gagal membuka database: " + e.message));
}
