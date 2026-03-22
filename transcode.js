#!/usr/bin/env node
/**
 * Usage: node transcode.js <filename>
 * Example: node transcode.js "movie.mkv"
 *
 * Pre-processes a video in MEDIA_DIR into HLS format.
 * Output structure in Media/hls/<basename>/:
 *   master.m3u8        — master playlist (load this in the frontend)
 *   video/             — video-only HLS segments (stream-copied, no re-encoding)
 *   audio_N/           — one HLS audio stream per track (encoded to AAC)
 *   sub_N.vtt          — WebVTT subtitle files
 *   info.json          — track metadata for the frontend
 *
 * Requires: ffmpeg and ffprobe installed on the system.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, "Media");
const HLS_BASE = path.join(MEDIA_DIR, "hls");

// ─── HELPERS ────────────────────────────────────────────────────────────────

function ffprobe(filePath) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", filePath],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  if (result.error) throw new Error(`ffprobe not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function ffmpeg(args) {
  // stdio: inherit so the user sees FFmpeg's progress in the terminal
  const result = spawnSync("ffmpeg", ["-y", ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) throw new Error(`ffmpeg not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg exited with code ${result.status}`);
}

function buildMasterPlaylist(videoStream, audioStreams, subtitleTracks) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", ""];

  // Audio renditions
  if (audioStreams.length > 0) {
    audioStreams.forEach((s, i) => {
      const lang = s.tags?.language || "und";
      const name = s.tags?.title || (s.tags?.language?.toUpperCase()) || `Track ${i + 1}`;
      const isDefault = i === 0 ? "YES" : "NO";
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${lang}",` +
        `NAME="${name}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},` +
        `URI="audio_${i}/playlist.m3u8"`
      );
    });
    lines.push("");
  }

  // Subtitle renditions (single WebVTT file, not segmented)
  if (subtitleTracks.length > 0) {
    subtitleTracks.forEach((t, i) => {
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${t.lang}",` +
        `NAME="${t.name}",DEFAULT=NO,FORCED=NO,URI="sub_${i}.m3u8"`
      );
    });
    lines.push("");
  }

  // Approximate peak bandwidth from ffprobe (fallback to 5 Mbps)
  const bandwidth = parseInt(videoStream.bit_rate) || 5_000_000;
  const resolution = `${videoStream.width}x${videoStream.height}`;
  const streamAttrs = [`BANDWIDTH=${bandwidth}`, `RESOLUTION=${resolution}`];
  if (audioStreams.length > 0) streamAttrs.push(`AUDIO="audio"`);
  if (subtitleTracks.length > 0) streamAttrs.push(`SUBTITLES="subs"`);

  lines.push(`#EXT-X-STREAM-INF:${streamAttrs.join(",")}`);
  lines.push("video/playlist.m3u8");

  return lines.join("\n");
}

// A subtitle .m3u8 that references a single .vtt file (required by HLS spec for subtitles)
function buildSubtitlePlaylist(vttFilename, duration) {
  return [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:" + Math.ceil(duration),
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${duration.toFixed(3)},`,
    vttFilename,
    "#EXT-X-ENDLIST",
  ].join("\n");
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

function transcode(filename) {
  const inputPath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const baseName = path.parse(filename).name;
  const outputDir = path.join(HLS_BASE, baseName);
  fs.mkdirSync(outputDir, { recursive: true });

  // ── Probe ──────────────────────────────────────────────────────────────────
  console.log("🔍 Probing file...");
  const info = ffprobe(inputPath);

  const videoStream = info.streams.find((s) => s.codec_type === "video");
  const audioStreams = info.streams.filter((s) => s.codec_type === "audio");
  const subtitleStreams = info.streams.filter((s) => s.codec_type === "subtitle");
  const duration = parseFloat(info.format.duration) || 0;

  if (!videoStream) throw new Error("No video stream found");

  console.log(`📹 Video : ${videoStream.codec_name} ${videoStream.width}x${videoStream.height}`);
  console.log(`🔊 Audio : ${audioStreams.length} track(s)`);
  console.log(`💬 Subs  : ${subtitleStreams.length} track(s)`);
  console.log(`⏱  Duration: ${Math.round(duration / 60)} min\n`);

  // ── [1/3] Video HLS — stream-copy (no re-encoding, fast on Pi 5) ───────────
  console.log("[1/3] Packaging video segments (stream copy)...");
  const videoDir = path.join(outputDir, "video");
  fs.mkdirSync(videoDir, { recursive: true });

  ffmpeg([
    "-i", inputPath,
    "-map", "0:v:0",
    "-c:v", "copy",
    "-an",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(videoDir, "seg%05d.ts"),
    path.join(videoDir, "playlist.m3u8"),
  ]);
  console.log("   ✓ Video done");

  // ── [2/3] Audio HLS — one stream per track (AAC for browser compat) ────────
  console.log(`[2/3] Encoding ${audioStreams.length} audio track(s) to AAC...`);
  for (let i = 0; i < audioStreams.length; i++) {
    const s = audioStreams[i];
    const lang = s.tags?.language || "und";
    const label = s.tags?.title || lang;
    console.log(`   Track ${i}: ${label} (${s.codec_name})`);

    const audioDir = path.join(outputDir, `audio_${i}`);
    fs.mkdirSync(audioDir, { recursive: true });

    ffmpeg([
      "-i", inputPath,
      "-map", `0:a:${i}`,
      "-c:a", "aac",
      "-b:a", "192k",
      "-vn",
      "-hls_time", "6",
      "-hls_playlist_type", "vod",
      "-hls_flags", "independent_segments",
      "-hls_segment_filename", path.join(audioDir, "seg%05d.ts"),
      path.join(audioDir, "playlist.m3u8"),
    ]);
    console.log(`   ✓ Track ${i} done`);
  }

  // ── [3/3] Subtitles — extract to WebVTT ───────────────────────────────────
  console.log(`[3/3] Extracting ${subtitleStreams.length} subtitle track(s)...`);
  const subtitleTracks = [];

  for (let i = 0; i < subtitleStreams.length; i++) {
    const s = subtitleStreams[i];
    const lang = s.tags?.language || `sub${i}`;
    const name = s.tags?.title || (s.tags?.language?.toUpperCase()) || `Subtitle ${i + 1}`;
    const vttFile = `sub_${i}.vtt`;
    const vttPath = path.join(outputDir, vttFile);

    console.log(`   Sub ${i}: ${name} (${s.codec_name})`);

    const result = spawnSync("ffmpeg", [
      "-y", "-i", inputPath,
      "-map", `0:s:${i}`,
      "-c:s", "webvtt",
      vttPath,
    ], { stdio: ["ignore", "ignore", "ignore"] }); // suppress ffmpeg output for subs

    if (result.status === 0 && fs.existsSync(vttPath)) {
      // Write a minimal subtitle playlist referencing the .vtt file
      const subPlaylist = buildSubtitlePlaylist(vttFile, duration);
      fs.writeFileSync(path.join(outputDir, `sub_${i}.m3u8`), subPlaylist);
      subtitleTracks.push({ lang, name, file: vttFile });
      console.log(`   ✓ Sub ${i} done`);
    } else {
      console.warn(`   ⚠️  Could not extract sub ${i} — codec may not be supported`);
    }
  }

  // ── Master playlist ────────────────────────────────────────────────────────
  const master = buildMasterPlaylist(videoStream, audioStreams, subtitleTracks);
  fs.writeFileSync(path.join(outputDir, "master.m3u8"), master);

  // ── info.json (for the frontend) ──────────────────────────────────────────
  const infoJson = {
    filename,
    duration,
    videoCodec: videoStream.codec_name,
    width: videoStream.width,
    height: videoStream.height,
    audioTracks: audioStreams.map((s, i) => ({
      index: i,
      codec: s.codec_name,
      language: s.tags?.language || null,
      title: s.tags?.title || null,
    })),
    subtitleTracks,
    hlsReady: true,
  };
  fs.writeFileSync(path.join(outputDir, "info.json"), JSON.stringify(infoJson, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   Master playlist : Media/hls/${baseName}/master.m3u8`);
  console.log(`   Frontend URL    : /media/hls/${encodeURIComponent(baseName)}/master.m3u8`);
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const filename = process.argv[2];
if (!filename) {
  console.error("Usage: node transcode.js <filename>");
  console.error('Example: node transcode.js "movie.mkv"');
  process.exit(1);
}

try {
  transcode(filename);
} catch (err) {
  console.error("❌ Error:", err.message);
  process.exit(1);
}
