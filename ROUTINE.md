# Standing routines

- Push to GitHub — whenever any file changed this chat.
  Verify: `git status` clean and the new commit visible on the remote.

- Keep the Agent API signing secret in sync — whenever agentApiToken in
  internal/config/embedded-config.json OR the Worker's AGENTAPI_TOKEN changes.
  Verify: agentApiToken (baked into the built agent) equals the Worker's
  AGENTAPI_TOKEN (a mismatch makes every AI command fail the signature check).

- Redeploy the Agent API Worker — whenever anything in agent-api/ changed.
  Verify: `wrangler deploy` succeeded and GET / on the Worker URL returns `ok:true`.

- Redeploy Firestore rules — whenever firestore.rules changed.
  Verify: `firebase deploy --only firestore:rules` reported success.

- Rebuild + push the agent to the fleet — whenever code under internal/ or cmd/ that
  ships in the installed agent changed.
  Verify: the agent version pushed in the manifest matches config.Version, and a test
  device checks in on the new version.

- Confirm the Vercel dashboard deploy went green — after every push touching web/.
  Verify: latest deployment is Ready and the live console serves the new build.
