import { useEffect, useMemo, useRef, useState } from 'react'
import { loadDevices, setEnabled } from './devices'
import { list, search, download, upload, mkdir, rename, move, copy, remove } from './data'
import { makeZip } from './zip'
import { usePersistentSelection } from '../../persist'
import { c, ago } from '../../ui'

// ---------------------------------------------------------------------------
// Fleet sidebar (mirrors the other tools) + the explorer for one device.
// ---------------------------------------------------------------------------
export default function FilesPage() {
  const [devices, setDevices] = useState([])
  const [selected, setSelected] = usePersistentSelection('device')
  const [err, setErr] = useState(null)

  async function refresh() {
    try { setDevices(await loadDevices()); setErr(null) }
    catch (e) { setErr('Cannot reach Firebase: ' + e.message) }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t) }, [])

  const device = devices.find((d) => d.id === selected) || null
  const ready = devices.filter((d) => d.agentOnline && d.enabled).length

  return (
    <div className="tool-grid">
      <aside>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={c.h2}>Fleet devices</h2>
          {devices.length > 0 && <span style={{ fontSize: 12, color: 'var(--dim)' }}>{ready} ready / {devices.length}</span>}
        </div>
        {err && <div style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 10 }}>{err}</div>}
        {devices.length === 0 ? <div style={c.empty}>No devices yet.</div> : devices.map((d) => {
          const on = selected === d.id
          const label = !d.hasAgent ? 'needs agent update'
            : !d.agentOnline ? `offline · ${ago(d.agentLastSeen)}`
            : d.enabled ? 'ready' : 'switched off'
          return (
            <button key={d.id} onClick={() => setSelected(d.id)}
              style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, cursor: 'pointer', background: on ? 'var(--panel2)' : 'transparent', border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, color: 'var(--text)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{d.name}</div>
              <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 3 }}><span style={c.dot(d.agentOnline && d.enabled)} />{label}</div>
            </button>
          )
        })}
      </aside>
      <main style={{ minWidth: 0 }}>
        {device ? <Explorer key={device.id} device={device} onChanged={refresh} /> : <div style={{ ...c.empty, marginTop: 40 }}>Pick a device to browse.</div>}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The explorer for one device.
