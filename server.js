"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execSync } = require("child_process");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const sharp = require("sharp");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const MEDIA_DIRS = [
  process.env.MEDIA_DIR_1 || "/mnt/media1",
  process.env.MEDIA_DIR_2 || "/mnt/media2",
];

const JWT_SECRET = process.env.JWT_SECRET;
const API_PASSWORD = process.env.API_PASSWORD;
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || "24h";
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY || "85", 10);

if (!JWT_SECRET || !API_PASSWORD) {
  console.error("❌  JWT_SECRET and API_PASSWORD must be set in your .env file.");
  process.exit(1);
}

// Ensure drives exist (creates dirs locally for dev if not mounted)
for (const dir of MEDIA_DIRS) {
  if (!fs.existsSync(dir)) {
    console.warn(`⚠  Drive not found: ${dir} — creating for local dev`);
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── MEDIA TYPES ─────────────────────────────────────────────────────────────

const PHOTO_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
  ".tiff", ".tif", ".heic", ".heif", ".avif",
]);

// These formats are converted to WebP on upload.
// Already-modern formats (.webp, .avif) and videos are stored as-is.
const CONVERTIBLE_TO_WEBP = new Set([
  ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".heic", ".heif", ".gif",
]);

const VIDEO_EXTS = new Set([
  ".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv",
  ".wmv", ".m4v", ".3gp", ".ts", ".mpeg", ".mpg",
]);

function getMediaType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (PHOTO_EXTS.has(ext)) return "photo";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimes = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".tiff": "image/tiff", ".tif": "image/tiff", ".heic": "image/heic",
    ".heif": "image/heif", ".avif": "image/avif",
    ".mp4": "video/mp4", ".mkv": "video/x-matroska",
    ".mov": "video/quicktime", ".avi": "video/x-msvideo",
    ".webm": "video/webm", ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv",
    ".m4v": "video/x-m4v", ".3gp": "video/3gpp", ".ts": "video/mp2t",
    ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
  };
  return mimes[ext] || "application/octet-stream";
}

// ─── FILE ID SYSTEM ──────────────────────────────────────────────────────────
//
// Files are stored on disk as: {16hexId}_{sanitized-name}.ext
//
// Examples:
//   a1b2c3d4e5f6a7b8_vacation.webp
//   f9e8d7c6b5a49382_summer_2024.mp4
//
// The ID never changes. Renaming only updates the name part after the "_".
// No database is needed on this server — the ID is embedded in the filename.

const ID_RE = /^([0-9a-f]{16})_(.+)$/i;

function generateId() {
  return crypto.randomBytes(8).toString("hex"); // 16 hex chars
}

function sanitizeName(filename) {
  return (
    filename
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._-]+/, "") || "file"
  );
}

function parseStoredName(filename) {
  const m = filename.match(ID_RE);
  return m ? { id: m[1], name: m[2] } : null;
}

function buildStoredName(id, name) {
  return `${id}_${name}`;
}

// Scan all drives for a file with the given ID. Returns { dir, filename, id, name } or null.
function findById(id) {
  for (const dir of MEDIA_DIRS) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of entries) {
      const parsed = parseStoredName(f);
      if (parsed && parsed.id === id) return { dir, filename: f, ...parsed };
    }
  }
  return null;
}

function buildMeta(dir, filename) {
  const parsed = parseStoredName(filename);
  if (!parsed) return null;
  let stat;
  try { stat = fs.statSync(path.join(dir, filename)); } catch (_) { return null; }
  return {
    id: parsed.id,
    filename: parsed.name,
    type: getMediaType(parsed.name),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    drive: dir,
    url: `/media/files/${parsed.id}/stream`,
  };
}

// ─── DRIVE UTILS ─────────────────────────────────────────────────────────────

function getDriveFreeBytes(drivePath) {
  try {
    const out = execSync(`df -B1 --output=avail "${drivePath}"`, {
      stdio: ["pipe", "pipe", "ignore"],
    }).toString();
    return parseInt(out.split("\n")[1].trim(), 10) || 0;
  } catch (_) {
    return 0;
  }
}

// Pick the drive with the most free space for new uploads
function selectDrive() {
  let best = MEDIA_DIRS[0];
  let bestFree = -1;
  for (const dir of MEDIA_DIRS) {
    const free = getDriveFreeBytes(dir);
    if (free > bestFree) { bestFree = free; best = dir; }
  }
  return best;
}

