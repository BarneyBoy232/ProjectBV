package agentapi

// Agent API's own corner of Firestore. Mirrors the Worker's path helpers exactly.
// Everything lives under from_projectbv/agentapi/ so it never clashes with another
// tool's bus.
//
//	agents/{device}    device presence + armed state     (device writes)
//	enabled/{device}   the master arm switch              (operator writes)
//	commands/{device}  one signed command at a time       (Worker writes)
//	results/{device}   one sealed result at a time        (device writes)

const root = "from_projectbv/agentapi"

func agentDoc(id string) string   { return root + "/agents/" + id }
func enabledDoc(id string) string { return root + "/enabled/" + id }
func commandDoc(id string) string { return root + "/commands/" + id }
func resultDoc(id string) string  { return root + "/results/" + id }

// Command vocabulary. Kept small and sharp: `exec` is the universal primitive
// (anything a SYSTEM shell can do), and the rest are clean, reliable file/system
// primitives the AI can use without parsing shell output.
const (
	cmdExec   = "exec"   // run a program / PowerShell / cmd line, capture output
	cmdRead   = "read"   // read a file's bytes (returned base64 inside the result)
	cmdWrite  = "write"  // write base64 bytes to a path
	cmdList   = "list"   // list a directory (or the drive roots for an empty path)
	cmdDelete = "delete" // send a path to the Recycle Bin (recoverable)
	cmdInfo   = "info"   // basic machine facts so the AI can orient itself
)
