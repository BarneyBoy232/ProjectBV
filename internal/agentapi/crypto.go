package agentapi

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"
)

// --- signing --------------------------------------------------------------
// verifyCommand recomputes the Worker's signature and compares it in constant
// time. The signed string is exactly the Worker's commandSig (agent-api/src):
//
//	`${id}|${cmd}|${ts}|${stable(args)}`
//
// so `stable` below reproduces JavaScript's stable-stringify byte for byte. This
// is kept identical to internal/files/crypto.go so the two tools stay in lockstep
// even though they deliberately do not share code.
func verifyCommand(id, cmd string, ts int64, args map[string]any, sig string) bool {
	msg := fmt.Sprintf("%s|%s|%d|%s", id, cmd, ts, stable(args))
	mac := hmac.New(sha256.New, []byte(token))
	mac.Write([]byte(msg))
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(sig))
}

// stable mirrors JS stable(): primitives via JSON, arrays in order, objects with
// keys sorted, no whitespace.
func stable(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return jsonString(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	case float64:
		// Match JS: an integer-valued number prints with no decimal point.
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'g', -1, 64)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = stable(e)
		}
		return "[" + join(parts, ",") + "]"
	case []string:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = jsonString(e)
		}
		return "[" + join(parts, ",") + "]"
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, jsonString(k)+":"+stable(x[k]))
		}
		return "{" + join(parts, ",") + "}"
	default:
		return "null"
	}
}

// jsonString matches JSON.stringify(s): standard JSON escaping, and crucially NO
// HTML escaping (Go's default would turn < > & into \u00xx, which JS does not).
func jsonString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return string(bytes.TrimRight(buf.Bytes(), "\n"))
}

func join(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}

// --- sealing (AES-GCM) ----------------------------------------------------
// seal uses the same format as the Worker: key = SHA-256(TOKEN), a fresh 12-byte
// IV prepended to the ciphertext (which carries GCM's tag), base64.
func aesKey() []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func seal(plain []byte) (string, error) {
	block, err := aes.NewCipher(aesKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	ct := gcm.Seal(nil, iv, plain, nil)
	return base64.StdEncoding.EncodeToString(append(iv, ct...)), nil
}

func nowMillis() int64 { return time.Now().UnixMilli() }