// Cross-device safe move: tries rename first, falls back to stream copy + delete.
// This matters because multer writes to OS tmpdir which may be on a different
// filesystem than /mnt/media1 or /mnt/media2.
function moveFile(src, dest) {
  return new Promise((resolve, reject) => {
    fs.rename(src, dest, (err) => {
      if (!err) return resolve();
      if (err.code !== "EXDEV") return reject(err);
      // Different filesystems — stream the bytes across, then delete source
      const r = fs.createReadStream(src);
      const w = fs.createWriteStream(dest);
      r.on("error", reject);
      w.on("error", reject);
      w.on("finish", () => fs.unlink(src, (e) => (e ? reject(e) : resolve())));
      r.pipe(w);
    });
  });
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({
      error: err.name === "TokenExpiredError" ? "Token expired." : "Invalid token.",
    });
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(express.json());

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : "*",
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Authorization", "Content-Type"],
}));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rate limiter — brute-force protection on the login endpoint only
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Multer writes uploads to the OS tmpdir so large files stream straight to disk
// without ever being buffered in RAM — safe for big 4K videos on the Pi 5.
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) =>
      cb(null, `media_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`),
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (PHOTO_EXTS.has(ext) || VIDEO_EXTS.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  },
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Public — returns drive accessibility and free space.
 * Returns 503 if any drive is unreachable.
 */
app.get("/health", (_req, res) => {
  const drives = MEDIA_DIRS.map((dir) => {
    let accessible = false;
    let freeBytes = 0;
    try {
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
      accessible = true;
      freeBytes = getDriveFreeBytes(dir);
    } catch (_) {}
    return { path: dir, accessible, freeBytes };
  });
  const allOk = drives.every((d) => d.accessible);
  res.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "degraded", drives });
});

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

/**
 * POST /auth/login
 * Body: { "password": "your-password" }
 * Returns: { "token": "<jwt>", "expiresIn": "24h" }
 */
app.post("/auth/login", loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password is required." });
  if (password !== API_PASSWORD) return res.status(401).json({ error: "Invalid password." });
  const token = jwt.sign({ authorized: true }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  res.json({ token, expiresIn: TOKEN_EXPIRY });
});

// ─── LIST FILES ──────────────────────────────────────────────────────────────

/**
 * GET /media/files
 * Protected
 * Query:
 *   type=photo|video  — filter by media type
 *   sort=mtime|size|name  — sort field (default: mtime)
 *   order=asc|desc  — sort direction (default: desc)
 *   page=1, limit=50  — pagination (max 500 per page)
 *
 * Files from both drives are merged into a single sorted+paginated list.
 */
app.get("/media/files", requireAuth, (req, res) => {
  const { type, sort = "mtime", order = "desc", page = "1", limit = "50" } = req.query;

  let files = [];
  for (const dir of MEDIA_DIRS) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of entries) {
      const meta = buildMeta(dir, f);
      if (!meta) continue;
      if (type && meta.type !== type) continue;
      files.push(meta);
    }
  }

  const sortFns = {
    mtime: (a, b) => new Date(a.mtime) - new Date(b.mtime),
    size:  (a, b) => a.size - b.size,
    name:  (a, b) => a.filename.localeCompare(b.filename),
  };
  files.sort(sortFns[sort] || sortFns.mtime);
  if (order === "desc") files.reverse();

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10)));
  const total = files.length;
  const totalPages = Math.ceil(total / limitNum) || 1;
  const data = files.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  res.json({ total, page: pageNum, totalPages, limit: limitNum, data });
});

// ─── GET ONE FILE METADATA ────────────────────────────────────────────────────

/**
 * GET /media/files/:id
 * Protected — returns metadata only (no file content)
 */
app.get("/media/files/:id", requireAuth, (req, res) => {
  const found = findById(req.params.id);
  if (!found) return res.status(404).json({ error: "File not found" });
  res.json(buildMeta(found.dir, found.filename));
});

// ─── STREAM ───────────────────────────────────────────────────────────────────

/**
 * GET /media/files/:id/stream
 * Public — no auth required (Cloudflare CDN can cache this route)
 *
 * Supports Range requests for video seeking/scrubbing.
 * Cache-Control:
 *   Photos → public, max-age=31536000, immutable  (1 year — WebP never changes)
 *   Videos → public, max-age=86400                (1 day — Cloudflare caches ≤512 MB)
 */
