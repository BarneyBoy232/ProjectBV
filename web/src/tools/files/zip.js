// A tiny STORE-only ZIP writer, so downloading a whole folder needs no
// dependency. Files pulled off a device are already whole files; we are only
// bundling them, not trying to compress them, so "stored" (no compression) is
// exactly right and keeps this to a page of code.
//
// entries: [{ name: 'sub/dir/file.txt', bytes: Uint8Array }]
// Returns a Blob (application/zip).

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// DOS date/time — ZIP predates Unix time. We just stamp "now".
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export function makeZip(entries) {
  const enc = new TextEncoder()
  const chunks = []
  const central = []
  let offset = 0
  const { time, date } = dosDateTime()

  const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff])
  const u32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])

  for (const e of entries) {
    const nameBytes = enc.encode(e.name.replace(/\\/g, '/'))
    const data = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes)
    const crc = crc32(data)

    // Local file header (method 0 = store).
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, data,
    ])
    chunks.push(local)

    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBytes,
    ]))
    offset += local.length
  }

  const centralStart = offset
  let centralSize = 0
  for (const c of central) { chunks.push(c); centralSize += c.length }

  chunks.push(concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralSize), u32(centralStart), u16(0),
  ]))

  return new Blob(chunks, { type: 'application/zip' })
}

function concat(parts) {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
