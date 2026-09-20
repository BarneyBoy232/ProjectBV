package files

import "fmt"

// The Firestore paths Files uses. These mirror web/src/tools/files/protocol.js
// exactly — the dashboard and this agent must agree on every one.
const root = "from_projectbv/files"

func agentDoc(id string) string   { return root + "/agents/" + id }
func enabledDoc(id string) string { return root + "/enabled/" + id }
func commandDoc(id string) string { return root + "/commands/" + id }
func resultDoc(id string) string  { return root + "/results/" + id }

// Where sealed bytes are relayed in Storage. out/ is device→dashboard (a PULL),
// in/ is dashboard→device (a PUSH).
func storageOut(id string) string { return "projectbv/files/out/" + id }

// The command verbs, matching CMD in protocol.js.
const (
	cmdList   = "list"
	cmdStat   = "stat"
	cmdPull   = "pull"
	cmdPush   = "push"
	cmdMkdir  = "mkdir"
	cmdRename = "rename"
	cmdMove   = "move"
	cmdCopy   = "copy"
	cmdDelete = "delete"
	cmdSearch = "search"
)

// makeID mirrors protocol.js makeId closely enough for our one use (naming a
// relay object): uniqueness, not format, is what matters there.
func makeID() string {
	return fmt.Sprintf("%d-%s", nowMillis(), randSuffix())
}
