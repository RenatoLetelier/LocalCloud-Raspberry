"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execSync } = require("child_process");
const { pipeline } = require("stream/promises");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const sharp = require("sharp");
const unzipper = require("unzipper");
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

// Ensure photos/ and videos/ subdirectories exist on each drive
for (const dir of MEDIA_DIRS) {
  for (const sub of ["photos", "videos"]) {
    const full = path.join(dir, sub);
    if (!fs.existsSync(full)) {
      console.warn(`⚠  Creating ${full}`);
      fs.mkdirSync(full, { recursive: true });
    }
  }
}

// ─── MEDIA TYPES ─────────────────────────────────────────────────────────────

const PHOTO_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
  ".tiff", ".tif", ".heic", ".heif", ".avif",
]);

// These photo formats are converted to WebP on upload.
// Already-modern formats (.webp, .avif) are stored as-is.
const CONVERTIBLE_TO_WEBP = new Set([
  ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".heic", ".heif", ".gif",
]);

// File types accepted when adding a single file to an existing video directory
const VIDEO_FILE_EXTS = new Set([
  ".m3u8", ".ts", ".vtt", ".srt", ".ac3", ".aac", ".mp3",
]);

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimes = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".tiff": "image/tiff", ".tif": "image/tiff",
    ".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts":   "video/mp2t",
    ".vtt":  "text/vtt",
    ".srt":  "text/plain",
    ".ac3":  "audio/ac3",
    ".aac":  "audio/aac",
    ".mp3":  "audio/mpeg",
  };
  return mimes[ext] || "application/octet-stream";
}

// ─── FILE ID SYSTEM ──────────────────────────────────────────────────────────
//
// Storage layout:
//   Photos:  {drive}/photos/{16hexId}_{sanitized-name}.webp
//   Videos:  {drive}/videos/{16hexId}_{sanitized-name}/   ← directory
//               ├── master.m3u8
//               ├── 1080p/segment*.ts
//               ├── audio_en.m3u8
//               └── subtitles_en.vtt
//
// The ID is permanent — rename only changes the name portion after the "_".

const ID_RE = /^([0-9a-f]{16})_(.+)$/i;

function generateId() {
  return crypto.randomBytes(8).toString("hex"); // 16 hex chars
}

function sanitizeName(name) {
  return (
    name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^[._-]+/, "") || "file"
  );
}

function parseStoredName(name) {
  const m = name.match(ID_RE);
  return m ? { id: m[1], name: m[2] } : null;
}

function buildStoredName(id, name) {
  return `${id}_${name}`;
}

// ─── PHOTO HELPERS ────────────────────────────────────────────────────────────

function findPhotoById(id) {
  for (const dir of MEDIA_DIRS) {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, "photos")); } catch (_) { continue; }
    for (const f of entries) {
      const parsed = parseStoredName(f);
      if (parsed && parsed.id === id) return { drive: dir, filename: f, ...parsed };
    }
  }
  return null;
}

function buildPhotoMeta(drive, filename) {
  const parsed = parseStoredName(filename);
  if (!parsed) return null;
  let stat;
  try { stat = fs.statSync(path.join(drive, "photos", filename)); } catch (_) { return null; }
  return {
    id: parsed.id,
    filename: parsed.name,
    type: "photo",
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    drive,
    url: `/media/files/${parsed.id}/stream`,
  };
}

// ─── VIDEO HELPERS ────────────────────────────────────────────────────────────

function findVideoById(id) {
  for (const dir of MEDIA_DIRS) {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, "videos"), { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const parsed = parseStoredName(entry.name);
      if (parsed && parsed.id === id) return { drive: dir, dirname: entry.name, ...parsed };
    }
  }
  return null;
}

function getDirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      total += entry.isDirectory() ? getDirSize(full) : (fs.statSync(full).size || 0);
    }
  } catch (_) {}
  return total;
}

