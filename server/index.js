import express from 'express'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Deliberately not PORT: dev tooling sets that for the Vite server, which runs alongside this one.
const PORT = Number(process.env.API_PORT) || 3001
const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(
    path.dirname(require.resolve('youtube-dl-exec/package.json')),
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
  )
// Optional Netscape-format cookies file, for reels (or their music) that Instagram only serves to
// logged-in users. Checked per request, so dropping a cookies.txt into the project needs no restart.
const DEFAULT_COOKIES_FILE = path.join(__dirname, '..', 'cookies.txt')
function cookiesFile() {
  if (process.env.IG_COOKIES_FILE) return process.env.IG_COOKIES_FILE
  return existsSync(DEFAULT_COOKIES_FILE) ? DEFAULT_COOKIES_FILE : null
}
const MAX_CONCURRENT_DOWNLOADS = 4
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com'])
const MEDIA_PATH = /^\/(?:[\w.]+\/)?(reels?|p|tv)\/([\w-]+)/
const THUMB_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function parseInstagramUrl(raw) {
  let u
  try {
    u = new URL(String(raw).trim())
  } catch {
    throw new HttpError(400, 'That does not look like a valid URL.')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'That does not look like a valid URL.')
  if (!IG_HOSTS.has(u.hostname.toLowerCase())) throw new HttpError(400, 'Please paste an instagram.com reel link.')
  return u
}

// Returns a canonical https://www.instagram.com/reel/<code>/ URL, so nothing user-controlled
// beyond the shortcode ever reaches yt-dlp.
async function normalizeUrl(raw) {
  let u = parseInstagramUrl(raw)

  // "Share" links (instagram.com/share/reel/...) redirect to the real reel URL.
  if (u.pathname.startsWith('/share/')) {
    const res = await fetch(`https://www.instagram.com${u.pathname}`, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    }).catch(() => null)
    res?.body?.cancel()
    if (!res) throw new HttpError(502, 'Could not resolve that share link. Try the full reel URL instead.')
    u = parseInstagramUrl(res.url)
  }

  const m = u.pathname.match(MEDIA_PATH)
  if (!m) throw new HttpError(400, 'That link is not a reel or video post.')
  const kind = m[1].startsWith('reel') ? 'reel' : m[1]
  return `https://www.instagram.com/${kind}/${m[2]}/`
}

function friendlyError(stderr) {
  const s = stderr.toLowerCase()
  if (s.includes('login required') || s.includes('rate-limit') || s.includes('login_required') || s.includes('cookies'))
    return new HttpError(
      403,
      'Instagram wants a login for this reel (it may be private, age-restricted, or Instagram is rate-limiting this server).',
    )
  if (s.includes('404') || s.includes('not available') || s.includes('does not exist'))
    return new HttpError(404, 'Reel not found. It may have been deleted or the link is wrong.')
  if (s.includes('no video formats') || s.includes('there is no video'))
    return new HttpError(422, 'That post does not contain a video.')
  const last = stderr.trim().split('\n').filter((l) => l.startsWith('ERROR')).pop()
  return new HttpError(502, last ? last.replace(/^ERROR:\s*/, '') : 'Could not fetch that reel.')
}

function runYtDlp(args, { timeout = 60000, signal } = {}) {
  // Instagram's CDN throttles long single requests to a crawl; chunked range requests stay fast.
  const base = ['--no-warnings', '--no-playlist', '--http-chunk-size', '5M', '--ffmpeg-location', ffmpegPath]
  const cookies = cookiesFile()
  if (cookies) base.push('--cookies', cookies)
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, [...base, ...args], { windowsHide: true, timeout, signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) =>
      reject(err.name === 'AbortError' ? new HttpError(499, 'Cancelled.') : new HttpError(500, `Could not start yt-dlp: ${err.message}`)),
    )
    child.on('close', (code, sig) => {
      if (code === 0) resolve(stdout)
      else if (sig) reject(new HttpError(504, 'Instagram took too long to respond. Please try again.'))
      else reject(friendlyError(stderr))
    })
  })
}