app.get("/media/files/:id/stream", (req, res) => {
  const found = findById(req.params.id);
  if (!found) return res.status(404).json({ error: "File not found" });

  const filePath = path.join(found.dir, found.filename);
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) {
    return res.status(404).json({ error: "File not found on disk" });
  }

  const fileSize = stat.size;
  const mimeType = getMimeType(found.name);

  res.setHeader(
    "Cache-Control",
    getMediaType(found.name) === "photo"
      ? "public, max-age=31536000, immutable"
      : "public, max-age=86400"
  );

  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": mimeType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ─── UPLOAD ───────────────────────────────────────────────────────────────────

/**
 * POST /media/upload
 * Protected
 * Body: multipart/form-data, field name "files" (one or many)
 *
 * Photo optimization (done at upload time on this server):
 *   JPEG / PNG / BMP / TIFF / HEIC / GIF → WebP at WEBP_QUALITY (default 85)
 *   Already WebP / AVIF → stored as-is (already optimized)
 *
 * Video storage (no transcoding — too CPU-heavy for Pi 5):
 *   Videos are stored as-is. For best results, encode to H.264 or H.265 MP4
 *   before uploading. H.265 gives ~50% smaller files at the same quality.
 *
 * Drive selection: each file goes to the drive with the most free space.
 *
 * Files are stored as: {16hexId}_{sanitized-name}.ext
 * The ID is returned in the response and is stable — use it for all future requests.
 */
app.post("/media/upload", requireAuth, (req, res) => {
  upload.array("files")(req, res, async (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files provided. Use field name 'files'." });
    }

    const results = [];

    // Process files one at a time — parallel Sharp workers would spike Pi 5 CPU
    for (const file of req.files) {
      const id = generateId();
      const ext = path.extname(file.originalname).toLowerCase();
      const targetDir = selectDrive();

      try {
        if (CONVERTIBLE_TO_WEBP.has(ext)) {
          // Convert to WebP — saves storage and reduces download size
          const outName = buildStoredName(
            id,
            sanitizeName(path.basename(file.originalname, ext) + ".webp")
          );
          const outPath = path.join(targetDir, outName);
          await sharp(file.path, { animated: ext === ".gif" })
            .webp({ quality: WEBP_QUALITY })
            .toFile(outPath);
          fs.unlinkSync(file.path);

          const meta = buildMeta(targetDir, outName);
          results.push({
            ...meta,
            originalName: file.originalname,
            converted: true,
            originalSize: file.size,
            savedBytes: file.size - meta.size,
          });
        } else {
          // Video or already-modern format — move to the selected drive as-is
          const outName = buildStoredName(id, sanitizeName(file.originalname));
          const outPath = path.join(targetDir, outName);
          await moveFile(file.path, outPath);
          results.push({
            ...buildMeta(targetDir, outName),
            originalName: file.originalname,
            converted: false,
          });
        }
      } catch (uploadErr) {
        try { fs.unlinkSync(file.path); } catch (_) {}
        results.push({ originalName: file.originalname, error: uploadErr.message });
      }
    }

    const status = results.some((r) => r.error) ? 207 : 201;
    res.status(status).json({
      uploaded: results.filter((r) => !r.error).length,
      results,
    });
  });
});

// ─── RENAME ───────────────────────────────────────────────────────────────────

/**
 * PATCH /media/files/:id
 * Protected
 * Body: { "filename": "new-name.ext" }
 *
 * Extension must match the original (can't change file type).
 * The ID stays the same — only the name part of the stored filename changes.
 */
