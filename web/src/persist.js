import { useState } from 'react'

// Remember which device a tool had selected, so leaving to the Tools list and coming
// back doesn't drop you on the empty "pick a device" prompt. Kept per-tool and
// per-tab in sessionStorage, and silently harmless wherever storage is unavailable.
export function usePersistentSelection(key) {
  const k = 'bv.sel.' + key
  const [sel, setSel] = useState(() => {
    try { return sessionStorage.getItem(k) || null } catch { return null }
  })
  const set = (id) => {
    setSel(id)
    try { id ? sessionStorage.setItem(k, id) : sessionStorage.removeItem(k) } catch { /* private mode / blocked storage */ }
  }
  return [sel, set]
}
