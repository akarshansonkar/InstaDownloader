# ReelGrab

Paste an Instagram reel link, pick a format, download it with audio.

- **Frontend:** React 19 + Vite (`src/`)
- **Backend:** Express (`server/index.js`), which runs `yt-dlp` to fetch the reel and `ffmpeg` to merge video + audio or convert to MP3. Both binaries are installed by `npm install` — nothing else to set up.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API runs on port 3001 and Vite proxies `/api` to it.

## Production

```bash
npm run build
npm start
```

One server on http://localhost:3001 serves both the built site and the API.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_PORT` | `3001` | Port for the Express server |
| `IG_COOKIES_FILE` | `./cookies.txt` if present | Path to a Netscape-format `cookies.txt` exported from a logged-in browser. Needed only for reels (or their music) that Instagram won't serve anonymously. |
| `YTDLP_PATH` | bundled binary | Use a different `yt-dlp` executable |

## Formats

| Option | What you get |
| --- | --- |
| MP4 · Standard | Instagram's ready-made H.264 + AAC file. Plays everywhere. |
| MP4 · 1080p / 720p / … | Sharpest streams (often VP9) merged with the audio track |
| MP3 | Audio only, re-encoded |
| M4A | Audio only, original AAC track |

## Reels with no sound

For some reels that use a song from Instagram's music library, Instagram sends logged-out visitors a video with **no audio track at all** — the website itself plays them silently until you log in. The app detects this and warns you before you download.

To get the sound for those reels, the server needs to fetch them as a logged-in user:

1. Log in to instagram.com in your browser (a spare account is safer than your main one — Instagram can restrict accounts it sees automating).
2. Export that site's cookies in Netscape format with a browser extension such as "Get cookies.txt LOCALLY".
3. Save the file as `cookies.txt` in this project folder (it is git-ignored). No restart needed.

Treat `cookies.txt` like a password: anyone who has it can use that Instagram account.

## Notes

- Instagram changes its site often. If downloads start failing, update the extractor: `npm update youtube-dl-exec` (or `node_modules/youtube-dl-exec/bin/yt-dlp -U`).
- Only download content you own or have permission to use.
