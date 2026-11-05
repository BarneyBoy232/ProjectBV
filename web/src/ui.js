// Shared styles + the trefoil mark, used across dashboard pages.
export const trefoilSvg = (size = 30) => ({
  __html: `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="49" fill="#111"/>
    <circle cx="50" cy="50" r="44" fill="#ffd200"/>
    <g fill="#111">
      <path d="M50 50 L30 15.36 A40 40 0 0 1 70 15.36 Z"/>
      <path d="M50 50 L90 50 A40 40 0 0 1 70 84.64 Z"/>
      <path d="M50 50 L30 84.64 A40 40 0 0 1 10 50 Z"/>
    </g>
    <circle cx="50" cy="50" r="15" fill="#ffd200"/>
    <circle cx="50" cy="50" r="9" fill="#111"/>
  </svg>`,
})

export const c = {
  panel: { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, padding: 20, marginBottom: 22 },
  sub: { margin: '0 0 14px', color: 'var(--dim)', fontSize: 13 },
  empty: { color: 'var(--dim)', textAlign: 'center', padding: 24 },
  label: { display: 'block', fontSize: 12, color: 'var(--dim)', margin: '0 0 5px' },
  input: { width: '100%', background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 8, padding: '9px 11px', font: 'inherit' },
  th: { textAlign: 'left', color: 'var(--dim)', fontWeight: 500, fontSize: 12, padding: '8px 10px', borderBottom: '1px solid var(--line)' },
  td: { padding: 10, borderBottom: '1px solid var(--line)', overflowWrap: 'anywhere' },
  primary: { background: 'var(--accent)', color: 'var(--accent-ink)', border: 0, borderRadius: 8, padding: '10px 18px', fontWeight: 650, cursor: 'pointer' },
  ghost: { background: 'transparent', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 14px', cursor: 'pointer' },
  h2: { margin: '0 0 4px', fontSize: 15 },
  dot: (on) => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 8, marginRight: 7, background: on ? 'var(--ok)' : '#5a5f66' }),
}

// A short "how long ago" label from an epoch-ms timestamp.
export function ago(ms) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// The BV Remote tool mark (screen + cursor), used in the Tools list + Remote page.
export const remoteLogoSvg = (size = 22) => ({
  __html: `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <rect x="14" y="20" width="72" height="50" rx="9" fill="none" stroke="#ffd200" stroke-width="7"/>
    <rect x="40" y="73" width="20" height="6" rx="3" fill="#ffd200"/>
    <rect x="28" y="83" width="44" height="6" rx="3" fill="#ffd200"/>
    <path d="M45 33 L45 61 L52 54 L57 65 L62 63 L57 52 L67 52 Z" fill="#ffd200"/>
  </svg>`,
})

// The Logger tool mark (an eye over a sound wave — watch + listen), used in the
// Tools list + Logger page.
export const loggerLogoSvg = (size = 22) => ({
  __html: `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <path d="M10 40 C28 20 72 20 90 40 C72 60 28 60 10 40 Z" fill="none" stroke="#ffd200" stroke-width="7" stroke-linejoin="round"/>
    <circle cx="50" cy="40" r="11" fill="#ffd200"/>
    <g stroke="#ffd200" stroke-width="6" stroke-linecap="round">
      <path d="M22 78 L22 74"/>
      <path d="M35 82 L35 66"/>
      <path d="M48 86 L48 60"/>
      <path d="M61 82 L61 66"/>
      <path d="M74 78 L74 74"/>
    </g>
  </svg>`,
})

// The Files tool mark (a folder with a down-arrow — browse + retrieve), used in
// the Tools list + Files page.
export const filesLogoSvg = (size = 22) => ({
  __html: `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <path d="M12 28 L40 28 L48 38 L88 38 L88 78 L12 78 Z" fill="none" stroke="#ffd200" stroke-width="7" stroke-linejoin="round"/>
    <g stroke="#ffd200" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="M50 50 L50 68"/>
      <path d="M40 60 L50 70 L60 60"/>
    </g>
  </svg>`,
})

// The Agent API tool mark (a key with a circuit node — an AI given a key), used
// in the Tools list + Agent API page.
export const agentApiLogoSvg = (size = 22) => ({
  __html: `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="32" cy="40" r="16" fill="none" stroke="#ffd200" stroke-width="7"/>
    <circle cx="32" cy="40" r="4" fill="#ffd200"/>
    <path d="M46 44 L84 82" fill="none" stroke="#ffd200" stroke-width="7" stroke-linecap="round"/>
    <path d="M70 68 L80 58 M78 76 L88 66" fill="none" stroke="#ffd200" stroke-width="7" stroke-linecap="round"/>
  </svg>`,
})

// The Monitor tool mark (a gauge dial), used in the Tools list + Monitor page.
export const monitorLogoSvg = (size = 22) => ({
  __html: `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <path d="M12 68 A38 38 0 1 1 88 68" fill="none" stroke="#ffd200" stroke-width="8" stroke-linecap="round"/>
    <path d="M50 62 L72 38" fill="none" stroke="#ffd200" stroke-width="7" stroke-linecap="round"/>
    <circle cx="50" cy="64" r="7" fill="#ffd200"/>
    <rect x="20" y="78" width="12" height="12" rx="3" fill="#ffd200"/>
    <rect x="44" y="78" width="12" height="12" rx="3" fill="#ffd200"/>
    <rect x="68" y="78" width="12" height="12" rx="3" fill="#ffd200"/>
  </svg>`,
})
