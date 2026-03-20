const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const sharp = require("sharp");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, "Media");
const JWT_SECRET = process.env.JWT_SECRET;
const API_PASSWORD = process.env.API_PASSWORD;
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || "24h";

if (!JWT_SECRET || !API_PASSWORD) {
  console.error("❌  JWT_SECRET and API_PASSWORD must be set in your .env file.");
  console.error("    Run: node generate-secret.js  to generate them.");
  process.exit(1);
}

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".svg", ".heic", ".avif",
]);

// These formats are converted to WebP on upload. Already-modern formats
// (webp, avif, svg) and videos are left untouched.
const CONVERTIBLE_TO_WEBP = new Set([
  ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".heic", ".gif",
]);

// Quality 1-100. 85 is a great default — visually lossless for photos.
// Lower it (e.g. 75) to save more storage at the cost of slight quality loss.
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY || "85", 10);
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".wmv", ".m4v", ".3gp", ".ts",
]);

// ─── HELPERS ───────────────────────────────────────────────────────────────
function getMediaType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "photo";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimes = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".tiff": "image/tiff", ".svg": "image/svg+xml", ".heic": "image/heic",
    ".avif": "image/avif", ".mp4": "video/mp4", ".mkv": "video/x-matroska",
    ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".webm": "video/webm",
    ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv", ".m4v": "video/x-m4v",
    ".3gp": "video/3gpp", ".ts": "video/mp2t",
  };
  return mimes[ext] || "application/octet-stream";
}

// ─── IMAGE CONVERSION ───────────────────────────────────────────────────────

/**
 * Converts an uploaded image to WebP and deletes the original.
 * Returns the new file path, or null if the file doesn't need conversion.
 * GIFs are handled with { animated: true } to preserve animation.
 */
async function convertToWebP(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!CONVERTIBLE_TO_WEBP.has(ext)) return null;

  const webpPath = filePath.slice(0, -ext.length) + ".webp";
  await sharp(filePath, { animated: ext === ".gif" })
    .webp({ quality: WEBP_QUALITY })
    .toFile(webpPath);

  fs.unlinkSync(filePath);
  return webpPath;
}

