# Changelog

## 0.1.4

- Shortened the README and added an inline demo player.
- Removed internal launch material and media binaries from the source tree. Runtime behavior is unchanged from 0.1.2.

## 0.1.2

- Published the first Visual Studio Marketplace pre-release.
- Added pre-release packaging and channel checks. Runtime behavior is unchanged from 0.1.1.

## 0.1.1

- Isolated the production SDK build from the Development Host simulation.
- Added installed-package checks across fresh VS Code profiles and versioned VSIX freezing.

## 0.1.0

- Added the agent explorer, SecretStorage authentication, persistent-volume filesystem, native editor saving, one-shot commands, historical logs, and lifecycle actions.
- Reduced filesystem round trips with bounded Explorer metadata caching and shared in-flight requests.
- Added best-effort save conflict checks, safer rename behavior, and credential restoration across restarts.
- Fixed empty-file downloads for the observed upstream response behavior.
