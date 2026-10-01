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

// Audio-only output containers we support. m4a is a lossless remux of X's AAC
// track (fast, no quality loss); mp3 re-encodes for compatibility.
const AUDIO_FORMATS = new Set(["m4a", "mp3"]);

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
      // yt-dlp -j prints one JSON object per line; a post carrying several
      // videos arrives as multiple entries (--no-playlist does not collapse
      // those). Parse the first entry — the card below shows a single video.
      let info;
      try {
        const line = stdout.split("\n").map(l => l.trim()).find(Boolean);
        if (!line) throw new Error("extractor returned no output");
        info = JSON.parse(line);
      } catch (e) {
        console.error("[probe] could not parse yt-dlp output:", e.message);
        console.error("[probe] stdout head:", JSON.stringify(stdout.slice(0, 300)));
        return res.status(500).json({ error: `Could not parse extractor output: ${e.message}` });
      }

      try {
        const all = info.formats || [];

        // X exposes two families of video formats:
        //   http-<tbr>  progressive mp4, audio muxed in (yt-dlp leaves vcodec/acodec unset)
        //   hls-<tbr>   video-only HLS variant (acodec === "none"), audio in a separate hls-audio-* stream
        // Keep anything that has video, remember whether it carries audio, then
        // collapse to one entry per resolution — preferring the muxed one.
        const byHeight = new Map();
        for (const f of all) {
          if (f.vcodec === "none" || f.ext !== "mp4") continue;
          const hasAudio = f.acodec !== "none";
          const key = f.height || f.format_id;
          const cur = byHeight.get(key);
          const better = !cur || (hasAudio && !cur.hasAudio) || (hasAudio === cur.hasAudio && (f.tbr || 0) > (cur.tbr || 0));
          if (better) {
            byHeight.set(key, {
              id: f.format_id,
              width: f.width,
              height: f.height,
              tbr: f.tbr,
              hasAudio,
              label: f.height ? `${f.height}p` : f.format_id,
              filesize: f.filesize || f.filesize_approx || null,
            });
          }
        }
        const formats = [...byHeight.values()]
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .map(({ tbr, ...rest }) => rest);

        const hasAudioStream = all.some(f => f.acodec && f.acodec !== "none");

        res.json({
          id: info.id,
          title: info.title || "untitled",
          uploader: info.uploader || info.uploader_id || "",
          duration: info.duration || null,
          thumbnail: info.thumbnail || null,
          formats,
          audio: hasAudioStream ? [...AUDIO_FORMATS] : [],
        });
      } catch (e) {
        console.error("[probe] failed building format list:", e);
        res.status(500).json({ error: `Could not read format list: ${e.message}` });
      }
    }
  );
});

// --- Download: pull to temp file, stream to client, clean up -----------
// GET /api/download?url=&format=<id>          → mp4 with audio merged in
// GET /api/download?url=&audio=m4a|mp3        → audio track only
app.get("/api/download", (req, res) => {
  const url = (req.query.url || "").trim();
  const formatId = (req.query.format || "").trim();
  const audio = (req.query.audio || "").trim().toLowerCase();
  if (!validUrl(url)) return res.status(400).send("Invalid URL.");
  if (formatId && !/^[\w.+-]+$/.test(formatId)) return res.status(400).send("Invalid format id.");
  if (audio && !AUDIO_FORMATS.has(audio)) return res.status(400).send("Invalid audio format.");

  const token = crypto.randomBytes(8).toString("hex");
  const outTemplate = path.join(TMP, `${token}.%(ext)s`);

  let args;
  if (audio) {
    // Grab the best audio stream and extract/remux it. -x runs ffmpeg; for m4a
    // the AAC track is copied as-is, for mp3 it's re-encoded.
    args = [
      "-f", "bestaudio/best",
      "-x", "--audio-format", audio,
      "--audio-quality", "0",
    ];
  } else {
    // If the chosen video stream is video-only (X's HLS variants), merge in the
    // best audio stream — whatever container it comes in. X serves its HLS audio
    // with ext=mp4, so filtering bestaudio on ext=m4a matched nothing and the
    // old selector silently fell back to a muted video. The [acodec=none]
    // guard keeps progressive (already-muxed) formats from getting a second
    // audio track mapped in.
    const fmt = formatId
      ? `${formatId}[acodec=none]+bestaudio/${formatId}/best[ext=mp4]/best`
      : "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best";
    args = ["-f", fmt, "--merge-output-format", "mp4"];
  }

  args.push("--no-playlist", "--no-warnings", "-o", outTemplate, url);

  const proc = spawn("yt-dlp", args);
  let stderrBuf = "";
  proc.stderr.on("data", d => (stderrBuf += d));

  proc.on("close", code => {
    if (code !== 0) {
      const msg = stderrBuf.split("\n").find(l => l.includes("ERROR")) || "Download failed.";
      return res.status(502).send(msg.replace(/^ERROR:\s*/, ""));
    }
    // With -x the intermediate file is removed by yt-dlp; only the final
    // container should remain. Prefer the requested extension if several exist.
    const candidates = fs.readdirSync(TMP).filter(f => f.startsWith(token + "."));
    const file = candidates.find(f => audio && f.endsWith("." + audio)) || candidates[0];
    if (!file) return res.status(500).send("Output file missing.");
    const full = path.join(TMP, file);
    const ext = path.extname(file) || (audio ? "." + audio : ".mp4");
    const base = audio ? "x-audio" : "x-video";

    res.download(full, `${base}-${Date.now()}${ext}`, () => {
      for (const c of candidates) fs.unlink(path.join(TMP, c), () => {});
    });
  });

  proc.on("error", () => {
    res.status(500).send("Could not launch yt-dlp. Is it installed and on PATH?");
  });
});

app.listen(PORT, () => {
  console.log(`x-video-downloader running → http://localhost:${PORT}`);
});