function buildVideoMeta(drive, dirname) {
  const parsed = parseStoredName(dirname);
  if (!parsed) return null;
  const videoDir = path.join(drive, "videos", dirname);
  let stat;
  try { stat = fs.statSync(videoDir); } catch (_) { return null; }

  const qualities = [], subtitles = [], audioTracks = [];
  try {
    for (const entry of fs.readdirSync(videoDir, { withFileTypes: true })) {
      if (entry.isDirectory()) qualities.push(entry.name);
      else if (entry.name.endsWith(".vtt") || entry.name.endsWith(".srt")) subtitles.push(entry.name);
      else if (entry.name.startsWith("audio_") && entry.name.endsWith(".m3u8")) audioTracks.push(entry.name);
    }
  } catch (_) {}

  return {
    id: parsed.id,
    name: parsed.name,
    masterUrl: `/media/videos/${parsed.id}/stream/master.m3u8`,
    size: getDirSize(videoDir),
    mtime: stat.mtime.toISOString(),
    drive,
    qualities,
    subtitles,
    audioTracks,
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

function selectDrive() {
  let best = MEDIA_DIRS[0], bestFree = -1;
  for (const dir of MEDIA_DIRS) {
    const free = getDriveFreeBytes(dir);
    if (free > bestFree) { bestFree = free; best = dir; }
  }
  return best;
}

// Cross-device safe move: tries rename first, falls back to stream copy + delete.
// Important because multer writes to OS tmpdir which may be on a different
// filesystem than /mnt/media1 or /mnt/media2.
function moveFile(src, dest) {
  return new Promise((resolve, reject) => {
    fs.rename(src, dest, (err) => {
      if (!err) return resolve();
      if (err.code !== "EXDEV") return reject(err);
      const r = fs.createReadStream(src);
      const w = fs.createWriteStream(dest);
      r.on("error", reject);
      w.on("error", reject);
      w.on("finish", () => fs.unlink(src, (e) => (e ? reject(e) : resolve())));
      r.pipe(w);
    });
  });
}

// ─── ZIP EXTRACTION ──────────────────────────────────────────────────────────

// Extracts a ZIP into targetDir with path traversal protection.
// ZIP root must contain HLS files directly (master.m3u8 at root level).
// Client should build the ZIP with: cd /hls-output && zip -0 -r movie.zip .
async function extractZip(zipPath, targetDir) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const resolvedTarget = path.resolve(targetDir);
  const directory = await unzipper.Open.file(zipPath);

  for (const file of directory.files) {
    const safePath = path.posix
      .normalize(file.path.replace(/\\/g, "/"))
      .replace(/^(\.\.(\/|$))+/, "");

    if (!safePath || safePath === ".") continue;

    const fullPath = path.join(targetDir, safePath);

    // Security: reject entries that would escape the target directory
    if (!path.resolve(fullPath).startsWith(resolvedTarget + path.sep)) continue;

    if (file.type === "Directory") {
      await fs.promises.mkdir(fullPath, { recursive: true });
    } else {
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await pipeline(file.stream(), fs.createWriteStream(fullPath));
    }
  }
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

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
  standardHeaders: true, legacyHeaders: false,
});

// Photo upload: streams directly to disk, never buffered in RAM
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) =>
      cb(null, `photo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`),
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    PHOTO_EXTS.has(ext) ? cb(null, true) : cb(new Error(`Unsupported photo format: ${ext}`));
  },
});

// Video upload: accepts ZIP only
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) =>
      cb(null, `video_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.zip`),
  }),
  fileFilter: (_req, file, cb) => {
    path.extname(file.originalname).toLowerCase() === ".zip"
      ? cb(null, true)
      : cb(new Error("Video uploads must be a .zip file containing the HLS structure."));
  },
});

// Single-file upload for adding subtitles / audio tracks to an existing video
const singleFileUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) =>
      cb(null, `vfile_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`),
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    VIDEO_FILE_EXTS.has(ext) ? cb(null, true) : cb(new Error(`Unsupported file type: ${ext}`));
  },
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Public — drive accessibility and free bytes. Returns 503 if any drive is down.
 */
