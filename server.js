const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
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
  methods: ["GET", "POST"],
  allowedHeaders: ["Authorization", "Content-Type"],
}));

// Serve the web UI from /public
app.use(express.static(path.join(__dirname, "public")));

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

// Auth that also accepts ?token= query param.
// Needed so <video> and <img> elements can embed the token in the src URL,
// since HTML media elements cannot send custom headers.
function requireAuthFlexible(req, res, next) {
  const token =
    req.query.token ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.split(" ")[1]
      : null);

  if (!token) {
    return res.status(401).json({ error: "Missing or malformed Authorization." });
  }

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
 * Protected — requires Bearer token OR ?token= query param
 * Streams the file with Range request support (needed for video seeking)
 *
 * For large videos, the Range-based approach is the most efficient strategy
 * on low-power hardware: Node simply pipes raw bytes from disk to the network.
 * No transcoding, no buffering the whole file in RAM.
 */
app.get("/media/file/:filename", requireAuthFlexible, (req, res) => {
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
 * Body: multipart/form-data with field "file"
 *
 * multer diskStorage writes the incoming bytes directly to disk in streaming
 * fashion — the full file is never held in RAM, so large uploads (4K videos,
 * multiple GBs) work fine on a Raspberry Pi 5.
 */
app.post("/media/upload", requireAuth, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file provided." });
    }

    res.status(201).json({
      message: "Upload successful",
      filename: req.file.filename,
      size: req.file.size,
      type: getMediaType(req.file.filename),
      url: `/media/file/${encodeURIComponent(req.file.filename)}`,
    });
  });
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

// ─── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Media server running on port ${PORT}`);
  console.log(`📁 Serving files from: ${MEDIA_DIR}`);
  console.log(`🔒 Auth enabled — token expiry: ${TOKEN_EXPIRY}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /auth/login              → get a JWT token`);
  console.log(`  GET  /health                  → health check (public)`);
  console.log(`  GET  /media                   → list all media 🔒`);
  console.log(`  GET  /media?type=photo        → list photos only 🔒`);
  console.log(`  GET  /media?type=video        → list videos only 🔒`);
  console.log(`  GET  /media/:id               → single file metadata 🔒`);
  console.log(`  GET  /media/file/:filename    → stream a file 🔒`);
  console.log(`  POST /media/upload            → upload a file 🔒`);
  console.log(`\n  Web UI → http://localhost:${PORT}\n`);
});
