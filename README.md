# xvid — local X video downloader

A small web app that runs on your own machine. Paste an X post URL, pick a quality, get the mp4 — or grab just the audio track as m4a/mp3. Extraction is handled by `yt-dlp`; nothing is proxied through a third party.

Only download content you own or have permission to use — X's terms of service prohibit downloading others' content without consent.

## Requirements

- Node.js 18+
- `yt-dlp` on PATH — `winget install yt-dlp` (Windows) or `pip install -U yt-dlp`
- `ffmpeg` on PATH (needed when merging separate video/audio streams) — `winget install ffmpeg`

## Run

```bash
npm install
npm start
# → http://localhost:3000
```

## How it works

- `POST /api/probe` runs `yt-dlp -j <url>` and returns title, thumbnail, duration, one mp4 video format per resolution (preferring the variant that already has audio muxed in), and which audio-only containers are available.
- `GET /api/download?url=&format=<id>` runs `yt-dlp -f "<id>[acodec=none]+bestaudio/<id>/..." --merge-output-format mp4` into a temp file, streams it to the browser with a `Content-Disposition` header, then deletes the temp file. X's higher-quality HLS variants are video-only with a separate AAC stream, so ffmpeg merges the two; progressive variants are passed through as-is.
- `GET /api/download?url=&audio=m4a|mp3` runs `yt-dlp -f bestaudio -x --audio-format <fmt>`. m4a is a straight remux of X's AAC track (no quality loss); mp3 is re-encoded via ffmpeg.
- URLs are validated against `x.com`/`twitter.com` status links only, and format ids are sanitized before being passed to the shell-free `spawn` call.

## Notes

- X changes its internals frequently; if extraction starts failing, update yt-dlp (`yt-dlp -U` or `pip install -U yt-dlp`).
- Age-gated or protected posts may require cookies; see yt-dlp's `--cookies-from-browser` flag if you hit that (you'd add it to the args in `server.js`).
- The server binds to localhost by default. Don't expose it publicly as-is — there's no auth or rate limiting.