app.get("/health", (_req, res) => {
  const drives = MEDIA_DIRS.map((dir) => {
    let accessible = false, freeBytes = 0;
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

// ─── PHOTO ENDPOINTS ──────────────────────────────────────────────────────────

/**
 * GET /media/files
 * Protected
 * Query: sort=mtime|size|name, order=asc|desc, page=1, limit=50
 */
app.get("/media/files", requireAuth, (req, res) => {
  const { sort = "mtime", order = "desc", page = "1", limit = "50" } = req.query;
  let files = [];
  for (const dir of MEDIA_DIRS) {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, "photos")); } catch (_) { continue; }
    for (const f of entries) {
      const meta = buildPhotoMeta(dir, f);
      if (meta) files.push(meta);
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
  res.json({
    total, page: pageNum,
    totalPages: Math.ceil(total / limitNum) || 1,
    limit: limitNum,
    data: files.slice((pageNum - 1) * limitNum, pageNum * limitNum),
  });
});

/**
 * GET /media/files/:id
 * Protected — photo metadata
 */
app.get("/media/files/:id", requireAuth, (req, res) => {
  const found = findPhotoById(req.params.id);
  if (!found) return res.status(404).json({ error: "Photo not found" });
  res.json(buildPhotoMeta(found.drive, found.filename));
});

/**
 * GET /media/files/:id/stream
 * Public — serve a photo. 1-year immutable cache (WebP never changes).
 */
app.get("/media/files/:id/stream", (req, res) => {
  const found = findPhotoById(req.params.id);
  if (!found) return res.status(404).json({ error: "Photo not found" });
  const filePath = path.join(found.drive, "photos", found.filename);
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) {
    return res.status(404).json({ error: "File not found on disk" });
  }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.writeHead(200, {
    "Content-Length": stat.size,
    "Content-Type": getMimeType(found.name),
  });
  fs.createReadStream(filePath).pipe(res);
});

/**
 * POST /media/upload
 * Protected
 * Body: multipart/form-data, field "files" (one or many)
 *
 * JPEG/PNG/BMP/TIFF/HEIC/GIF → converted to WebP at WEBP_QUALITY (default 85).
 * Already WebP/AVIF → stored as-is.
 * Uploads go to the drive with the most free space.
 */
app.post("/media/upload", requireAuth, (req, res) => {
  photoUpload.array("files")(req, res, async (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files provided. Use field name 'files'." });
    }

    const results = [];
    // Process one at a time — parallel Sharp workers would spike Pi 5 CPU
    for (const file of req.files) {
      const id = generateId();
      const ext = path.extname(file.originalname).toLowerCase();
      const targetDrive = selectDrive();
      try {
        if (CONVERTIBLE_TO_WEBP.has(ext)) {
          const outName = buildStoredName(
            id, sanitizeName(path.basename(file.originalname, ext) + ".webp")
          );
          const outPath = path.join(targetDrive, "photos", outName);
          await sharp(file.path, { animated: ext === ".gif" })
            .webp({ quality: WEBP_QUALITY })
            .toFile(outPath);
          fs.unlinkSync(file.path);
          const meta = buildPhotoMeta(targetDrive, outName);
          results.push({
            ...meta, originalName: file.originalname,
            converted: true, originalSize: file.size, savedBytes: file.size - meta.size,
          });
        } else {
          const outName = buildStoredName(id, sanitizeName(file.originalname));
          await moveFile(file.path, path.join(targetDrive, "photos", outName));
          results.push({
            ...buildPhotoMeta(targetDrive, outName),
            originalName: file.originalname, converted: false,
          });
        }
      } catch (uploadErr) {
        try { fs.unlinkSync(file.path); } catch (_) {}
        results.push({ originalName: file.originalname, error: uploadErr.message });
      }
    }

    res.status(results.some((r) => r.error) ? 207 : 201).json({
      uploaded: results.filter((r) => !r.error).length,
      results,
    });
  });
});

/**
 * PATCH /media/files/:id
 * Protected — rename a photo
 * Body: { "filename": "new-name.ext" }
 * Extension must match original.
 */
app.patch("/media/files/:id", requireAuth, (req, res) => {
  const { filename } = req.body;
  if (!filename || typeof filename !== "string") {
    return res.status(400).json({ error: "Body must include { filename: 'new-name.ext' }" });
  }
  const found = findPhotoById(req.params.id);
  if (!found) return res.status(404).json({ error: "Photo not found" });
  const currentExt = path.extname(found.name).toLowerCase();
  const newExt = path.extname(filename).toLowerCase();
  if (newExt && newExt !== currentExt) {
    return res.status(400).json({ error: `Cannot change extension. Keep ${currentExt} or omit it.` });
  }
  const finalName = sanitizeName(newExt ? filename : filename + currentExt);
  const newStoredName = buildStoredName(found.id, finalName);
  const oldPath = path.join(found.drive, "photos", found.filename);
  const newPath = path.join(found.drive, "photos", newStoredName);
  if (fs.existsSync(newPath)) return res.status(409).json({ error: "A file with that name already exists." });
  try {
    fs.renameSync(oldPath, newPath);
    res.json(buildPhotoMeta(found.drive, newStoredName));
  } catch (err) {
    res.status(500).json({ error: "Failed to rename", detail: err.message });
  }
});

/**
 * DELETE /media/files/:id
 * Protected — permanently delete a photo
 */
app.delete("/media/files/:id", requireAuth, (req, res) => {
  const found = findPhotoById(req.params.id);
  if (!found) return res.status(404).json({ error: "Photo not found" });
  try {
    fs.unlinkSync(path.join(found.drive, "photos", found.filename));
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to delete", detail: err.message });
  }
});

// ─── VIDEO ENDPOINTS ──────────────────────────────────────────────────────────

/**
 * GET /media/videos
 * Protected
 * Query: sort=mtime|size|name, order=asc|desc, page=1, limit=20
 * Returns: id, name, masterUrl, size, mtime, drive, qualities, subtitles, audioTracks
 */
app.get("/media/videos", requireAuth, (req, res) => {
  const { sort = "mtime", order = "desc", page = "1", limit = "20" } = req.query;
  let videos = [];
  for (const dir of MEDIA_DIRS) {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, "videos"), { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = buildVideoMeta(dir, entry.name);
      if (meta) videos.push(meta);
    }
  }
  const sortFns = {
    mtime: (a, b) => new Date(a.mtime) - new Date(b.mtime),
    size:  (a, b) => a.size - b.size,
    name:  (a, b) => a.name.localeCompare(b.name),
  };
  videos.sort(sortFns[sort] || sortFns.mtime);
  if (order === "desc") videos.reverse();
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const total = videos.length;
  res.json({
    total, page: pageNum,
    totalPages: Math.ceil(total / limitNum) || 1,
    limit: limitNum,
    data: videos.slice((pageNum - 1) * limitNum, pageNum * limitNum),
  });
});

