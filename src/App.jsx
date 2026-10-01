import { useRef, useState } from 'react'

const IG_LINK = /^https?:\/\/(www\.|m\.)?instagram\.com\/\S+/i

function formatSize(bytes) {
  if (!bytes) return null
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `~${mb.toFixed(mb >= 10 ? 0 : 1)} MB` : `~${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatDuration(sec) {
  if (!sec) return null
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

async function api(path, body, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `Request failed (${res.status}). Is the server running?`)
  }
  return res
}

function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 60000)
}

export default function App() {
  const [url, setUrl] = useState('')
  const [reel, setReel] = useState(null)
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // null | { phase: 'preparing' | 'downloading' | 'done', pct }
  const [download, setDownload] = useState(null)
  const abortRef = useRef(null)

  const busy = download && download.phase !== 'done'

  async function fetchReel(link = url) {
    const value = link.trim()
    if (!value) return
    if (!IG_LINK.test(value)) {
      setError('Please paste a link that starts with https://www.instagram.com/')
      return
    }
    setError('')
    setReel(null)
    setDownload(null)
    setLoading(true)
    try {
      const data = await (await api('/api/info', { url: value })).json()
      setReel(data)
      setSelected(data.options[0]?.id ?? null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) return
      setUrl(text)
      fetchReel(text)
    } catch {
      setError('Clipboard access was blocked. Paste the link with Ctrl+V instead.')
    }
  }

  async function startDownload() {
    const option = reel.options.find((o) => o.id === selected)
    if (!option) return
    setError('')
    setDownload({ phase: 'preparing', pct: 0 })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await api('/api/download', { url: reel.url, format: option.id }, controller.signal)
      const total = Number(res.headers.get('Content-Length')) || 0
      const filename =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `reel_${reel.id}.${option.ext}`

      const reader = res.body.getReader()
      const chunks = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        setDownload({ phase: 'downloading', pct: total ? Math.round((received / total) * 100) : 0 })
      }
      saveBlob(new Blob(chunks, { type: res.headers.get('Content-Type') ?? 'application/octet-stream' }), filename)
      setDownload({ phase: 'done', pct: 100 })
    } catch (err) {
      setDownload(null)
      if (err.name !== 'AbortError') setError(err.message)
    }
  }

  function reset() {
    abortRef.current?.abort()
    setUrl('')
    setReel(null)
    setDownload(null)
    setError('')
  }

  const selectedOption = reel?.options.find((o) => o.id === selected)

  return (
    <div className="page">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" />
          </svg>
        </span>
        ReelGrab
      </header>

      <main className="main">
        <h1>
          Save any reel, <em>sound on.</em>
        </h1>
        <p className="lede">Paste a reel link, choose a format, and get the original file — full audio, no watermark.</p>

        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault()
            fetchReel()
          }}
        >
          <input
            type="url"
            inputMode="url"
            autoFocus
            spellCheck={false}
            placeholder="https://www.instagram.com/reel/…"
            aria-label="Instagram reel URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading || busy}
          />
          {url ? (
            <button type="button" className="ghost" onClick={reset} aria-label="Clear">
              Clear
            </button>
          ) : (
            <button type="button" className="ghost" onClick={pasteFromClipboard}>
              Paste
            </button>
          )}
          <button type="submit" className="primary" disabled={!url.trim() || loading || busy}>
            {loading ? <span className="spinner" aria-label="Loading" /> : 'Get reel'}
          </button>
        </form>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {loading && (
          <section className="card skeleton" aria-hidden="true">
            <div className="thumb" />
            <div className="skeleton-lines">
              <span />
              <span />
              <span />
              <span />
            </div>
          </section>
        )}

        {reel && (
          <section className="card">
            <div className="thumb">
              {reel.thumbnail && <img src={reel.thumbnail} alt="" />}
              {reel.duration && <span className="duration">{formatDuration(reel.duration)}</span>}
            </div>

            <div className="details">
              {reel.author && <p className="author">@{reel.author}</p>}
              <p className="caption">{reel.title || 'Instagram reel'}</p>

              {reel.silent && (
                <p className="notice" role="status">
                  <strong>Instagram sent this reel without sound.</strong>{' '}
                  {reel.loggedIn
                    ? 'Even with your login it has no audio track, so the download will be silent.'
                    : 'It does that for logged-out visitors on some reels that use a song from its music library. The download will be silent unless the server is given an Instagram login (see “Reels with no sound” in the README).'}
                </p>
              )}

              <fieldset className="options" disabled={busy}>
                <legend>Choose a format</legend>
                {reel.options.map((o) => (
                  <label key={o.id} className={`option ${selected === o.id ? 'is-selected' : ''}`}>
                    <input type="radio" name="format" value={o.id} checked={selected === o.id} onChange={() => setSelected(o.id)} />
                    <span className="option-icon" aria-hidden="true">
                      {o.kind === 'video' ? '▶' : '♪'}
                    </span>
                    <span className="option-text">
                      <strong>
                        {o.label}
                        {o.badge && <span className="badge">{o.badge}</span>}
                      </strong>
                      <small>{o.detail}</small>
                    </span>
                    <span className="option-size">{formatSize(o.size)}</span>
                  </label>
                ))}
              </fieldset>

              <button type="button" className="primary download" onClick={startDownload} disabled={!selectedOption || busy}>
                {busy && <span className="progress" style={{ width: `${download.phase === 'preparing' ? 8 : download.pct}%` }} />}
                <span className="download-label">
                  {!download && `Download ${selectedOption?.ext.toUpperCase() ?? ''}${reel.silent ? ' (no sound)' : ''}`}
                  {download?.phase === 'preparing' && 'Preparing your file…'}
                  {download?.phase === 'downloading' && `Downloading… ${download.pct}%`}
                  {download?.phase === 'done' && 'Saved ✓  Download again'}
                </span>
              </button>
            </div>
          </section>
        )}

        {!reel && !loading && (
          <ol className="steps">
            <li>
              <span>1</span>Copy the reel link from the Instagram share menu
            </li>
            <li>
              <span>2</span>Paste it above and pick MP4 video or MP3 audio
            </li>
            <li>
              <span>3</span>Hit download — the file saves straight to your device
            </li>
          </ol>
        )}
      </main>

      <footer className="footer">
        Works with public reels and video posts. Only download content you own or have permission to use. Not affiliated with
        Instagram or Meta.
      </footer>
    </div>
  )
}
