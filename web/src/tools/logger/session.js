// Live watch session, dashboard side. The device is the WebRTC offerer; the
// dashboard answers, then receives the screen + speaker-output + microphone tracks
// and the one-way `capture` data channel carrying the device's real keyboard/mouse
// events. Signalling is signed + verified so a Firestore reader can't hijack it.
//
// Observe-only: there is no input-send path here. The dashboard cannot drive the
// device through a Logger session.
import { db } from '../../firebase'
import { doc, setDoc, onSnapshot, collection, addDoc, getDocs, deleteDoc } from 'firebase/firestore'
import { CMD, PATHS, makeId, signBlob, verifyBlob } from './protocol'
import { runCommand } from './data'

export function startSession(deviceId, { onStream, onCapture, onState }) {
  const nonce = makeId()
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  let answered = false
  const unsubs = []

  pc.ontrack = (e) => onStream && onStream(e.streams[0])
  // The device opens the `capture` channel and streams events to us.
  pc.ondatachannel = (e) => {
    if (e.channel.label !== 'capture') return
    e.channel.onopen = () => onState && onState('ready')
    e.channel.onmessage = (m) => {
      try { onCapture && onCapture(JSON.parse(m.data)) } catch {}
    }
  }
  pc.onconnectionstatechange = () => onState && onState(pc.connectionState)
  pc.onicecandidate = async (e) => {
    if (!e.candidate) return
    const candidate = e.candidate.toJSON()
    const sig = await signBlob({ nonce, candidate })
    addDoc(collection(db, ...PATHS.adminCandidates(deviceId)), { nonce, candidate, sig, ts: Date.now() }).catch(() => {})
  }

  unsubs.push(
    onSnapshot(doc(db, ...PATHS.session(deviceId)), async (snap) => {
      const d = snap.data()
      if (!d || d.nonce !== nonce || !d.offer || answered) return
      if (!(await verifyBlob({ nonce, offer: d.offer }, d.offerSig))) {
        onState && onState('error:offer signature invalid')
        return
      }
      answered = true
      try {
        await pc.setRemoteDescription(d.offer)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        const payload = { type: answer.type, sdp: answer.sdp }
        const answerSig = await signBlob({ nonce, answer: payload })
        await setDoc(doc(db, ...PATHS.session(deviceId)), { nonce, answer: payload, answerSig, ts: Date.now() }, { merge: true })
      } catch (e) {
        onState && onState('error:' + e.message)
      }
    }),
  )

  const seen = new Set()
  unsubs.push(
    onSnapshot(collection(db, ...PATHS.deviceCandidates(deviceId)), (snap) => {
      snap.docChanges().forEach(async (ch) => {
        if (ch.type !== 'added' || seen.has(ch.doc.id)) return
        seen.add(ch.doc.id)
        const c = ch.doc.data()
        if (c.nonce !== nonce) return
        if (await verifyBlob({ nonce, candidate: c.candidate }, c.sig)) pc.addIceCandidate(c.candidate).catch(() => {})
      })
    }),
  )

  onState && onState('connecting')
  runCommand(deviceId, CMD.START_SESSION, { nonce }, 15000)
    .then((r) => {
      // The device refuses when the machine has no memory to spare. That's an
      // answer, not a failure, and it has to reach the operator as one.
      if (!r.ok) onState && onState('blocked:' + (typeof r.output === 'string' ? r.output : 'the device declined to stream'))
    })
    .catch((e) => onState && onState('error:' + e.message))

  async function stop() {
    unsubs.forEach((fn) => fn())
    try { pc.close() } catch {}
    await runCommand(deviceId, CMD.STOP_SESSION, { nonce }, 8000).catch(() => {})
    for (const p of [PATHS.adminCandidates(deviceId), PATHS.deviceCandidates(deviceId)]) {
      const s = await getDocs(collection(db, ...p)).catch(() => null)
      if (s) await Promise.all(s.docs.map((dd) => deleteDoc(dd.ref).catch(() => {})))
    }
  }
  return { stop, nonce }
}