// ─── UPLOAD CONFIG ─────────────────────────────────────────────────────────
// Uses disk storage so large files stream directly to disk — no RAM buffering
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 200);
    cb(null, `${base}${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  },
});

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
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

// ─── RATE LIMITER (brute-force protection on login) ─────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }

  const token = authHeader.split(" ")[1];

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired. Please log in again." });
    }
    return res.status(401).json({ error: "Invalid token." });
  }
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Public — no auth required
 */
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /auth/login
 * Body: { "password": "your-password" }
 * Returns: { "token": "<jwt>", "expiresIn": "24h" }
 */
app.post("/auth/login", loginLimiter, (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: "Password is required." });
  }

  if (password !== API_PASSWORD) {
    return res.status(401).json({ error: "Invalid password." });
  }

  const token = jwt.sign(
    { authorized: true },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  res.json({ token, expiresIn: TOKEN_EXPIRY });
});

/**
 * GET /media
 * Protected — requires Bearer token
 * Query params:
 *   type=photo|video  → filter by type
 *   page=1            → page number (default 1)
 *   limit=50          → items per page (default 50, max 500)
 */
app.get("/media", requireAuth, (req, res) => {
  if (!fs.existsSync(MEDIA_DIR)) {
    return res.status(500).json({ error: "Media directory not found", path: MEDIA_DIR });
  }

  let files;
  try {
    files = fs.readdirSync(MEDIA_DIR);
  } catch (err) {
    return res.status(500).json({ error: "Failed to read media directory", detail: err.message });
  }

  let mediaFiles = files
    .map((filename) => {
      const type = getMediaType(filename);
      if (!type) return null;

      const fullPath = path.join(MEDIA_DIR, filename);
      let size = null;
      let mtime = null;
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
        mtime = stat.mtime.toISOString();
      } catch (_) {}

      return {
        id: path.parse(filename).name,
        filename,
        type,
        size,
        mtime,
        url: `/media/file/${encodeURIComponent(filename)}`,
      };
    })
    .filter(Boolean);

  // Newest files first
  mediaFiles.sort((a, b) => (b.mtime || "").localeCompare(a.mtime || ""));

  const { type, page = "1", limit = "50" } = req.query;
  if (type === "photo" || type === "video") {
    mediaFiles = mediaFiles.filter((f) => f.type === type);
  }

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit)));
  const total = mediaFiles.length;
  const totalPages = Math.ceil(total / limitNum) || 1;
  const paginated = mediaFiles.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  res.json({ total, page: pageNum, totalPages, limit: limitNum, data: paginated });
});

/**
 * GET /media/file/:filename
 * Public — no auth required (Cloudflare CDN caches this route)
 * Photos get a 1-year immutable cache (WebP filenames never change).
 * Videos get a 1-day cache; Cloudflare only caches files ≤ 512 MB —
 * larger videos are proxied directly from the Pi without edge caching.
 * Streams the file with Range request support (needed for video seeking)
 */
app.get("/media/file/:filename", (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const safeName = path.basename(filename);
  const filePath = path.join(MEDIA_DIR, safeName);

  // Security: prevent path traversal
  if (!filePath.startsWith(path.resolve(MEDIA_DIR))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = getMimeType(safeName);
  const mediaType = getMediaType(safeName);

  // Photos: 1-year immutable (WebP files are written once and never modified)
  // Videos: 1-day cache; Cloudflare won't cache files > 512 MB but the
  //         header still benefits browser-level caching for smaller videos
  const cacheControl = mediaType === "photo"
    ? "public, max-age=31536000, immutable"
    : "public, max-age=86400";

  res.setHeader("Cache-Control", cacheControl);

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
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

/**
 * POST /media/upload
 * Protected — requires Bearer token
 * Body: multipart/form-data, field name "files" (one or many)
 *
 * multer diskStorage writes each file directly to disk as it arrives —
 * never buffered in RAM, so large files and batches work fine on a Pi 5.
 *
 * After saving, convertible images (JPEG, PNG, BMP, TIFF, HEIC, GIF) are
 * converted to WebP at WEBP_QUALITY (default 85). Conversion is sequential
 * to avoid saturating the Pi 5. Videos are stored as-is.
 */
app.post("/media/upload", requireAuth, (req, res) => {
  upload.array("files")(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files provided." });
    }

    const uploaded = [];

    // Process files one at a time — parallel Sharp workers would spike Pi 5 CPU
    for (const f of req.files) {
      let filename = f.filename;
      let converted = false;
      const originalSize = f.size;

      try {
        const webpPath = await convertToWebP(path.join(MEDIA_DIR, f.filename));
        if (webpPath) {
          filename = path.basename(webpPath);
          converted = true;
        }
      } catch (convErr) {
        // Conversion failed — keep the original file intact
        console.error(`WebP conversion failed for ${f.filename}: ${convErr.message}`);
      }

      const finalStat = fs.statSync(path.join(MEDIA_DIR, filename));
      uploaded.push({
        filename,
        originalFilename: f.originalname,
        type: getMediaType(filename),
        size: finalStat.size,
        ...(converted && { originalSize, savedBytes: originalSize - finalStat.size }),
        converted,
        url: `/media/file/${encodeURIComponent(filename)}`,
      });
    }

    res.status(201).json({
      message: `${uploaded.length} file(s) uploaded successfully`,
      uploaded,
    });
  });
});

/**
 * DELETE /media/file/:filename
 * Protected — requires Bearer token
 * Permanently deletes the file from disk.
 */
app.delete("/media/file/:filename", requireAuth, (req, res) => {
  const safeName = path.basename(decodeURIComponent(req.params.filename));
  const filePath = path.join(MEDIA_DIR, safeName);

  if (!filePath.startsWith(path.resolve(MEDIA_DIR))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  try {
    fs.unlinkSync(filePath);
    res.json({ message: "File deleted", filename: safeName });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete file", detail: err.message });
  }
});

/**
 * PATCH /media/file/:filename
 * Protected — requires Bearer token
 * Renames a file. Body: { "filename": "new-name.ext" }
 * The extension must match the original (can't change file type).
 */
app.patch("/media/file/:filename", requireAuth, (req, res) => {
  const safeName = path.basename(decodeURIComponent(req.params.filename));
  const filePath = path.join(MEDIA_DIR, safeName);

  if (!filePath.startsWith(path.resolve(MEDIA_DIR))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const { filename: newFilename } = req.body;
  if (!newFilename) {
    return res.status(400).json({ error: "New filename is required." });
  }

  const safeNewName = path.basename(newFilename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const newFilePath = path.join(MEDIA_DIR, safeNewName);

  if (!newFilePath.startsWith(path.resolve(MEDIA_DIR))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (path.extname(safeNewName).toLowerCase() !== path.extname(safeName).toLowerCase()) {
    return res.status(400).json({ error: "Cannot change file extension." });
  }

  if (fs.existsSync(newFilePath)) {
    return res.status(409).json({ error: "A file with that name already exists." });
  }

  try {
    fs.renameSync(filePath, newFilePath);
    res.json({
      message: "File renamed",
      filename: safeNewName,
      type: getMediaType(safeNewName),
      url: `/media/file/${encodeURIComponent(safeNewName)}`,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to rename file", detail: err.message });
  }
});

/**
 * GET /media/:id
 * Protected — requires Bearer token
 */
app.get("/media/:id", requireAuth, (req, res) => {
  const { id } = req.params;

  if (!fs.existsSync(MEDIA_DIR)) {
    return res.status(500).json({ error: "Media directory not found" });
  }

  const files = fs.readdirSync(MEDIA_DIR);
  const match = files.find((f) => path.parse(f).name === id);

  if (!match) {
    return res.status(404).json({ error: "File not found" });
  }

  const type = getMediaType(match);
  if (!type) {
    return res.status(404).json({ error: "Not a supported media type" });
  }

  const stat = fs.statSync(path.join(MEDIA_DIR, match));

  res.json({
    id,
    filename: match,
    type,
    size: stat.size,
    url: `/media/file/${encodeURIComponent(match)}`,
  });
});

// ─── DEDUPLICATION ──────────────────────────────────────────────────────────

// Hash cache is stored as a hidden JSON file inside MEDIA_DIR.
// Structure: { "<filename>": { "hash": "<sha256>", "mtime": "<iso>", "size": <bytes> } }
// A file is only re-hashed when its mtime or size has changed — so repeated
// calls are fast even on a large library.
const HASH_CACHE_PATH = path.join(MEDIA_DIR, ".media-hashes.json");

function loadHashCache() {
  try {
    if (fs.existsSync(HASH_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(HASH_CACHE_PATH, "utf8"));
    }
  } catch (_) {}
  return {};
}

function saveHashCache(cache) {
  try {
    fs.writeFileSync(HASH_CACHE_PATH, JSON.stringify(cache));
  } catch (_) {}
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
 * Protected — requires Bearer token
 *
 * Scans the media directory, hashes every file (using a cache so only
 * new/changed files are re-hashed), and returns groups of duplicate files.
 * Nothing is deleted — the caller decides which files to remove via DELETE.
 *
 * Response includes stats so the caller knows how much work was done:
 *   scanned    — total media files checked
 *   fromCache  — files whose hash was already cached (fast, no disk read)
 *   rehashed   — files that had to be hashed (new or modified)
 */
app.post("/media/deduplicate", requireAuth, async (req, res) => {
  let files;
  try {
    files = fs.readdirSync(MEDIA_DIR).filter((f) => getMediaType(f));
  } catch (err) {
    return res.status(500).json({ error: "Failed to read media directory", detail: err.message });
  }

  const cache = loadHashCache();
  let rehashed = 0;

  // Hash sequentially to avoid saturating Pi 5 I/O with parallel reads
  for (const filename of files) {
    const filePath = path.join(MEDIA_DIR, filename);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }

    const mtime = stat.mtime.toISOString();
    const size = stat.size;
    const cached = cache[filename];

    // Skip if mtime and size are unchanged — hash is still valid
    if (cached && cached.mtime === mtime && cached.size === size) continue;

    try {
      cache[filename] = { hash: await hashFile(filePath), mtime, size };
      rehashed++;
    } catch (_) {
      // Skip files that can't be read (e.g. still being written)
    }
  }

  // Purge cache entries for files that no longer exist
  const fileSet = new Set(files);
  for (const key of Object.keys(cache)) {
    if (!fileSet.has(key)) delete cache[key];
  }

  saveHashCache(cache);

  // Group filenames by hash — only groups with 2+ files are duplicates
  const byHash = {};
  for (const filename of files) {
    if (!cache[filename]) continue;
    const { hash } = cache[filename];
    if (!byHash[hash]) byHash[hash] = [];
    byHash[hash].push(filename);
  }

  const duplicates = Object.entries(byHash)
    .filter(([, names]) => names.length > 1)
    .map(([hash, names]) => ({
      hash,
      files: names.map((filename) => {
        const stat = fs.statSync(path.join(MEDIA_DIR, filename));
        return {
          filename,
          type: getMediaType(filename),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          url: `/media/file/${encodeURIComponent(filename)}`,
        };
      }),
    }));

  res.json({
    scanned: files.length,
    fromCache: files.length - rehashed,
    rehashed,
    duplicateGroups: duplicates.length,
    duplicates,
  });
});

// ─── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Media server running on port ${PORT}`);
  console.log(`📁 Serving files from: ${MEDIA_DIR}`);
  console.log(`🔒 Auth enabled — token expiry: ${TOKEN_EXPIRY}`);
  console.log(`🖼️  WebP conversion enabled — quality: ${WEBP_QUALITY} (JPEG/PNG/BMP/TIFF/HEIC/GIF → WebP)`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /auth/login              → get a JWT token`);
  console.log(`  GET  /health                  → health check (public)`);
  console.log(`  GET  /media                   → list all media 🔒`);
  console.log(`  GET  /media?type=photo        → list photos only 🔒`);
  console.log(`  GET  /media?type=video        → list videos only 🔒`);
  console.log(`  GET  /media/:id               → single file metadata 🔒`);
  console.log(`  GET    /media/file/:filename  → stream a file 🔒`);
  console.log(`  POST   /media/upload          → upload files 🔒`);
  console.log(`  DELETE /media/file/:filename  → delete a file 🔒`);
  console.log(`  PATCH  /media/file/:filename  → rename a file 🔒`);
  console.log(`  POST   /media/deduplicate     → find duplicate files 🔒\n`);
});