/**
 * GET /media/videos/:id
 * Protected — video metadata
 */
app.get("/media/videos/:id", requireAuth, (req, res) => {
  const found = findVideoById(req.params.id);
  if (!found) return res.status(404).json({ error: "Video not found" });
  res.json(buildVideoMeta(found.drive, found.dirname));
});

/**
 * GET /media/videos/:id/stream/*
 * Public — serve any HLS file inside the video directory.
 *
 * The HLS player (HLS.js, video.js, native) fetches all files automatically
 * once given the masterUrl. Supports .m3u8 playlists, .ts segments,
 * .vtt/.srt subtitles, and audio track files.
 *
 * Cache-Control:
 *   .ts  → immutable 1 year  (segments are write-once, never modified)
 *   rest → 5 minutes         (playlists/subtitles may be updated via /files)
 */
app.get("/media/videos/:id/stream/*", (req, res) => {
  const found = findVideoById(req.params.id);
  if (!found) return res.status(404).json({ error: "Video not found" });

  const videoDir = path.join(found.drive, "videos", found.dirname);
  const requestedFile = req.params[0]; // wildcard: everything after /stream/
  const filePath = path.join(videoDir, requestedFile);

  // Security: path traversal check
  if (!path.resolve(filePath).startsWith(path.resolve(videoDir) + path.sep)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);

  res.setHeader("Cache-Control", ext === ".ts" ? "public, max-age=31536000, immutable" : "public, max-age=300");
  res.setHeader("Content-Type", getMimeType(filePath));
  res.setHeader("Content-Length", stat.size);
  fs.createReadStream(filePath).pipe(res);
});