// ---------------------------------------------------------------------------
function Explorer({ device, onChanged }) {
  const [path, setPath] = useState('') // '' = the synthetic root that lists drives
  const [entries, setEntries] = useState([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [sel, setSel] = useState(() => new Set())
  const [sort, setSort] = useState({ key: 'name', dir: 1 })
  const [finding, setFinding] = useState('')
  const [transfers, setTransfers] = useState([])
  const [anchor, setAnchor] = useState(null)
  const [goto, setGoto] = useState('')
  const uploadRef = useRef(null)

  const canUse = device.agentOnline && device.enabled

  async function open(p) {
    setBusy(true); setNote(null); setSel(new Set())
    try {
      const r = await list(device.id, p)
      setEntries(r.entries || [])
      setPath(r.path ?? p)
    } catch (e) { setNote({ bad: true, text: e.message }) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (canUse) open('') }, [device.id, canUse]) // eslint-disable-line

  const sorted = useMemo(() => {
    const arr = entries.slice()
    arr.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1 // folders first, always
      const k = sort.key
      let av = a[k], bv = b[k]
      if (k === 'name') return sort.dir * String(av || '').localeCompare(String(bv || ''))
      return sort.dir * ((av || 0) - (bv || 0))
    })
    return arr
  }, [entries, sort])

  const crumbs = useMemo(() => splitPath(path), [path])
  const selEntries = sorted.filter((e) => sel.has(e.name))
  const atRoot = !path

  // Selection with a shift-click range, anchored on the last plain click, over the
  // list in its current sorted order — the natural "grab everything from here to
  // there" for a bulk rescue.
  function toggle(index, ev) {
    const name = sorted[index]?.name
    if (name == null) return
    const next = new Set(sel)
    if (ev.shiftKey && anchor != null) {
      const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor]
      for (let i = lo; i <= hi; i++) next.add(sorted[i].name)
    } else {
      next.has(name) ? next.delete(name) : next.add(name)
      setAnchor(index)
    }
    setSel(next)
  }

  function toggleAll() {
    if (sel.size === sorted.length) setSel(new Set())
    else setSel(new Set(sorted.map((e) => e.name)))
  }

  function join(name) {
    if (!path) return name.endsWith('\\') ? name : name + '\\' // drive like "C:\"
    return path.replace(/\\+$/, '') + '\\' + name
  }

  // --- transfer bookkeeping -----------------------------------------------
  function track(label) {
    const id = Math.random().toString(36).slice(2)
    setTransfers((t) => [{ id, label, pct: 0, state: 'running' }, ...t].slice(0, 40))
    return {
      progress: (pct) => setTransfers((t) => t.map((x) => x.id === id ? { ...x, pct } : x)),
      done: (state = 'done', text) => setTransfers((t) => t.map((x) => x.id === id ? { ...x, pct: 1, state, text } : x)),
    }
  }

  async function doDownload(entry) {
    const t = track('↓ ' + entry.name)
    try {
      const { bytes, name } = await download(device.id, join(entry.name), { onProgress: t.progress })
      saveBlob(new Blob([bytes]), name)
      t.done()
    } catch (e) { t.done('failed', e.message) }
  }

  async function doDownloadSelection() {
    const files = selEntries.filter((e) => !e.isDir)
    const dirs = selEntries.filter((e) => e.isDir)
    for (const f of files) await doDownload(f)
    for (const d of dirs) await doZipFolder(d)
  }

  // Recursively pull a whole folder into one stored zip.
  async function doZipFolder(entry) {
    const base = join(entry.name)
    const t = track('zip ' + entry.name + '.zip')
    try {
      const files = []
      await collect(device.id, base, entry.name, files, (n) => t.progress(Math.min(0.05 * n, 0.4)))
      const packed = []
      let skipped = 0
      for (let i = 0; i < files.length; i++) {
        try {
          const { bytes } = await download(device.id, files[i].abs)
          packed.push({ name: files[i].rel, bytes })
        } catch { skipped++ } // a locked/unreadable file shouldn't sink the whole folder
        t.progress(0.4 + 0.6 * ((i + 1) / files.length))
      }
      saveBlob(makeZip(packed), entry.name + '.zip')
      t.done('done', `${packed.length} files${skipped ? `, ${skipped} skipped` : ''}`)
    } catch (e) { t.done('failed', e.message) }
  }

  async function doUpload(fileList) {
    for (const file of fileList) {
      const t = track('↑ ' + file.name)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        await upload(device.id, bytes, join(file.name), { onProgress: t.progress })
        t.done()
      } catch (e) { t.done('failed', e.message) }
    }
    open(path)
  }

  async function guarded(fn, okMsg) {
    setBusy(true); setNote(null)
    try { await fn(); if (okMsg) setNote({ text: okMsg }); await open(path) }
    catch (e) { setNote({ bad: true, text: e.message }) }
    finally { setBusy(false) }
  }

  async function doNewFolder() {
    const name = prompt('New folder name')
    if (!name) return
    guarded(() => mkdir(device.id, join(name)), 'Folder created.')
  }
  async function doRename() {
    const e = selEntries[0]
    if (!e) return
    const name = prompt('Rename to', e.name)
    if (!name || name === e.name) return
    guarded(() => rename(device.id, join(e.name), join(name)), 'Renamed.')
  }
  async function doDelete() {
    if (!selEntries.length) return
    // Honest wording: the agent runs as the system account, so a deleted item goes
    // to the Recycle Bin where Windows allows it but may not appear in the logged-in
    // user's own bin — and this tool can't restore it. Not a casual click.
    if (!confirm(`Delete ${selEntries.length} item(s) on ${device.name}? They go to the Recycle Bin where possible, but may not be restorable from the device's own bin.`)) return
    guarded(async () => { for (const e of selEntries) await remove(device.id, join(e.name)) }, 'Deleted (sent to the Recycle Bin where possible).')
  }
  async function doMoveCopy(kind) {
    if (!selEntries.length) return
    const dest = prompt(`Destination folder on the device to ${kind} into (full path, e.g. C:\\Users\\Public)`)
    if (!dest) return
    const fn = kind === 'move' ? move : copy
    guarded(async () => {
      for (const e of selEntries) await fn(device.id, join(e.name), dest.replace(/\\+$/, '') + '\\' + e.name)
    }, kind === 'move' ? 'Moved.' : 'Copied.')
  }

  async function doSearch(ev) {
    ev.preventDefault()
    if (!finding.trim() || atRoot) return
    setBusy(true); setNote(null)
    try {
      const r = await search(device.id, path, finding.trim())
      setEntries((r.entries || []).map((e) => ({ ...e, foundIn: true })))
      setNote({ text: `${(r.entries || []).length} match(es) under ${path}` })
    } catch (e) { setNote({ bad: true, text: e.message }) }
    finally { setBusy(false) }
  }

  if (!canUse) {
    return (
      <div style={c.panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={c.h2}>{device.name}</h2>
            <div style={c.sub}>{!device.hasAgent ? "This device's agent doesn't include Files yet. Push the latest BV Remote agent from the Remote tool to update it." : !device.agentOnline ? `Offline · last seen ${ago(device.agentLastSeen)}` : 'Files is switched off for this device.'}</div>
          </div>
          {device.hasAgent && device.agentOnline && (
            <button style={c.primary} onClick={async () => { await setEnabled(device.id, true); onChanged() }}>Switch on</button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* header: path + arm switch */}
      <div style={{ ...c.panel, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={c.h2}>{device.name}</h2>
            <Breadcrumb crumbs={crumbs} onGo={open} atRoot={atRoot} />
          </div>
          <button style={c.ghost} onClick={async () => { await setEnabled(device.id, false); onChanged() }}>Switch off</button>
        </div>
      </div>

      {/* toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <button style={c.ghost} disabled={atRoot} onClick={() => open(parentOf(path))}>↰ Up</button>
        <button style={c.ghost} disabled={atRoot} onClick={() => open(path)}>↻ Refresh</button>
        <span style={{ flex: 1 }} />
        <button style={c.ghost} disabled={!selEntries.length} onClick={doDownloadSelection}>Download</button>
        <button style={c.ghost} disabled={atRoot} onClick={() => uploadRef.current?.click()}>Upload</button>
        <input ref={uploadRef} type="file" multiple hidden onChange={(e) => { doUpload([...e.target.files]); e.target.value = '' }} />
        <button style={c.ghost} disabled={atRoot} onClick={doNewFolder}>New folder</button>
        <button style={c.ghost} disabled={selEntries.length !== 1} onClick={doRename}>Rename</button>
        <button style={c.ghost} disabled={!selEntries.length} onClick={() => doMoveCopy('move')}>Move</button>
        <button style={c.ghost} disabled={!selEntries.length} onClick={() => doMoveCopy('copy')}>Copy</button>
        <button style={{ ...c.ghost, borderColor: selEntries.length ? 'var(--bad)' : 'var(--line)', color: selEntries.length ? 'var(--bad)' : 'var(--dim)' }} disabled={!selEntries.length} onClick={doDelete}>Delete</button>
      </div>

      {/* jump straight to a known path — rescue often means going somewhere specific */}
      <form onSubmit={(ev) => { ev.preventDefault(); if (goto.trim()) open(goto.trim()) }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input style={{ ...c.input, flex: 1 }} placeholder="Go to path, e.g. C:\Users\Public\Documents" value={goto} onChange={(e) => setGoto(e.target.value)} />
        <button style={c.ghost} type="submit">Go</button>
      </form>

      {!atRoot && (
        <form onSubmit={doSearch} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input style={{ ...c.input, flex: 1 }} placeholder={`Search under ${path}…`} value={finding} onChange={(e) => setFinding(e.target.value)} />
          <button style={c.ghost} type="submit">Search</button>
        </form>
      )}

      {note && <div style={{ color: note.bad ? 'var(--bad)' : 'var(--dim)', fontSize: 13, marginBottom: 10 }}>{note.text}</div>}

      {/* listing */}
      <div style={{ ...c.panel, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...c.th, width: 28, textAlign: 'center' }}>
                <input type="checkbox" style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                  title="Select all in this folder"
                  checked={sorted.length > 0 && sel.size === sorted.length}
                  ref={(el) => { if (el) el.indeterminate = sel.size > 0 && sel.size < sorted.length }}
                  onChange={toggleAll} disabled={!sorted.length} />
              </th>
              <SortTh label="Name" k="name" sort={sort} setSort={setSort} />
              <SortTh label={atRoot ? 'Free / total' : 'Size'} k="size" sort={sort} setSort={setSort} right />
              <SortTh label="Modified" k="mtime" sort={sort} setSort={setSort} right />
            </tr>
          </thead>
          <tbody>
            {busy && !sorted.length && <tr><td style={c.td} colSpan={4}>Loading…</td></tr>}
            {!busy && !sorted.length && <tr><td style={{ ...c.td, color: 'var(--dim)' }} colSpan={4}>Empty.</td></tr>}
            {sorted.map((e, i) => (
              <tr key={e.name} style={{ background: sel.has(e.name) ? 'var(--panel2)' : 'transparent' }}>
                <td style={{ ...c.td, textAlign: 'center' }}>
                  <input type="checkbox" style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} checked={sel.has(e.name)} onChange={(ev) => toggle(i, ev.nativeEvent)} />
                </td>
                <td style={c.td}>
                  {e.isDir || atRoot
                    ? <button style={linkBtn} onClick={() => open(e.foundIn ? e.name : join(e.name))}><Icon dir /> {e.name}</button>
                    : e.foundIn
                      ? <button style={linkBtn} title={e.name} onClick={() => doDownload({ name: baseName(e.name) })}><Icon /> {e.name}</button>
                      : <button style={linkBtn} onClick={() => doDownload(e)}><Icon /> {e.name}</button>}
                  {(e.attrs || []).map((a) => <span key={a} style={pill}>{a}</span>)}
                </td>
                <td style={{ ...c.td, textAlign: 'right', color: 'var(--dim)' }}>
                  {atRoot ? (e.total ? `${fmtSize(e.free)} / ${fmtSize(e.total)}` : '') : e.isDir ? '' : fmtSize(e.size)}
                </td>
                <td style={{ ...c.td, textAlign: 'right', color: 'var(--dim)' }}>{e.mtime ? ago(e.mtime) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {transfers.length > 0 && <TransferQueue transfers={transfers} onClear={() => setTransfers((t) => t.filter((x) => x.state === 'running'))} />}
    </div>
  )
}

// --- recursive folder collector -------------------------------------------
async function collect(deviceId, absDir, relDir, out, onCount) {
  const r = await list(deviceId, absDir)
  for (const e of r.entries || []) {
    const abs = absDir.replace(/\\+$/, '') + '\\' + e.name
    const rel = relDir + '/' + e.name
    if (e.isDir) await collect(deviceId, abs, rel, out, onCount)
    else if (!e.attrs?.includes('locked')) { out.push({ abs, rel }); onCount?.(out.length) }
  }
}

// A tiny inline mark for a folder or file — SVG, not emoji, so it renders the same
// on every Windows font stack (the astral folder/file emoji show as tofu on many).
function Icon({ dir }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" style={{ verticalAlign: '-2px', marginRight: 2 }} aria-hidden="true">
      {dir
        ? <path d="M3 6 L9 6 L11 8.5 L21 8.5 L21 19 L3 19 Z" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" />
        : <path d="M6 3 L14 3 L18 7 L18 21 L6 21 Z M14 3 L14 7 L18 7" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" />}
    </svg>
  )
}

// --- small pieces ----------------------------------------------------------
function Breadcrumb({ crumbs, onGo, atRoot }) {
  return (
    <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 4, wordBreak: 'break-all' }}>
      <button style={linkBtn} onClick={() => onGo('')}>This PC</button>
      {crumbs.map((cru) => (
        <span key={cru.path}>
          <span style={{ margin: '0 6px', color: 'var(--line)' }}>›</span>
          <button style={linkBtn} onClick={() => onGo(cru.path)}>{cru.label}</button>
        </span>
      ))}
    </div>
  )
}

function SortTh({ label, k, sort, setSort, right }) {
  const active = sort.key === k
  return (
    <th style={{ ...c.th, textAlign: right ? 'right' : 'left', cursor: 'pointer', userSelect: 'none' }}
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : 1 }))}>
      {label}{active ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  )
}

function TransferQueue({ transfers, onClear }) {
  return (
    <div style={{ ...c.panel, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h2 style={c.h2}>Transfers</h2>
        <button style={c.ghost} onClick={onClear}>Clear finished</button>
      </div>
      {transfers.map((t) => (
        <div key={t.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ flex: 1, minWidth: 0, marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
            <span style={{ color: t.state === 'failed' ? 'var(--bad)' : 'var(--dim)' }}>{t.state === 'failed' ? (t.text || 'failed') : t.state === 'done' ? (t.text || 'done') : Math.round((t.pct || 0) * 100) + '%'}</span>
          </div>
          <div style={{ height: 4, background: 'var(--panel2)', borderRadius: 4, marginTop: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: (Math.round((t.pct || 0) * 100)) + '%', background: t.state === 'failed' ? 'var(--bad)' : 'var(--accent)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

const linkBtn = { background: 'none', border: 0, color: 'var(--text)', cursor: 'pointer', font: 'inherit', padding: 0, textAlign: 'left' }
const pill = { marginLeft: 8, fontSize: 11, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 6, padding: '1px 5px' }

// --- path helpers ----------------------------------------------------------
function splitPath(path) {
  if (!path) return []
  const parts = path.replace(/\\+$/, '').split('\\')
  const out = []
  let acc = ''
  for (let i = 0; i < parts.length; i++) {
    acc = i === 0 ? parts[0] + '\\' : acc.replace(/\\+$/, '') + '\\' + parts[i]
    out.push({ label: parts[i] || acc, path: acc })
  }
  return out
}
function parentOf(path) {
  const p = path.replace(/\\+$/, '')
  const i = p.lastIndexOf('\\')
  if (i <= 0) return '' // a drive root's parent is This PC
  const parent = p.slice(0, i)
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent
}
function baseName(p) { return p.split(/[\\/]/).pop() }
function fmtSize(n) {
  if (n == null) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i]
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
