# Architecture

MaritimeFS runs entirely inside the desktop VS Code UI extension host. It has no service, database, webview, analytics, or inbound webhook server.

```text
SecretStorage → CredentialManager → MaritimeClient interface → official Maritime SDK
                                         ↑                       ↓
Tree/Commands → AgentService        AccessSession            bounded HTTPS fetch
                      Native FileSystemProvider → RemoteVolume
                      Command Runner / Logs → Output Channels
```

## Responsibilities

- `extension.ts` is the production-only entry point: real SDK, SecretStorage, no runtime simulation selection or test exports. `activation.ts` owns shared native wiring. `dev/extension.ts` is a separately bundled Development/Test Host entry, with deterministic mocks and explicitly opt-in live testing; it is excluded from the production dependency graph and VSIX.

- `api/types.ts` defines the narrow application contract shared by real and simulated clients. It keeps Agents separate from Computers.
- `api/maritimeClient.ts` delegates documented methods to the SDK and validates responses. Binary uploads always include an explicit destination directory, avoiding chat notifications.
- `api/transport.ts` pins the HTTPS origin, refuses redirects, bounds response allocation and elapsed time, tracks abort controllers, and retries only metadata/log GETs. SDK retrying is disabled, including for commands and destructive calls.
- `auth/credentialManager.ts` validates a candidate key before changing SecretStorage or disposing the old connection. Storage mutations are serialized so disconnect cannot race a pending store. Restore reads storage without issuing a network request.
- `services/accessSession.ts` discovers actual volume roots only after explicit opening, stores approvals only in memory, and checks agent status before each filesystem operation. Reconnect, disconnect, lifecycle actions, locking, workspace removal, or host restart revoke access. Generations prevent stale asynchronous requests from regranting it.
- `filesystem/remoteVolume.ts` provides the testable filesystem domain. It validates response names/root/path, derives stat from a parent listing, keeps bounded read hashes, serializes local mutations per agent, and binds each sequence to its originating account/session. It neither recurses through a workspace nor caches file contents.
- `filesystem/maritimeFileSystemProvider.ts` translates URIs, file types, timestamps, events and safe errors to native VS Code APIs. The POSIX filesystem is registered case-sensitive. Unknown ctime and root mtime are zero.
- `agents/agentTreeProvider.ts` renders agent status and native actions. `AgentService` holds list results and explicit updates; there is no timer.
- `commands/registerCommands.ts` handles target selection, consent, trust, native progress and errors. `Interaction` wraps prompts so tests can answer them without UI automation or production command shortcuts.
- `terminal/remoteTerminal.ts` is an Output Channel command runner; `logs/logManager.ts` fetches historical logs. Neither claims streaming or an interactive PTY.

## Read and save

A URI identifies the agent and its real absolute volume path. No credentials appear in URIs. On read, require an approved session and active status, inspect the parent listing for size/type, download bytes and remember their SHA-256 hash. On save, require trust and session access, honor create/overwrite flags, inspect existing content and compare its fresh hash with the baseline, then upload original bytes. Update the baseline and emit local events only after successful completion.

For a previously read file, saving uses the fresh download itself to prove existence and check the hash, avoiding a redundant parent listing. A download 404 still requires fresh metadata for the observed upstream empty-file exception; missing files are never recreated by this path. New/unread destinations use fresh listings. Rename relies on the SDK's documented missing-source/collision errors instead of preflight listings, then verifies source absence and destination presence; different parent listings can run concurrently after the move.

Explorer `stat` and `readDirectory` share a two-second cache of validated directory metadata and in-flight listings. It holds at most 32 directories within a 2 MiB estimated metadata budget, uses no timers, and is invalidated on refresh, connection/access-generation changes, and before/after every local mutation, including failures. Reads of file contents and all mutations bypass this metadata cache. Concurrent operations share only an in-flight agent status request; completed active statuses are never retained. Cached metadata still passes account/session guards and a current status check before use. No file bytes are cached. This reduces round trips without weakening byte conflict checks; external Explorer metadata may lag by up to two seconds unless explicitly refreshed.

There is an unavoidable check/upload race without conditional writes. Rereading a file creates a fresh baseline; eviction or reconnect requires a new read. Rename transfers known read hashes to the new URI so dirty native documents can save there. Bounded removed-path markers (256, including directory prefixes) reject delayed overwrite saves that would recreate renamed/deleted files; explicit creation with overwrite disabled may reuse a name. Markers expire on eviction or connection reset, so this is best-effort protection, not a server-side guarantee. Rename uses the upstream collision check, verifies source absence and destination presence through parent listings, and does not synthesize replacement with delete. Delete honors nonrecursive prechecks and always confirms, though upstream deletion is recursive and concurrent directory changes are not conditionally protected.

## Workspace lifecycle

Opening adds a virtual folder to the ordinary Explorer. VS Code may restart the extension host when the first folder/workspace identity changes. A fresh host intentionally starts locked. The user must explicitly open/unlock again; approvals are not persisted as settings, workspace files, or hidden handoff tokens. Saved multi-folder workspaces avoid the initial identity conversion.

The status lookup/file call sequence cannot be atomic. An agent sleeping between them may wake on the subsequent file call. No no-wake request parameter is documented. Metadata and logs are control-plane operations; no filesystem operation is ever triggered by tree rendering or credential restoration alone.

## Resource lifetime and tests

ExtensionContext subscriptions own channels, tree/status UI, listeners, provider registration and the credential/client manager. Client disposal aborts pending requests and clears timeout controllers. Watch returns a disposable and has no network work. Test-only exports are available only from the separate development entry in `ExtensionMode.Test`; the production entry never exposes them, even in a Test Host. Default tests force simulation independently of local settings. The separate opt-in live launcher may select a real client only in an isolated Test Host, with a test-side fetch guard restricting the target, mutations, execution and request budget. Unit tests cover domain behavior, official SDK request contracts, and build boundaries. Extension Host scenarios cover commands, Explorer APIs and native document saving.
