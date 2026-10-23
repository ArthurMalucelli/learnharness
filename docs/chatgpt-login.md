# ChatGPT subscription connection (local fork)

This fork starts at LearnHarness v0.3.4 and keeps Pi 1.4.0, all learning prompts,
agent workflows, model slots, and learning-record formats. It adds desktop-only
ChatGPT authentication. It is not an official OpenAI or LearnHarness release.

## Use

1. In the packaged Mac app, open initial model setup or Settings → Keys.
2. Choose **Continue with ChatGPT**. Complete sign-in and allow use of your
   ChatGPT plan in the system browser.
3. Select the Strong, Cheap, and Vision models using the existing controls.
   Available OpenAI models are the intersection of your account's model list
   and Pi's supported catalog. Vision still requires image input support.
4. **Manage usage** opens ChatGPT's usage settings. Displayed dollar values for
   subscription use are API-equivalent estimates, not subscription charges.

Saved model selections are never rewritten. Existing models from other providers
continue to use their own configured integrations. An OpenAI model unavailable
to the selected ChatGPT account must be changed explicitly in the model picker.

In provider settings, **OpenAI connection** explicitly selects ChatGPT subscription
or API key (separate billing). Logging out, failed refreshes, missing plan consent,
and exhausted usage never switch this choice to API billing. Selecting another
saved account keeps its registration and credentials separate. Reconnect with
Continue with ChatGPT; Add account creates a separate account/workspace registration.
Search and dictation retain their separate service keys and existing behavior.

## Credential boundary

Electron's main process owns OAuth, a loopback listener on 127.0.0.1, PKCE,
state/nonce verification, RS256 ID-token verification through OpenAI's JWKS,
account registrations, and serialized rotating-token refresh. A new registration's
issued client ID is persisted before its authorization-code exchange.

`chatgpt-credentials.enc` lives in Electron's userData directory beside, and
separate from, the existing `auth.json`. Electron safeStorage encrypts it;
updates use an atomic rename and mode 0600. An unreadable encrypted store fails
closed. Logout clears local tokens, attempts remote revocation, retains the
host/account registration, and reports when revocation was not confirmed.

The renderer can access only account operations and sanitized status. It has no
token method or OAuth URL. A private parent/child process IPC channel supplies
a current access token for each OpenAI request. Only nonsecret availability
flags are passed in the child's startup environment. Credentials never enter
HTTP responses, model settings, prompts, or learning records.

The shared model adapter applies the public Responses subscription contract
without changing prompt text or local tools: full transcript, developer
instructions, `additional_tools`, `store:false`, `stream:true`, unsupported
request fields removed, no API retries, and incomplete streams treated as errors.
The existing runtime continues to perform local tool execution and persistence.

## Local build

On an Apple Silicon Mac with Node, npm and Xcode 26 or newer:

```sh
npm ci
TZ=UTC npm test
npm run lint
npm run typecheck
npm run desktop:local
```

The local build has version `0.3.4-chatgpt.1`, retains the LearnHarness app name,
bundle identifier and profile location, and disables automatic updates and the
update menu. Updates require an intentional upstream merge and rebuild.

Local packaging uses an ad-hoc signature and is not notarized. Its separate
entitlements allow ad-hoc Electron frameworks/native libraries to load, while
retaining hardened runtime, JIT and microphone entitlements. The upstream
Developer ID signing configuration is unchanged. No release is published. Signing occurs in a temporary directory outside synced
folders; `dist/local-build.json` records that app path. The DMG/ZIP deliverables
are copied to `dist/`.

Test a packaged app with an isolated profile before installing it:

```sh
LH_PROFILE_DIR="$PWD/../test-profile" LH_IGNORE_ENV_KEYS=1 \
  "$(node -p 'require("./dist/local-build.json").app')/Contents/MacOS/LearnHarness"
```

The plain Next.js server and the unmanaged `desktop:dev` server keep their API-key
behavior. ChatGPT sign-in requires the Electron-managed production server.

Run the existing domain fixtures through synthetic subscription authentication:

```sh
LH_TEST_CHATGPT_BOUNDARY=1 NODE_ENV=test TZ=UTC node --import tsx --test \
  tests/chat-flow.test.ts tests/practice-flow.test.ts tests/extraction.test.ts \
  tests/jobs.test.ts tests/pdf-reader.test.ts
```

## Install and roll back

Quit LearnHarness completely before either operation. Back up the full original
`/Applications/LearnHarness.app` and `~/Library/Application Support/LearnHarness`
with a tool that preserves macOS metadata (for example `ditto`). Replace the app
only after isolated validation. Reuse the existing profile; no migration runs.
Do not copy test sessions or test model settings into the original profile.

For rollback, quit the fork, retain a copy of its current profile, restore the
original app, and restore the complete pre-install profile backup. Restoring the
profile discards changes made after that backup, so keep the newer copy if needed.
Signing out/revoking the fork's ChatGPT connection is separate from restoring files.

## Protocol references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Subscription request requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

The OAuth implementation is independent; no source from the separately licensed
Sign in with ChatGPT DevKit is included. The upstream AGPL-3.0-only license remains.