app.patch("/media/files/:id", requireAuth, (req, res) => {
  const { filename } = req.body;
  if (!filename || typeof filename !== "string") {
    return res.status(400).json({ error: "Body must include { filename: 'new-name.ext' }" });
  }

  const found = findById(req.params.id);
  if (!found) return res.status(404).json({ error: "File not found" });

  const currentExt = path.extname(found.name).toLowerCase();
  const newExt = path.extname(filename).toLowerCase();
  if (newExt && newExt !== currentExt) {
    return res.status(400).json({
      error: `Cannot change extension. Keep ${currentExt} or omit it.`,
    });
  }

  const finalName = sanitizeName(newExt ? filename : filename + currentExt);
  const newStoredName = buildStoredName(found.id, finalName);
  const oldPath = path.join(found.dir, found.filename);
  const newPath = path.join(found.dir, newStoredName);

  if (fs.existsSync(newPath)) {
    return res.status(409).json({ error: "A file with that name already exists." });
  }

  try {
    fs.renameSync(oldPath, newPath); // Same drive — always same filesystem
    res.json(buildMeta(found.dir, newStoredName));
  } catch (err) {
    res.status(500).json({ error: "Failed to rename", detail: err.message });
  }
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

/**
 * DELETE /media/files/:id
 * Protected — permanently deletes the file from disk.
 */
app.delete("/media/files/:id", requireAuth, (req, res) => {
  const found = findById(req.params.id);
  if (!found) return res.status(404).json({ error: "File not found" });

  try {
    fs.unlinkSync(path.join(found.dir, found.filename));
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to delete", detail: err.message });
  }
});

// ─── DEDUPLICATION ──────────────────────────────────────────────────────────

// Each drive has its own .media-hashes.json cache inside its root.
// Files are only re-hashed when their mtime or size has changed.
// Hashing is sequential (not parallel) to keep Pi 5 I/O load low.
// The endpoint reports duplicates but deletes nothing — use DELETE to act.

function loadHashCache(dir) {
  try {
    const p = path.join(dir, ".media-hashes.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {}
  return {};
}

function saveHashCache(dir, cache) {
  try { fs.writeFileSync(path.join(dir, ".media-hashes.json"), JSON.stringify(cache)); } catch (_) {}
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * POST /media/deduplicate
 * Protected
 *
 * Scans both drives, groups files with identical SHA-256 hashes.
 * Uses a per-drive cache so only new/changed files are re-hashed.
 * Response stats:
 *   scanned    — total media files checked across both drives
 *   fromCache  — files whose hash was already cached (no disk read)
 *   rehashed   — files that were newly hashed
 */
app.post("/media/deduplicate", requireAuth, async (req, res) => {
  let totalScanned = 0;
  let totalRehashed = 0;
  const byHash = {};

  for (const dir of MEDIA_DIRS) {
    let entries;
    try { entries = fs.readdirSync(dir).filter((f) => getMediaType(f)); } catch (_) { continue; }

    const cache = loadHashCache(dir);
    let rehashed = 0;

    for (const filename of entries) {
      const filePath = path.join(dir, filename);
      let stat;
      try { stat = fs.statSync(filePath); } catch (_) { continue; }

      const mtime = stat.mtime.toISOString();
      const size = stat.size;
      const cached = cache[filename];

      if (!cached || cached.mtime !== mtime || cached.size !== size) {
        try {
          cache[filename] = { hash: await hashFile(filePath), mtime, size };
          rehashed++;
        } catch (_) { continue; }
      }

      const { hash } = cache[filename];
      if (!byHash[hash]) byHash[hash] = [];
      byHash[hash].push({ dir, filename });
    }

    // Purge cache entries for files that no longer exist
    const entrySet = new Set(entries);
    for (const k of Object.keys(cache)) { if (!entrySet.has(k)) delete cache[k]; }
    saveHashCache(dir, cache);

    totalScanned += entries.length;
    totalRehashed += rehashed;
  }

  const duplicates = Object.entries(byHash)
    .filter(([, items]) => items.length > 1)
    .map(([hash, items]) => ({
      hash,
      files: items.map(({ dir, filename }) => buildMeta(dir, filename)).filter(Boolean),
    }));

  res.json({
    scanned: totalScanned,
    fromCache: totalScanned - totalRehashed,
    rehashed: totalRehashed,
    duplicateGroups: duplicates.length,
    duplicates,
  });
});

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Media server running on port ${PORT}`);
  console.log(`🔒 Auth enabled — token expiry: ${TOKEN_EXPIRY}`);
  console.log(`🖼️  WebP quality: ${WEBP_QUALITY} (JPEG/PNG/BMP/TIFF/HEIC/GIF → WebP at upload)\n`);
  console.log(`Drives:`);
  for (const dir of MEDIA_DIRS) {
    const freeGB = (getDriveFreeBytes(dir) / 1024 / 1024 / 1024).toFixed(1);
    console.log(`  ${dir}  (${freeGB} GB free)`);
  }
  console.log(`\nEndpoints:`);
  console.log(`  POST   /auth/login               → get JWT token`);
  console.log(`  GET    /health                   → drive status (public)`);
  console.log(`  GET    /media/files              → list files 🔒`);
  console.log(`  GET    /media/files/:id          → file metadata 🔒`);
  console.log(`  GET    /media/files/:id/stream   → stream / download (public)`);
  console.log(`  POST   /media/upload             → upload files 🔒`);
  console.log(`  PATCH  /media/files/:id          → rename file 🔒`);
  console.log(`  DELETE /media/files/:id          → delete file 🔒`);
  console.log(`  POST   /media/deduplicate        → find duplicates 🔒\n`);
});
