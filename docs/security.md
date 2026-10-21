# Security and threat model

## Assets and trust boundaries

Protect the API key, account resources, remote file bytes, and user intent. Network errors and server responses may contain sensitive or hostile text. Remote files, directory entries, logs, agent names and workspace settings are untrusted inputs. Other authorized remote writers may change files concurrently. Maritime's API/runtime is trusted to authenticate requests, authorize account access and enforce canonical persistent-volume confinement.

## Credentials and network

Production credentials use only `ExtensionContext.secrets`, entered with a password-masked input. They are never saved to workspace settings, URIs, source files, telemetry or extension logs. The extension does not read dotenv or CLI configuration. Development's user-supplied `.env` remains gitignored and explicitly excluded from the VSIX. Simulation exists only in a separately built Development/Test Host entry and uses an in-memory store. The production dependency graph excludes the mock backend and test modules, has no simulation setting, and ignores development/live-test environment flags. Pending command/lifecycle prompts are bound to their original account. Disconnect/disposal aborts pending validation clients as well as the active client.

Key validation lists agents before storage. Reconnect disposes the previous client and revokes access; invalid candidates leave the working connection alone. Storage operations are serialized. Old request generations cannot grant a new session. Revoked/expired keys and insufficient permissions produce safe actionable errors; Connection Status performs a fresh validation.

The SDK receives a fixed base URL, explicit key, zero automatic retries, and an injected transport. The transport accepts only `https://api.maritime.sh`, rejects redirects, applies a 75 second total request timer (including body download/backoff), and aborts on disposal. The SDK's own timeout is 80 seconds. Control-plane GETs get at most two retries with exponential backoff and bounded Retry-After handling; file reads, writes, lifecycle actions, deletes and commands are never retried. HTTP error bodies and arbitrary exception messages are discarded rather than reflected to the user. No proxy override or alternate API host is exposed via workspace settings.

## Filesystem

Validate the URI scheme, agent identifier, absence of query/fragment, absolute POSIX path, and whole-segment membership in the discovered root. Reject parent traversal, ambiguous percent encodings, controls and backslashes. The server root is discovered, never guessed; `/` cannot become an approved root. Directory responses must identify the same root/path and valid unique basenames. Native stat is derived from parent entries; downloading outside the persistent volume is prohibited even though the upstream download API allows it.

The current public schema has no lstat/realpath or reliable symlink identity. The client rejects explicit symlink fields if supplied but cannot identify every link or prevent a malicious server-side link swap. **Canonical symlink confinement depends on Maritime.** Do not use remote untrusted collaborators as a hostile isolation boundary. No shell-based stat/list/read/write workaround is used.

Byte-preserving uploads always set dest_dir and never notify the agent through chat. Root deletion and cross-agent moves are blocked. Destructive deletion requires confirmation at the provider boundary; nonrecursive nonempty directories are refused. Rename never replaces an existing destination. Trust is required for all mutations. Hash baselines and local serialization reduce inadvertent overwrite, but there is no atomic conditional write. Creation, preflight delete checks, and write check/upload sequences have races. The extension makes no atomic conflict-safety claim.

Files are bounded at 8 MiB and other HTTP responses at 4 MiB. File reads refuse a file above the metadata size limit before download; streamed response accumulation is also checked. Saves of previously read files compare a fresh bounded download directly with the read hash, omitting redundant metadata. Only 256 hashes are kept, with no file-content cache. Explorer metadata has a two-second, 32-directory cache with a 2 MiB estimated budget; mutations, file reads, and rename postchecks use fresh responses. Local mutations and refreshes invalidate metadata, including on failure. Active agent status is never cached after the request completes; concurrent checks may share an in-flight request. Very large unpaginated directories are refused rather than recursively loaded.

## Wake, execution and logs

No background polling, remote watchers, auto-wake commands, remote creation, plan upgrades or agent deletion. Restore never authorizes filesystem access. Explicit opening asks before touching a sleeping agent; each authorized filesystem operation checks status again and locks when sleep/unknown state is observed. The server provides no atomic no-wake precondition, so sleep between that check and a file call remains possible after approval. Use Lock Remote Workspaces when access should stop.

Execution requires a user command, explicit target, trusted workspace and validated JSON argv array. No implicit string concatenation or shell parsing. A user may deliberately request a shell executable. Execution is submitted once with a 30 second remote timeout; HTTP timeout/disconnect does not cancel remote work. There is no claimed interactive stdin/session or detached cancellation UI. Lifecycle operations always confirm interruption/resource implications.

Extension-generated errors contain no remote payloads. Requested remote command output and logs pass through known-token and common secret-assignment redaction; the extension never fetches environment-variable APIs. Redaction cannot identify every possible secret in user applications' logs/output. Treat those Output Channels as potentially sensitive and do not paste them publicly without review.

## Build and supply chain

The Maritime SDK is bundled into the production extension. Package verification checks the archived entry point and rejects development modules, dotenv files, and token patterns. CI runs tests and secret scans without Maritime credentials or live-agent requests. Live tests are separate and opt-in.

If a credential is accidentally committed, stop pushes, revoke it with Maritime and coordinate cleanup privately; do not paste the credential into an issue. Avoid history rewriting on shared branches without explicit coordination. See CONTRIBUTING.md for security reporting.
