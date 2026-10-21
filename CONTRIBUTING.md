# Contributing

Start with the [development guide](docs/development.md) and [architecture](docs/architecture.md). Keep changes focused and add tests for behavior and failure modes. The default test suite uses simulated agents and does not contact Maritime.

Before opening a pull request, run:

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:integration
npm run package:prerelease
npm run verify:package -- --pre-release
npm run scan:secrets
```

Explain the problem, resulting behavior, tests, and remaining limitations. Never commit API keys, environment files, remote file contents, customer logs, or sensitive fixtures. Do not add telemetry or undocumented Maritime endpoints. Real-agent tests require control over the target agent and should not be part of CI.

For bugs and feature requests, use [GitHub Issues](https://github.com/mohi-devhub/maritimefs/issues). For security reports, follow [SUPPORT.md](SUPPORT.md) without posting credentials or sensitive details publicly.
