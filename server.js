require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");
const { DatabaseSync } = require("node:sqlite"); // SQLite bawaan Node.js, tanpa compile
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

if (!SECRET || SECRET.length < 24) {
  console.error("SECRET di .env wajib diisi, minimal 24 karakter.");
  process.exit(1);
}
if (!Object.keys(ACCOUNTS).length) {
  console.error("ADMIN_ACCOUNTS di .env wajib diisi, contoh: admin:passwordku");
  process.exit(1);
}

// ---------- Database ----------
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "data.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone       TEXT NOT NULL,
    institution TEXT,
    created_at  TEXT NOT NULL,
    scanned_at  TEXT,
    scanned_by  TEXT
  );
`);

const q = {
  count: db.prepare("SELECT COUNT(*) AS n FROM participants"),
  countScanned: db.prepare("SELECT COUNT(*) AS n FROM participants WHERE scanned_at IS NOT NULL"),
  insert: db.prepare(
    "INSERT INTO participants (id, name, email, phone, institution, created_at) VALUES (@id, @name, @email, @phone, @institution, @created_at)"
  ),
  byId: db.prepare("SELECT * FROM participants WHERE id = ?"),
  byEmail: db.prepare("SELECT id FROM participants WHERE email = ?"),
  all: db.prepare("SELECT * FROM participants ORDER BY created_at DESC, rowid DESC"),
  // Hanya berhasil kalau tiket belum pernah discan -> aman dari scan dobel bersamaan
  markScanned: db.prepare(
    "UPDATE participants SET scanned_at = ?, scanned_by = ? WHERE id = ? AND scanned_at IS NULL"
  ),
  setScanned: db.prepare(
    "UPDATE participants SET scanned_at = ?, scanned_by = ? WHERE id = ?"
  ),
  resetOne: db.prepare("UPDATE participants SET scanned_at = NULL, scanned_by = NULL WHERE id = ?"),
  resetAll: db.prepare("UPDATE participants SET scanned_at = NULL, scanned_by = NULL"),
  remove: db.prepare("DELETE FROM participants WHERE id = ?"),
};

// Waktu lokal acara, format "2026-11-14 19:05:12"
const fmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const now = () => fmt.format(new Date());

// Pendaftaran dibungkus transaksi supaya kuota tidak jebol saat banyak yang daftar bersamaan
function registerTx(p) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (q.count.get().n >= QUOTA) { db.exec("ROLLBACK"); return { error: "Kuota pendaftaran sudah penuh.", status: 409 }; }
    if (q.byEmail.get(p.email)) { db.exec("ROLLBACK"); return { error: "Email ini sudah terdaftar. Hubungi panitia kalau tiketmu hilang.", status: 409 }; }
    q.insert.run(p);
    db.exec("COMMIT");
    return { ok: true };
  } catch (e) {
    db.exec("ROLLBACK");
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
    keys: [SECRET],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  })
);
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.use("/vendor", express.static(path.join(__dirname, "node_modules/html5-qrcode")));

const auth = (req, res, next) =>
  req.session && req.session.user ? next() : res.status(401).json({ error: "Silakan login dulu." });

const clean = (v, max = 120) => String(v || "").trim().slice(0, max);

// Info acara (dipakai halaman depan)
app.get("/api/event", (req, res) => {
  const used = q.count.get().n;
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

  const r = registerTx(p);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ code: makeCode(p.id) });
});

// Data tiket (untuk halaman tiket peserta)
app.get("/api/ticket", async (req, res) => {
  const id = parseCode(req.query.code);
  const p = id && q.byId.get(id);
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
app.post("/api/scan", auth, (req, res) => {
  const id = parseCode(req.body.code);
  if (!id) return res.json({ status: "invalid", message: "QR tidak dikenali / palsu." });
  const p = q.byId.get(id);
  if (!p) return res.json({ status: "invalid", message: "Tiket tidak terdaftar." });

  const changed = q.markScanned.run(now(), req.session.user, id).changes;
  if (!changed) {
    const again = q.byId.get(id);
    return res.json({
      status: "used",
      message: "Tiket sudah dipakai.",
      participant: { name: again.name, institution: again.institution, scannedAt: again.scanned_at, scannedBy: again.scanned_by },
    });
  }
  const row = q.byId.get(id);
  res.json({
    status: "ok",
    message: "Silakan masuk.",
    participant: { name: row.name, institution: row.institution, scannedAt: row.scanned_at },
  });
});

// ---------- Dashboard admin ----------
app.get("/api/participants", auth, (req, res) => {
  const rows = q.all.all().map((p) => ({
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
  res.json({ quota: QUOTA, total: rows.length, scanned: q.countScanned.get().n, rows });
});

app.post("/api/participants/:id/status", auth, (req, res) => {
  if (!q.byId.get(req.params.id)) return res.status(404).json({ error: "Peserta tidak ditemukan." });
  if (req.body.scanned) q.setScanned.run(now(), req.session.user + " (manual)", req.params.id);
  else q.resetOne.run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/participants/reset-all", auth, (req, res) => {
  const n = q.resetAll.run().changes;
  res.json({ ok: true, reset: n });
});

app.delete("/api/participants/:id", auth, (req, res) => {
  q.remove.run(req.params.id);
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
  q.all.all().reverse().forEach((p, i) =>
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

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`  Pendaftaran : http://localhost:${PORT}/`);
  console.log(`  Admin       : http://localhost:${PORT}/admin`);
  console.log(`  Scanner     : http://localhost:${PORT}/scan`);
});
