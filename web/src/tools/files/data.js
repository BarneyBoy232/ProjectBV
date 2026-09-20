// Files data layer — its own signed command bus, plus the Storage relay used to
// move actual file bytes in and out of a device.
//
// Self-contained by design: nothing here imports from Remote or Monitor. Files
// ships inside the same device agent, but it is a separate tool with its own
// secret, and neither should be able to break the other by changing its protocol.
import { db, storage, ensureAuth } from '../../firebase'
import { doc, setDoc, onSnapshot } from 'firebase/firestore'
import { ref, uploadBytes, getBlob, deleteObject } from 'firebase/storage'
import { PATHS, CMD, STORAGE_OUT, STORAGE_IN, makeId, sign, commandSig } from './protocol'
import { TOKEN } from './secret'

export { CMD }

// --- the command bus ------------------------------------------------------
// The secret never travels: the command's own fields are signed and only the
// signature is stored.
async function send(deviceId, cmd, args) {
  const id = makeId()
  const ts = Date.now()
  const fields = { id, cmd, args: args || {}, ts }
  await setDoc(doc(db, ...PATHS.command(deviceId)), { ...fields, sig: await commandSig(fields) })
  return id
}

// One command document and one result document per device means two commands in
// flight would overwrite each other's answer. A per-device queue makes that
// impossible without needing a document per command.
const queues = new Map()
export function runCommand(deviceId, cmd, args, timeoutMs = 30000) {
  const prev = queues.get(deviceId) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => once(deviceId, cmd, args, timeoutMs))
  const tail = next.catch(() => {})
  queues.set(deviceId, tail)
  tail.finally(() => { if (queues.get(deviceId) === tail) queues.delete(deviceId) })
  return next
}

function once(deviceId, cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let off = null
    let timer = null
    const done = () => { if (off) off(); if (timer) clearTimeout(timer) }
    send(deviceId, cmd, args)
      .then((id) => {
        off = onSnapshot(
          doc(db, ...PATHS.result(deviceId)),
          async (snap) => {
            const d = snap.data()
            if (!d || d.id !== id) return
            done()
            try { resolve(await openResult(d)) } catch (e) { reject(e) }
          },
          (err) => { done(); reject(err) },
        )
        timer = setTimeout(() => {
          done()
          reject(new Error(`No answer after ${Math.round(timeoutMs / 1000)}s — the Files agent may not be running on that device.`))
        }, timeoutMs)
      })
      .catch(reject)
  })
}

// A result may be sealed (listings carry usernames and full paths) or, for a
// simple ok/error, plain. `box` present means sealed.
async function openResult(d) {
  if (d.box) return JSON.parse(await unsealText(d.box))
  return d
}

// --- sealing (AES-GCM, key = SHA-256 of the shared secret) ----------------
// Same format the Go side uses: 12-byte IV, then ciphertext+tag, base64.
let keyPromise = null
function aesKey(usages) {
  if (!keyPromise) {
    keyPromise = crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN))
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']))
  }
  return keyPromise
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function sealBytes(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), bytes)
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), 12)
  return out
}

async function unsealBytes(raw) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(), raw.slice(12))
  return new Uint8Array(plain)
}

async function unsealText(base64) {
  return new TextDecoder().decode(await unsealBytes(unb64(base64)))
}

// --- browsing -------------------------------------------------------------
export function list(deviceId, path) {
  return runCommand(deviceId, CMD.LIST, { path: path || '' }, 30000).then(need)
}
export function search(deviceId, root, query, opts = {}) {
  return runCommand(deviceId, CMD.SEARCH, { root, query, ...opts }, 90000).then(need)
}
function need(r) {
  if (r && r.ok === false) throw errorFrom(r)
  return r
}
function errorFrom(r) {
  const out = r.output || r
  const e = new Error(out.error || (typeof out === 'string' ? out : 'the action failed'))
  e.needsAdmin = !!out.needsAdmin
  return e
}

// --- write actions --------------------------------------------------------
export function mkdir(deviceId, path) { return act(deviceId, CMD.MKDIR, { path }) }
export function rename(deviceId, from, to) { return act(deviceId, CMD.RENAME, { from, to }) }
export function move(deviceId, from, to) { return act(deviceId, CMD.MOVE, { from, to }) }
export function copy(deviceId, from, to) { return act(deviceId, CMD.COPY, { from, to }) }
export function remove(deviceId, path) { return act(deviceId, CMD.DELETE, { path }) }
async function act(deviceId, cmd, args) {
  const r = await runCommand(deviceId, cmd, args, 45000)
  return need(r)
}

// --- download: device -> Storage -> here ----------------------------------
// The device seals the file and uploads it under out/<id>; we fetch it, unseal,
// and hand back the bytes. We then delete the relay blob so Storage stays clean.
export async function download(deviceId, path, { onProgress } = {}) {
  await ensureAuth()
  const r = await runCommand(deviceId, CMD.PULL, { path }, 300000)
  need(r)
  const storagePath = r.storagePath
  const objRef = ref(storage, storagePath)
  try {
    const sealed = await getBlob(objRef)
    onProgress?.(1)
    const bytes = await unsealBytes(new Uint8Array(await sealed.arrayBuffer()))
    return { bytes, name: r.name || path.split(/[\\/]/).pop(), size: r.size }
  } finally {
    deleteObject(objRef).catch(() => {})
  }
}

// --- upload: here -> Storage -> device -------------------------------------
// We seal the bytes, upload under in/<id>, then tell the device to fetch, unseal
// and write them to `dest`. The device deletes the relay blob when it is done.
export async function upload(deviceId, bytes, dest, { onProgress } = {}) {
  await ensureAuth()
  const id = makeId()
  const storagePath = STORAGE_IN(id)
  const sealed = await sealBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  await uploadBytes(ref(storage, storagePath), sealed)
  onProgress?.(0.5)
  const r = await runCommand(deviceId, CMD.PUSH, { storagePath, dest }, 300000)
  onProgress?.(1)
  return need(r)
}
