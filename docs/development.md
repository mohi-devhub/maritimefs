# Development

Use Node.js 22.13+ or 24 LTS, npm, and desktop VS Code 1.105+. Run `npm ci` first.

## Development Host

Run `npm run build:dev`, then press F5 using the included launch configuration. The isolated Development Host uses deterministic simulated agents and an in-memory credential store. Reloading resets simulated files. To debug a real account deliberately, set `MARITIMEFS_DEV_REAL=1` in that launch environment. An installed production VSIX ignores this flag and contains no simulation backend.

`npm run build` uses the production entry point, `src/extension.ts`; `npm run build:dev` uses `src/dev/extension.ts` and writes to a separate location. The build and package checks reject development/test modules in the production bundle.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:integration
npm run package:prerelease
npm run verify:package -- --pre-release
npm run test:package
npm run scan:secrets
npm audit --omit=dev
```

Unit tests use Vitest. Extension Host tests run in an isolated VS Code profile with simulated responses. Package tests install the production VSIX into fresh profiles and test file editing plus SecretStorage persistence using local HTTP fixtures; they do not contact Maritime. Set `VSCODE_TEST_VERSION=stable` to test current stable VS Code, or `VSCODE_EXECUTABLE_PATH` to use another compatible executable. On Linux, run Extension Host tests under Xvfb.

`npm run test:live` is a separate opt-in test against one specified agent. It is excluded from CI and can wake the agent, write disposable files, execute one `pwd`, and return the agent to sleep. Review `scripts/live-integration.mjs` and `src/test/live/guard.ts` before using it. Do not use real credentials in fixtures or command arguments.

## Packaging

`npm run package:prerelease` builds a production VSIX with the Marketplace pre-release marker. `npm run verify:package -- --pre-release` checks the archive, bundle, and manifest. Packaging does not publish the extension.

Release notes for a new version belong in `docs/releases/<version>.md`. After reviewing and committing a clean tree, `npm run release:freeze:prerelease` creates an immutable, ignored VSIX and checksum under `release-artifacts/<version>/`; `npm run release:verify` installs and tests those exact bytes. Use a new version number for any changed archive.