function sizeOf(f, duration) {
  return f.filesize ?? f.filesize_approx ?? (f.tbr && duration ? Math.round(f.tbr * 125 * duration) : null)
}

function codecName(vcodec) {
  if (vcodec.startsWith('avc')) return 'H.264'
  if (vcodec.startsWith('vp09') || vcodec.startsWith('vp9')) return 'VP9'
  if (vcodec.startsWith('av01')) return 'AV1'
  if (vcodec.startsWith('hev') || vcodec.startsWith('hvc')) return 'HEVC'
  return vcodec.split('.')[0].toUpperCase()
}

function buildOptions(info) {
  const formats = info.formats ?? []
  const duration = info.duration
  const videos = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
  const audios = formats.filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none')
  const bestAudio = audios.sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio ? sizeOf(bestAudio, duration) : null
  const premuxed = formats.some((f) => f.vcodec !== 'none' && f.acodec !== 'none')
  // Instagram sometimes serves a reel with no sound at all (see the `silent` flag in /api/info).
  const hasAudio = audios.length > 0 || premuxed
  const sound = hasAudio ? 'video + audio' : 'no sound'

  // Mirrors the `-S res,vcodec:h264` sort used for the download: per resolution, H.264 wins, then bitrate.
  const isH264 = (f) => f.vcodec.startsWith('avc')
  const byHeight = new Map()
  for (const f of videos) {
    const cur = byHeight.get(f.height)
    if (!cur || isH264(f) > isH264(cur) || (isH264(f) === isH264(cur) && (f.tbr ?? 0) > (cur.tbr ?? 0))) byHeight.set(f.height, f)
  }

  const options = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .slice(0, 3)
    .map((f, i) => {
      const vSize = sizeOf(f, duration)
      const muxed = f.acodec && f.acodec !== 'none'
      return {
        id: `v${f.height}`,
        kind: 'video',
        ext: 'mp4',
        label: `MP4 · ${Math.min(f.width ?? f.height, f.height)}p`,
        detail: `${f.width ? `${f.width}×${f.height}` : `${f.height}p`} · ${codecName(f.vcodec)} · ${sound}`,
        size: vSize == null ? null : vSize + (muxed ? 0 : (audioSize ?? 0)),
        badge: i === 0 ? 'Highest quality' : null,
      }
    })

  // Instagram also serves a ready-made H.264 + AAC file. The sharper streams above are often VP9,
  // which some phones, editors and chat apps refuse, so lead with the one that plays anywhere.
  const topIsH264 = byHeight.size > 0 && isH264(byHeight.get(Math.max(...byHeight.keys())))
  if (premuxed && !topIsH264)
    options.unshift({
      id: 'compat',
      kind: 'video',
      ext: 'mp4',
      label: 'MP4 · Standard',
      detail: 'H.264 · video + audio · plays on every device and app',
      size: null,
      badge: 'Recommended',
    })

  if (options.length === 0)
    options.push({ id: 'v9999', kind: 'video', ext: 'mp4', label: 'MP4 · Original', detail: sound, size: null, badge: null })

  if (hasAudio) {
    options.push(
      { id: 'mp3', kind: 'audio', ext: 'mp3', label: 'MP3 · Audio only', detail: 'music / sound, plays everywhere', size: null, badge: null },
      { id: 'm4a', kind: 'audio', ext: 'm4a', label: 'M4A · Audio only', detail: 'original AAC track, no re-encode', size: audioSize, badge: null },
    )
  }
  return { options, silent: !hasAudio }
}

function ytDlpArgsFor(optionId) {
  if (optionId === 'mp3') return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
  if (optionId === 'm4a') return ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a']
  if (optionId === 'compat') return ['-f', 'b/bv*+ba', '--merge-output-format', 'mp4']
  const m = /^v(\d{3,4})$/.exec(optionId ?? '')
  if (!m) throw new HttpError(400, 'Unknown format.')
  const h = m[1]
  // Video-only stream + best audio stream, merged by ffmpeg into one MP4 with sound. The last two
  // fallbacks are video-only and are reached only when Instagram serves no audio for the reel at all.
  const withSound = `bv*[height<=${h}]+ba/b[height<=${h}][acodec!=?none]/bv*+ba/b[acodec!=?none]`
  return ['-f', `${withSound}/bv*[height<=${h}]/b`, '-S', 'res,vcodec:h264', '--merge-output-format', 'mp4']
}

