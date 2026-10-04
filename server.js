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
const QUOTA = Number(process.env.QUOTA || 300);
const TIMEZONE = process.env.TIMEZONE || "Asia/Jakarta";
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
  all: () => all("SELECT * FROM participants ORDER BY created_at DESC, rowid DESC"),
  // Hanya berhasil kalau tiket belum pernah discan -> aman dari scan dobel bersamaan
  markScanned: (at, by, id) => run("UPDATE participants SET scanned_at = ?, scanned_by = ? WHERE id = ? AND scanned_at IS NULL", [at, by, id]),
  setScanned: (at, by, id) => run("UPDATE participants SET scanned_at = ?, scanned_by = ? WHERE id = ?", [at, by, id]),
  resetOne: (id) => run("UPDATE participants SET scanned_at = NULL, scanned_by = NULL WHERE id = ?", [id]),
  resetAll: () => run("UPDATE participants SET scanned_at = NULL, scanned_by = NULL"),
  remove: (id) => run("DELETE FROM participants WHERE id = ?", [id]),
};

// Waktu lokal acara, format "2026-11-14 19:05:12"
const fmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const now = () => fmt.format(new Date());

// Cek kuota & simpan dalam satu perintah supaya kuota tidak jebol saat banyak yang daftar bersamaan
const DUPLICATE = { error: "Email ini sudah terdaftar. Hubungi panitia kalau tiketmu hilang.", status: 409 };
async function registerTx(p) {
  if (await q.byEmail(p.email)) return DUPLICATE;
  for (;;) {
    p.short_code = makeShort();
    try {
      const added = await run(
        `INSERT INTO participants (id, short_code, name, email, phone, institution, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM participants) < ?`,
        [p.id, p.short_code, p.name, p.email, p.phone, p.institution, p.created_at, QUOTA]
      );
      return added ? { ok: true } : { error: "Kuota pendaftaran sudah penuh.", status: 409 };
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
app.use(express.json({ limit: "20kb" }));
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
  res.json({ name: EVENT_NAME, date: EVENT_DATE, place: EVENT_PLACE, quota: QUOTA, remaining: Math.max(0, QUOTA - used) });
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

  const r = await registerTx(p);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ code: makeCode(p.id) });
});

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
    participant: { name: row.name, institution: row.institution, scannedAt: row.scanned_at },
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
  }));
  res.json({ quota: QUOTA, total: rows.length, scanned: await q.countScanned(), rows });
});

app.post("/api/participants/:id/status", auth, async (req, res) => {
  if (!(await q.byId(req.params.id))) return res.status(404).json({ error: "Peserta tidak ditemukan." });
  if (req.body.scanned) await q.setScanned(now(), req.session.user + " (manual)", req.params.id);
  else await q.resetOne(req.params.id);
  res.json({ ok: true });
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
    { header: "Status", key: "status", width: 14 },
    { header: "Waktu Masuk", key: "scanned", width: 20 },
    { header: "Discan Oleh", key: "by", width: 18 },
  ];
  (await q.all()).reverse().forEach((p, i) =>
    ws.addRow({
      no: i + 1,
      ticket: p.short_code,
      name: p.name,
      email: p.email,
      phone: p.phone,
      institution: p.institution || "",
      created: p.created_at,
      status: p.scanned_at ? "Sudah masuk" : "Belum",
      scanned: p.scanned_at || "",
      by: p.scanned_by || "",
    })
  );
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14213D" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: "A1", to: "J1" };

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
