// X Video Downloader — local server
// Wraps yt-dlp for extraction. Requires: node 18+, yt-dlp, ffmpeg on PATH.

const express = require("express");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TMP = path.join(os.tmpdir(), "xvid-dl");
fs.mkdirSync(TMP, { recursive: true });

// Only accept X / Twitter URLs so this stays a single-purpose tool.
const X_URL = /^https?:\/\/(www\.|mobile\.)?(x\.com|twitter\.com)\/[^/]+\/status\/\d+/i;

function validUrl(u) {
  return typeof u === "string" && X_URL.test(u.trim());
}

// --- Probe: fetch metadata + available formats -------------------------
app.post("/api/probe", (req, res) => {
  const url = (req.body.url || "").trim();
  if (!validUrl(url)) {
    return res.status(400).json({ error: "That doesn't look like an X post URL (expected x.com/<user>/status/<id>)." });
  }

  execFile(
    "yt-dlp",
    ["-j", "--no-playlist", "--no-warnings", url],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
    (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").split("\n").find(l => l.includes("ERROR")) || "Extraction failed.";
        return res.status(502).json({ error: msg.replace(/^ERROR:\s*/, "") });
      }
      try {
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
          .filter(f => f.vcodec && f.vcodec !== "none" && f.ext === "mp4")
          .map(f => ({
            id: f.format_id,
            width: f.width,
            height: f.height,
            label: f.height ? `${f.height}p` : f.format_id,
            filesize: f.filesize || f.filesize_approx || null,
          }))
          .sort((a, b) => (b.height || 0) - (a.height || 0));

        res.json({
          id: info.id,
          title: info.title || "untitled",
          uploader: info.uploader || info.uploader_id || "",
          duration: info.duration || null,
          thumbnail: info.thumbnail || null,
          formats,
        });
      } catch {
        res.status(500).json({ error: "Could not parse extractor output." });
      }
    }
  );
});

// --- Download: pull to temp file, stream to client, clean up -----------
app.get("/api/download", (req, res) => {
  const url = (req.query.url || "").trim();
  const formatId = (req.query.format || "").trim();
  if (!validUrl(url)) return res.status(400).send("Invalid URL.");
  if (formatId && !/^[\w.+-]+$/.test(formatId)) return res.status(400).send("Invalid format id.");

  const token = crypto.randomBytes(8).toString("hex");
  const outTemplate = path.join(TMP, `${token}.%(ext)s`);

  // Pin format to mp4; merge audio if the chosen video stream is video-only.
  const fmt = formatId ? `${formatId}+bestaudio[ext=m4a]/${formatId}/best[ext=mp4]/best` : "best[ext=mp4]/best";

  const args = [
    "-f", fmt,
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--no-warnings",
    "-o", outTemplate,
    url,
  ];

  const proc = spawn("yt-dlp", args);
  let stderrBuf = "";
  proc.stderr.on("data", d => (stderrBuf += d));

  proc.on("close", code => {
    if (code !== 0) {
      const msg = stderrBuf.split("\n").find(l => l.includes("ERROR")) || "Download failed.";
      return res.status(502).send(msg.replace(/^ERROR:\s*/, ""));
    }
    const file = fs.readdirSync(TMP).find(f => f.startsWith(token + "."));
    if (!file) return res.status(500).send("Output file missing.");
    const full = path.join(TMP, file);
    const ext = path.extname(file) || ".mp4";

    res.download(full, `x-video-${Date.now()}${ext}`, () => {
      fs.unlink(full, () => {});
    });
  });

  proc.on("error", () => {
    res.status(500).send("Could not launch yt-dlp. Is it installed and on PATH?");
  });
});

app.listen(PORT, () => {
  console.log(`x-video-downloader running → http://localhost:${PORT}`);
});
