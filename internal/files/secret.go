// Package files is the device side of the dashboard's Files tool: a signed
// command bus over Firestore plus a Firebase Storage relay for the actual bytes,
// letting the operator browse, download, upload and reorganise this machine's
// disk from the dashboard with nobody logged in.
//
// It runs inside the projectBV service (LocalSystem, auto-start at boot), which is
// what makes it a genuine rescue tool: it answers even when no user is signed in,
// and it can reach every profile and system folder.
package files

// TOKEN is the Files tool's shared secret — deliberately its own, not Remote's or
// Monitor's. It must match web/src/tools/files/secret.js exactly. Change both
// together. It signs every command this device accepts and is the AES-GCM key
// material (via SHA-256) for every listing and file blob that crosses the
// world-readable Firebase/Storage.
const TOKEN = "vd8kfu3I0jY7jTWJKzXiKgBrrlpsag1AUMGNcd6fXA9Vg0OxDUaZPS5ACS3Mcb7y"

// StorageBucket is the Firebase Storage bucket, same value as the web config's
// storageBucket. The relay uploads/downloads under projectbv/files/ here.
const StorageBucket = "runik-77e07.firebasestorage.app"
