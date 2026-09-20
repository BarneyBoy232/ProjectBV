import { useEffect, useState } from 'react'
import { listMembers, setMember, removeMember, ROOT_EMAIL } from './access'
import { listDevices } from './api'
import { c } from './ui'

// Admin-only. The live allow-list: who may sign in, their role, and which devices
// a scoped viewer can see. Root admin is fixed and shown but not editable.
export default function AccessPage() {
  const [members, setMembers] = useState([])
  const [devices, setDevices] = useState([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [picked, setPicked] = useState([])
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      const [m, d] = await Promise.all([listMembers(), listDevices()])
      setMembers(m); setDevices(d)
    } catch (e) { setMsg({ ok: false, text: e.message }) }
  }
  useEffect(() => { refresh() }, [])

  async function onAdd(e) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    try {
      await setMember(email, role, role === 'admin' ? 'all' : picked)
      setEmail(''); setRole('viewer'); setPicked([])
      setMsg({ ok: true, text: 'Saved.' })
      refresh()
    } catch (err) { setMsg({ ok: false, text: err.message }) }
    setBusy(false)
  }

  async function onRemove(m) {
    if (!confirm(`Remove ${m.email}? They lose all access immediately.`)) return
    try { await removeMember(m.email); refresh() } catch (err) { setMsg({ ok: false, text: err.message }) }
  }

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  return (
    <>
      <section style={c.panel}>
        <h2 style={c.h2}>Who can sign in</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr><th style={c.th}>Account</th><th style={c.th}>Role</th><th style={c.th}>Devices</th><th style={c.th}></th></tr></thead>
          <tbody>
            <tr>
              <td style={{ ...c.td, fontWeight: 600 }}>{ROOT_EMAIL}</td>
              <td style={c.td}>admin (root)</td>
              <td style={c.td}>all</td>
              <td style={c.td}></td>
            </tr>
            {members.map((m) => (
              <tr key={m.email}>
                <td style={{ ...c.td, fontWeight: 600 }}>{m.email}</td>
                <td style={c.td}>{m.role}</td>
                <td style={c.td}>{m.role === 'admin' ? 'all' : (m.devices || []).join(', ') || '—'}</td>
                <td style={{ ...c.td, textAlign: 'right' }}>
                  <button onClick={() => onRemove(m)} style={{ background: 'none', border: '1px solid var(--line)', color: '#ff5c5c', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={c.panel}>
        <h2 style={c.h2}>Add or update someone</h2>
        <form onSubmit={onAdd}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div><label style={c.label}>Google email</label><input style={c.input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@gmail.com" /></div>
            <div><label style={c.label}>Role</label>
              <select style={c.input} value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="viewer">Viewer — only the devices you pick</option>
                <option value="admin">Admin — every device + this access list</option>
              </select>
            </div>
          </div>
          {role === 'viewer' && (
            <div style={{ marginTop: 14 }}>
              <label style={c.label}>Devices this viewer can see</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                {devices.length === 0 && <span style={{ color: 'var(--dim)', fontSize: 13 }}>No devices in the fleet yet.</span>}
                {devices.map((d) => {
                  const on = picked.includes(d.id)
                  return (
                    <button type="button" key={d.id} onClick={() => toggle(d.id)}
                      style={{ background: on ? 'var(--accent)' : 'var(--panel2)', color: on ? 'var(--accent-ink)' : 'var(--dim)', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontSize: 13 }}>
                      {d.display || d.name || d.id}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button type="submit" style={{ ...c.primary, opacity: busy ? 0.5 : 1 }} disabled={busy}>Save</button>
            {msg && <span style={{ fontSize: 13, color: msg.ok ? 'var(--ok)' : '#ff5c5c' }}>{msg.text}</span>}
          </div>
        </form>
      </section>
    </>
  )
}