/**
 * POST /media/videos/upload
 * Protected
 * Body: multipart/form-data
 *   file (required) — ZIP containing the HLS structure at root level
 *   name (optional) — display name; defaults to ZIP filename without .zip
 *
 * The ZIP root must contain master.m3u8 and quality subdirectories directly.
 * Build the ZIP on the client with:
 *   cd /path/to/ffmpeg-hls-output && zip -0 -r ~/movie.zip .
 *
 * Videos are NEVER transcoded on the Pi. Encode on your client with FFmpeg
 * before uploading. Recommended codec: H.265 (HEVC) — ~50% smaller than H.264.
 *
 * Drive selection: the drive with the most free space receives the upload.
 */
app.post("/media/videos/upload", requireAuth, (req, res) => {
  videoUpload.single("file")(req, res, async (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) {
      return res.status(400).json({ error: "No file provided. Use field name 'file' with a .zip." });
    }

    const id = generateId();
    const rawName = req.body.name || path.basename(req.file.originalname, ".zip");
    const dirname = buildStoredName(id, sanitizeName(rawName));
    const targetDrive = selectDrive();
    const targetDir = path.join(targetDrive, "videos", dirname);

    try {
      await extractZip(req.file.path, targetDir);
      fs.unlinkSync(req.file.path);

      // Validate: a valid HLS upload must have master.m3u8 at root
      if (!fs.existsSync(path.join(targetDir, "master.m3u8"))) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        return res.status(400).json({
          error: "Invalid HLS structure: master.m3u8 not found at ZIP root.",
          hint: "Build the ZIP from inside the HLS output directory: cd /hls-output && zip -0 -r movie.zip .",
        });
      }

      res.status(201).json(buildVideoMeta(targetDrive, dirname));
    } catch (uploadErr) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
      res.status(500).json({ error: "Upload failed", detail: uploadErr.message });
    }
  });
});

/**
 * POST /media/videos/:id/files
 * Protected
 * Add or replace a single file inside an existing video directory.
 * Use this to add subtitles or audio tracks without re-uploading the whole video.
 *
 * Body: multipart/form-data
 *   file (required) — .vtt, .srt, .m3u8, .ts, .aac, .ac3, .mp3
 *   path (optional) — relative path inside the video dir (default: file.originalname)
 *                     Examples: "subtitles_fr.vtt"
 *                               "audio_es.m3u8"
 *
 * If a file already exists at that path it is replaced.
 */
app.post("/media/videos/:id/files", requireAuth, (req, res) => {
  singleFileUpload.single("file")(req, res, async (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file provided. Use field name 'file'." });

    const found = findVideoById(req.params.id);
    if (!found) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ error: "Video not found" });
    }

    const videoDir = path.join(found.drive, "videos", found.dirname);
    const rawRelPath = req.body.path || req.file.originalname;
    const safeRelPath = path.normalize(rawRelPath.replace(/\\/g, "/"))
      .replace(/^(\.\.(\/|$))+/, "");
    const targetPath = path.join(videoDir, safeRelPath);

    // Security: path traversal check
    if (!path.resolve(targetPath).startsWith(path.resolve(videoDir) + path.sep)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(403).json({ error: "Invalid path." });
    }

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      await moveFile(req.file.path, targetPath);
      res.status(201).json({
        path: safeRelPath,
        url: `/media/videos/${found.id}/stream/${safeRelPath}`,
      });
    } catch (uploadErr) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      res.status(500).json({ error: "Failed to save file", detail: uploadErr.message });
    }
  });
});

/**
 * PATCH /media/videos/:id
 * Protected — rename a video
 * Body: { "name": "new-name" }
 * The ID stays the same — only the display name changes.
 */
app.patch("/media/videos/:id", requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Body must include { name: 'new-name' }" });
  }
  const found = findVideoById(req.params.id);
  if (!found) return res.status(404).json({ error: "Video not found" });
  const newDirname = buildStoredName(found.id, sanitizeName(name));
  const oldPath = path.join(found.drive, "videos", found.dirname);
  const newPath = path.join(found.drive, "videos", newDirname);
  if (fs.existsSync(newPath)) return res.status(409).json({ error: "A video with that name already exists." });
  try {
    fs.renameSync(oldPath, newPath);
    res.json(buildVideoMeta(found.drive, newDirname));
  } catch (err) {
    res.status(500).json({ error: "Failed to rename", detail: err.message });
  }
});