const MIME = { mp4: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'video/webm', mkv: 'video/x-matroska' }

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '4kb' }))

app.post('/api/info', async (req, res, next) => {
  try {
    const url = await normalizeUrl(req.body?.url)
    let info = JSON.parse(await runYtDlp(['-J', url]))
    if (info._type === 'playlist') info = info.entries?.find((e) => e?.formats?.length)
    if (!info) throw new HttpError(422, 'That post does not contain a video.')
    res.json({
      url,
      id: info.id,
      title: (info.description || info.title || '').split('\n')[0].slice(0, 160),
      author: info.channel || info.uploader || info.uploader_id || null,
      duration: info.duration ?? null,
      thumbnail: info.thumbnail ? `/api/thumb?src=${encodeURIComponent(info.thumbnail)}` : null,
      // `silent`: Instagram returned no audio track. Without a login it does that for some reels
      // that use a licensed song, so the client needs `loggedIn` to explain which case this is.
      ...buildOptions(info),
      loggedIn: cookiesFile() !== null,
    })
  } catch (err) {
    next(err)
  }
})

// Instagram's CDN refuses cross-origin image embeds, so thumbnails are relayed through here.
app.get('/api/thumb', async (req, res, next) => {
  try {
    let src
    try {
      src = new URL(String(req.query.src))
    } catch {
      throw new HttpError(400, 'Bad thumbnail URL.')
    }
    if (src.protocol !== 'https:' || !THUMB_HOSTS.test(src.hostname)) throw new HttpError(400, 'Bad thumbnail URL.')
    const upstream = await fetch(src, { headers: { 'User-Agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout(15000) })
    const type = upstream.headers.get('content-type') ?? ''
    if (!upstream.ok || !type.startsWith('image/')) throw new HttpError(502, 'Thumbnail unavailable.')
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' })
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
  } catch (err) {
    next(err)
  }
})

let activeDownloads = 0

app.post('/api/download', async (req, res, next) => {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) return next(new HttpError(429, 'Server is busy. Please try again in a moment.'))
  activeDownloads++
  let dir
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })
  const cleanup = () => {
    activeDownloads--
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  try {
    const formatArgs = ytDlpArgsFor(req.body?.format)
    const url = await normalizeUrl(req.body?.url)
    dir = await mkdtemp(path.join(os.tmpdir(), 'instadl-'))
    await runYtDlp(
      [...formatArgs, '--no-part', '--restrict-filenames', '-o', path.join(dir, '%(channel,uploader_id|reel)s_%(id)s.%(ext)s'), url],
      { timeout: 5 * 60000, signal: abort.signal },
    )
    const name = (await readdir(dir))[0]
    if (!name) throw new HttpError(502, 'Download produced no file.')
    const file = path.join(dir, name)
    const { size } = await stat(file)
    const ext = path.extname(name).slice(1).toLowerCase()
    const safeName = name.replace(/[^\w.-]/g, '_')
    res.set({
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
    })
    const stream = createReadStream(file)
    stream.on('error', () => res.destroy())
    res.on('close', () => {
      stream.destroy()
      cleanup()
    })
    stream.pipe(res)
  } catch (err) {
    cleanup()
    next(err)
  }
})

// Production: serve the built React app from the same server.
const dist = path.join(__dirname, '..', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.use((req, res, next) => (req.method === 'GET' && !req.path.startsWith('/api/') ? res.sendFile(path.join(dist, 'index.html')) : next()))
}

app.use((req, res) => res.status(404).json({ error: 'Not found.' }))

app.use((err, req, res, _next) => {
  if (res.headersSent) return res.destroy()
  const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500)
  if (status >= 500) console.error(err)
  res.status(status).json({ error: err.status ? err.message : 'Something went wrong.' })
})

app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`))
