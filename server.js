require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");
const { createClient } = require("@libsql/client"); // Turso (online) atau file SQLite (lokal)
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

// Jangan process.exit di sini: di Vercel itu bikin error 500 tanpa pesan jelas.
const CONFIG_ERROR =
  !SECRET || SECRET.length < 24
    ? "SECRET belum diisi (minimal 24 karakter) di Environment Variables."
    : !Object.keys(ACCOUNTS).length
    ? "ADMIN_ACCOUNTS belum diisi di Environment Variables, contoh: admin:passwordku"
    : null;
if (CONFIG_ERROR) console.error(CONFIG_ERROR);

// ---------- Database ----------
// Online: isi TURSO_DATABASE_URL & TURSO_AUTH_TOKEN. Lokal: otomatis pakai file data.db
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:" + path.join(__dirname, "data.db"),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let ready;
const initDb = () =>
  (ready ||= db
    .execute(`
      CREATE TABLE IF NOT EXISTS participants (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        phone       TEXT NOT NULL,
        institution TEXT,
        created_at  TEXT NOT NULL,
        scanned_at  TEXT,
        scanned_by  TEXT
      )`)
    .catch((e) => { ready = null; throw e; }));

const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const run = async (sql, args = []) => (await db.execute({ sql, args })).rowsAffected;

const q = {
  count: () => one("SELECT COUNT(*) AS n FROM participants").then((r) => Number(r.n)),
  countScanned: () => one("SELECT COUNT(*) AS n FROM participants WHERE scanned_at IS NOT NULL").then((r) => Number(r.n)),
  byId: (id) => one("SELECT * FROM participants WHERE id = ?", [id]),
  all: () => all("SELECT * FROM participants ORDER BY created_at DESC, rowid DESC"),
  // Hanya berhasil kalau tiket belum pernah discan -> aman dari scan dobel bersamaan
  markScanned: (t, by, id) =>
    run("UPDATE participants SET scanned_at = ?, scanned_by = ? WHERE id = ? AND scanned_at IS NULL", [t, by, id]),
  setScanned: (t, by, id) => run("UPDATE participants SET scanned_at = ?, scanned_by = ? WHERE id = ?", [t, by, id]),
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

// Cek kuota & simpan dalam SATU query, jadi kuota tidak jebol saat banyak yang daftar bersamaan
async function registerTx(p) {
  try {
    const n = await run(
      `INSERT INTO participants (id, name, email, phone, institution, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM participants) < ?`,
      [p.id, p.name, p.email, p.phone, p.institution, p.created_at, QUOTA]
    );
    if (!n) return { error: "Kuota pendaftaran sudah penuh.", status: 409 };
    return { ok: true };
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message || e)))
      return { error: "Email ini sudah terdaftar. Hubungi panitia kalau tiketmu hilang.", status: 409 };
    throw e;
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
// Di Vercel folder public/ dilayani CDN; baris ini untuk jalan di komputer sendiri / VPS
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.use("/api", async (req, res, next) => {
  if (CONFIG_ERROR) return res.status(500).json({ error: CONFIG_ERROR });
  try {
    await initDb();
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal konek ke database. Cek TURSO_DATABASE_URL & TURSO_AUTH_TOKEN." });
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
    ticketNo: p.id.slice(0, 6).toUpperCase(),
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
app.post("/api/scan", auth, async (req, res) => {
  const id = parseCode(req.body.code);
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
    { header: "No. Tiket", key: "ticket", width: 12 },
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
      ticket: p.id.slice(0, 6).toUpperCase(),
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

// Di Vercel, app di-export (tanpa listen). Di komputer sendiri / VPS, server jalan biasa.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server jalan di http://localhost:${PORT}`);
    console.log(`  Pendaftaran : http://localhost:${PORT}/`);
    console.log(`  Admin       : http://localhost:${PORT}/admin`);
    console.log(`  Scanner     : http://localhost:${PORT}/scan`);
  });
}

module.exports = app;
