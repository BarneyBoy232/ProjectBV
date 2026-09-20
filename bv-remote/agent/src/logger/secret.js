// SHARED SECRET — Logger's own, deliberately not the Remote or Monitor tool's.
//
// Every Logger command and every signalling blob (WebRTC offer/answer/ICE) is
// signed with this. The agent ignores anything that does not verify, so a reader
// of the open Firestore cannot start a session or hijack one.
//
// It must match web/src/tools/logger/secret.js exactly. Change both together, or
// Logger goes quiet and says so.
//
// Honest limitation, same as the other tools': a secret embedded in a distributed
// .exe can be extracted by someone who has the installer and looks hard enough. It
// stops opportunistic access to an open Firestore, not a determined attacker.
export const TOKEN = 'Lg7Qv2mZpX4tR9wKf1nYbH6sD8jC3aUeM0oP5iLtBqVzN7xW2rGkS4hE9uY6dToJ'
