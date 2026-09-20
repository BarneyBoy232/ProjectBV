// SHARED SECRET — Files' own, deliberately not Remote's or Monitor's.
//
// Must match internal/files/secret.go exactly. Change both together.
// Signs every command this dashboard sends, and seals every listing and every
// file blob that travels over world-readable Firebase/Storage.
export const TOKEN = 'vd8kfu3I0jY7jTWJKzXiKgBrrlpsag1AUMGNcd6fXA9Vg0OxDUaZPS5ACS3Mcb7y'
