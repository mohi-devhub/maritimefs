import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCredentialPersistence } from './credential-integration.mjs';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
async function main() {
  await build({
    entryPoints: ['src/test/integration/index.ts'],
    outfile: 'dist-test/integration.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  });
  const fixture = await mkdtemp(path.join(tmpdir(), 'maritimefs-integration-'));
  try {
    await mkdir(path.join(fixture, 'local'));
    const workspaceFile = path.join(fixture, 'integration.code-workspace');
    await writeFile(
      workspaceFile,
      JSON.stringify({ folders: [{ path: path.join(fixture, 'local') }] }),
    );
    const executable =
      process.env.VSCODE_EXECUTABLE_PATH ||
      (await downloadAndUnzipVSCode({ version: process.env.VSCODE_TEST_VERSION || '1.105.1' }));
    await runTests({
      vscodeExecutablePath: executable,
      extensionTestsEnv: { MARITIMEFS_LIVE_TEST: '0' },
      extensionDevelopmentPath: path.join(projectRoot, '.vscode-test/development-extension'),
      extensionTestsPath: path.join(projectRoot, 'dist-test/integration.cjs'),
      launchArgs: [
        workspaceFile,
        '--user-data-dir',
        path.join(fixture, 'profile'),
        '--extensions-dir',
        path.join(fixture, 'extensions'),
        '--new-window',
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--no-sandbox',
      ],
    });
    await verifyCredentialPersistence(executable);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error('VS Code integration tests failed. See the runner output above.');
  process.exitCode = 1;
});
