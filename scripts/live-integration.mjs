// Explicit operator command. Never imported by the extension or the default tests/CI.
import { loadEnvFile } from 'node:process';
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Maritime } from 'maritime-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
async function main() {
  const id = process.env.MARITIMEFS_LIVE_AGENT_ID;
  if (process.env.MARITIMEFS_ALLOW_LIVE !== '1' || !id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw new Error('Set MARITIMEFS_ALLOW_LIVE=1 and one approved MARITIMEFS_LIVE_AGENT_ID.');
  const before = new Set(Object.keys(process.env));
  try {
    loadEnvFile(path.join(projectRoot, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const keys = Object.entries(process.env).filter(
    ([name, value]) => !before.has(name) && value?.startsWith('mk_'),
  );
  const key =
    process.env.MARITIME_API_KEY ??
    process.env.MARITIME_TOKEN ??
    (keys.length === 1 ? keys[0][1] : undefined);
  if (!key) throw new Error('No unique Maritime API key available.');
  await build({
    entryPoints: ['src/test/live/index.ts'],
    outfile: 'dist-test/live.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  });
  const fixture = await mkdtemp(path.join(tmpdir(), 'maritimefs-live-'));
  const startedAt = Date.now();
  const reportPath = path.join(projectRoot, '.vscode-test/live-result.json');
  await mkdir(path.dirname(reportPath), { recursive: true });
  try {
    await mkdir(path.join(fixture, 'local'));
    const workspaceFile = path.join(fixture, 'live.code-workspace');
    await writeFile(
      workspaceFile,
      JSON.stringify({ folders: [{ path: path.join(fixture, 'local') }] }),
    );
    await runTests({
      version: '1.105.1',
      ...(process.env.VSCODE_EXECUTABLE_PATH
        ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH }
        : {}),
      extensionDevelopmentPath: path.join(projectRoot, '.vscode-test/development-extension'),
      extensionTestsPath: path.join(projectRoot, 'dist-test/live.cjs'),
      extensionTestsEnv: {
        MARITIMEFS_LIVE_TEST: '1',
        MARITIMEFS_LIVE_RESUME: process.env.MARITIMEFS_LIVE_RESUME ?? '0',
        MARITIMEFS_LIVE_API_KEY: key,
        MARITIMEFS_LIVE_AGENT_ID: id,
        MARITIMEFS_LIVE_REPORT: path.join(projectRoot, '.vscode-test/live-result.json'),
      },
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
  } finally {
    // If the Extension Host exits before its finally block, still leave the selected agent asleep.
    let completed = false;
    try {
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      completed =
        report.agentId === id &&
        Date.parse(report.at) >= startedAt &&
        report.cleanup?.agentStatus === 'sleeping';
    } catch {
      /* No completed report. */
    }
    if (!completed) {
      const sdk = new Maritime({
        apiKey: key,
        baseUrl: 'https://api.maritime.sh',
        maxRetries: 0,
        timeout: 20000,
      });
      try {
        const state = await sdk.agents.get(id);
        if (state.status !== 'sleeping') {
          const asleep = await sdk.agents.sleep(id);
          console.log(
            `Live fallback cleanup state: ${asleep.status === 'sleeping' ? 'sleeping' : 'transitioning'}`,
          );
        }
      } catch {
        console.error('Live fallback sleep could not be verified; inspect the selected agent.');
        process.exitCode = 1;
      }
    }
    await rm(fixture, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error && error.message.startsWith('Set ')
      ? error.message
      : 'Live acceptance failed; inspect the sanitized report. Never resubmit commands blindly.',
  );
  process.exitCode = 1;
});