/**
 * DELETE /media/videos/:id
 * Protected — permanently deletes the entire video directory and all its segments.
 */
app.delete("/media/videos/:id", requireAuth, (req, res) => {
  const found = findVideoById(req.params.id);
  if (!found) return res.status(404).json({ error: "Video not found" });
  try {
    fs.rmSync(path.join(found.drive, "videos", found.dirname), { recursive: true, force: true });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to delete", detail: err.message });
  }
});

// ─── DEDUPLICATION ──────────────────────────────────────────────────────────

// Applies to photos only. Video deduplication at segment level is not meaningful —
// .ts segments differ slightly between encodings even for identical source material.

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
 * Scans photos across both drives, groups files with identical SHA-256 hashes.
 * Uses a per-drive cache — only new/changed files are re-hashed.
 * Nothing is deleted; use DELETE /media/files/:id to act on results.
 */
app.post("/media/deduplicate", requireAuth, async (req, res) => {
  let totalScanned = 0, totalRehashed = 0;
  const byHash = {};

  for (const dir of MEDIA_DIRS) {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, "photos")); } catch (_) { continue; }

    const cache = loadHashCache(dir);
    let rehashed = 0;

    for (const filename of entries) {
      if (!parseStoredName(filename)) continue;
      const filePath = path.join(dir, "photos", filename);
      let stat;
      try { stat = fs.statSync(filePath); } catch (_) { continue; }

      const mtime = stat.mtime.toISOString(), size = stat.size;
      const cached = cache[filename];
      if (!cached || cached.mtime !== mtime || cached.size !== size) {
        try { cache[filename] = { hash: await hashFile(filePath), mtime, size }; rehashed++; }
        catch (_) { continue; }
      }

      const { hash } = cache[filename];
      if (!byHash[hash]) byHash[hash] = [];
      byHash[hash].push({ drive: dir, filename });
    }

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
      files: items.map(({ drive, filename }) => buildPhotoMeta(drive, filename)).filter(Boolean),
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
  console.log(`🔒 Auth: JWT, expiry ${TOKEN_EXPIRY}`);
  console.log(`🖼️  WebP quality: ${WEBP_QUALITY}\n`);
  console.log(`Drives:`);
  for (const dir of MEDIA_DIRS) {
    const freeGB = (getDriveFreeBytes(dir) / 1024 / 1024 / 1024).toFixed(1);
    console.log(`  ${dir}  (${freeGB} GB free)`);
  }
  console.log(`\nEndpoints:`);
  console.log(`  POST   /auth/login                    → get JWT`);
  console.log(`  GET    /health                        → drive status (public)`);
  console.log(`  ── Photos ──`);
  console.log(`  GET    /media/files                   → list photos 🔒`);
  console.log(`  GET    /media/files/:id               → photo metadata 🔒`);
  console.log(`  GET    /media/files/:id/stream        → serve photo (public)`);
  console.log(`  POST   /media/upload                  → upload photos 🔒`);
  console.log(`  PATCH  /media/files/:id               → rename photo 🔒`);
  console.log(`  DELETE /media/files/:id               → delete photo 🔒`);
  console.log(`  POST   /media/deduplicate             → find duplicate photos 🔒`);
  console.log(`  ── Videos ──`);
  console.log(`  GET    /media/videos                  → list videos 🔒`);
  console.log(`  GET    /media/videos/:id              → video metadata 🔒`);
  console.log(`  GET    /media/videos/:id/stream/*     → serve HLS file (public)`);
  console.log(`  POST   /media/videos/upload           → upload video ZIP 🔒`);
  console.log(`  POST   /media/videos/:id/files        → add subtitle / audio track 🔒`);
  console.log(`  PATCH  /media/videos/:id              → rename video 🔒`);
  console.log(`  DELETE /media/videos/:id              → delete video 🔒\n`);
});
