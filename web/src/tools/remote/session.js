// Live screen + control session, dashboard side. The device is the WebRTC offerer;
// the dashboard answers, shows the video, and sends input over the data channel.
// Signaling is signed + verified so a Firestore reader can't hijack it.
import { db } from '../../firebase'
import { doc, setDoc, onSnapshot, collection, addDoc, getDocs, deleteDoc } from 'firebase/firestore'
import { CMD, PATHS, makeId, signBlob, verifyBlob } from './protocol'
import { TOKEN } from './secret'
import { runCommand } from './data'

export function startSession(deviceId, { onStream, onState }) {
  const nonce = makeId()
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  let channel = null
  let answered = false
  const unsubs = []

  pc.ontrack = (e) => onStream(e.streams[0])
  pc.ondatachannel = (e) => {
    channel = e.channel
    channel.onopen = () => onState('ready')
    channel.onclose = () => onState('closed')
  }
  pc.onconnectionstatechange = () => onState(pc.connectionState)
  pc.onicecandidate = async (e) => {
    if (!e.candidate) return
    const candidate = e.candidate.toJSON()
    const sig = await signBlob({ nonce, candidate }, TOKEN)
    addDoc(collection(db, ...PATHS.adminCandidates(deviceId)), { nonce, candidate, sig, ts: Date.now() }).catch(() => {})
  }

  unsubs.push(
    onSnapshot(doc(db, ...PATHS.session(deviceId)), async (snap) => {
      const d = snap.data()
      if (!d || d.nonce !== nonce || !d.offer || answered) return
      if (!(await verifyBlob({ nonce, offer: d.offer }, d.offerSig, TOKEN))) {
        onState('error:offer signature invalid')
        return
      }
      answered = true
      try {
        await pc.setRemoteDescription(d.offer)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        const payload = { type: answer.type, sdp: answer.sdp }
        const answerSig = await signBlob({ nonce, answer: payload }, TOKEN)
        await setDoc(doc(db, ...PATHS.session(deviceId)), { nonce, answer: payload, answerSig, ts: Date.now() }, { merge: true })
      } catch (e) {
        onState('error:' + e.message)
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
        if (await verifyBlob({ nonce, candidate: c.candidate }, c.sig, TOKEN)) pc.addIceCandidate(c.candidate).catch(() => {})
      })
    }),
  )

  onState('connecting')
  runCommand(deviceId, CMD.START_SESSION, { nonce }, 15000)
    .then((r) => {
      // The device refuses when the machine has no memory to spare. That is an
      // answer, not a failure, and it has to reach the operator as one.
      if (!r.ok) onState('blocked:' + (typeof r.output === 'string' ? r.output : 'the device declined to stream'))
    })
    .catch((e) => onState('error:' + e.message))

  // Counters so the UI can show whether input is actually leaving: if `dropped`
  // climbs while you move/type, the data channel isn't open and nothing is reaching
  // the device — the single likeliest cause of "controls do nothing".
  let sent = 0
  let dropped = 0
  function sendInput(evt) {
    if (channel && channel.readyState === 'open') { channel.send(JSON.stringify(evt)); sent++ }
    else dropped++
  }
  async function stop() {
    unsubs.forEach((fn) => fn())
    try { pc.close() } catch {}
    await runCommand(deviceId, CMD.STOP_SESSION, { nonce }, 8000).catch(() => {})
    for (const p of [PATHS.adminCandidates(deviceId), PATHS.deviceCandidates(deviceId)]) {
      const s = await getDocs(collection(db, ...p)).catch(() => null)
      if (s) await Promise.all(s.docs.map((dd) => deleteDoc(dd.ref).catch(() => {})))
    }
  }
  return {
    sendInput, stop, nonce,
    peer: pc,
    channelState: () => (channel ? channel.readyState : 'none'),
    io: () => ({ sent, dropped }),
  }
}
