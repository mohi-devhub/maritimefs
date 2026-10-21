// Installs an unchanged VSIX into a fresh normal VS Code profile; no Development/Test Host.
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';
import { build } from 'esbuild';
import vsce from '@vscode/vsce';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';

const run = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const { values } = parseArgs({
    options: { vsix: { type: 'string' }, report: { type: 'string' }, frozen: { type: 'boolean' } },
  });
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const releaseDirectory = path.resolve('release-artifacts', manifest.version);
  const filename = path.resolve(
    values.vsix ??
      path.join(
        values.frozen ? releaseDirectory : '.',
        `${manifest.name}-${manifest.version}.vsix`,
      ),
  );
  const archive = await readFile(filename);
  const archiveHash = digest(archive);
  if (values.frozen) {
    const frozen = JSON.parse(await readFile(path.join(releaseDirectory, 'manifest.json'), 'utf8'));
    if (frozen.sha256 !== archiveHash || frozen.version !== manifest.version)
      throw new Error('Frozen artifact differs from its release manifest.');
  }
  const packaged = JSON.parse(
    execFileSync('unzip', ['-p', filename, 'extension/package.json'], { encoding: 'utf8' }),
  );
  if (
    packaged.publisher !== 'mohi-devhub' ||
    packaged.name !== 'maritimefs' ||
    packaged.contributes?.configuration
  )
    throw new Error('Refusing a non-production MaritimeFS package.');
  const bundled = execFileSync('unzip', ['-p', filename, 'extension/dist/extension.cjs']);
  const reportPath = path.resolve(
    values.report ??
      (values.frozen
        ? path.join(releaseDirectory, 'verification.json')
        : '.vscode-test/package-result.json'),
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  // macOS Unix socket paths are limited to 103 bytes; its default temp path is long.
  const fixture = await mkdtemp(
    path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'mfs-pkg-'),
  );
  const results = [];
  try {
    const profile = path.join(fixture, 'profile');
    const extensions = path.join(fixture, 'extensions');
    const companion = path.join(fixture, 'controller-source');
    await mkdir(companion, { recursive: true });
    await mkdir(path.join(profile, 'User'), { recursive: true });
    // Legacy settings/host flags must have no power to switch the production backend.
    await writeFile(
      path.join(profile, 'User/settings.json'),
      JSON.stringify({
        'maritimefs.mode': 'mock',
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'extensions.ignoreRecommendations': true,
      }),
    );
    await writeFile(
      path.join(companion, 'package.json'),
      JSON.stringify({
        name: 'package-controller',
        publisher: 'maritimefs-tests',
        version: '0.0.0',
        engines: { vscode: '^1.105.0' },
        main: './controller.cjs',
        activationEvents: ['*'],
        files: ['controller.cjs', 'README.md', 'LICENSE'],
      }),
    );
    await writeFile(
      path.join(companion, 'README.md'),
      '# Installed-package verification controller\nTemporary local fixture only.',
    );
    await writeFile(path.join(companion, 'LICENSE'), await readFile('LICENSE'));
    await build({
      entryPoints: ['src/test/package/controller.ts'],
      outfile: path.join(companion, 'controller.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['vscode'],
    });
    const executable =
      process.env.VSCODE_EXECUTABLE_PATH ||
      (await downloadAndUnzipVSCode({
        version: process.env.VSCODE_TEST_VERSION || '1.105.1',
      }));
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
    const cliProfile = ['--user-data-dir', profile, '--extensions-dir', extensions, '--no-sandbox'];
    await run(cli, [...cliArgs, ...cliProfile, '--install-extension', filename, '--force']);
    const controllerVsix = path.join(fixture, 'controller.vsix');
    await vsce.createVSIX({
      cwd: companion,
      packagePath: controllerVsix,
      allowMissingRepository: true,
      dependencies: false,
      allowStarActivation: true,
    });
    await run(cli, [...cliArgs, ...cliProfile, '--install-extension', controllerVsix, '--force']);
    const installedName = (await readdir(extensions)).find(
      (name) => name === `mohi-devhub.maritimefs-${packaged.version}`,
    );
    if (!installedName) throw new Error('The exact packaged version was not installed.');
    const installed = path.join(extensions, installedName);
    if (!(await readFile(path.join(installed, 'dist/extension.cjs'))).equals(bundled))
      throw new Error('Installed bundle differs from the frozen VSIX.');
    const installedManifest = JSON.parse(
      await readFile(path.join(installed, 'package.json'), 'utf8'),
    );
    if (
      installedManifest.version !== packaged.version ||
      installedManifest.main !== './dist/extension.cjs'
    )
      throw new Error('Installed version or entry point differs from the VSIX.');
    console.log(
      `PASS exact VSIX ${packaged.version} installed in a fresh profile; bundle matches archived bytes.`,
    );
    await mkdir(path.join(fixture, 'local'));
    for (const phase of ['store', 'restore', 'logged-out']) {
      const workspaceFile = path.join(fixture, `${phase}.code-workspace`);
      await writeFile(
        workspaceFile,
        JSON.stringify({ folders: [{ path: path.join(fixture, 'local') }] }),
      );
      const phaseReport = path.join(fixture, `${phase}.json`);
      await new Promise((resolve, reject) => {
        const child = spawn(
          executable,
          [
            workspaceFile,
            ...cliProfile,
            '--new-window',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-updates',
            '--disable-workspace-trust',
            ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
          ],
          {
            env: {
              ...process.env,
              MARITIMEFS_PACKAGE_REPORT: phaseReport,
              MARITIMEFS_PACKAGE_STATE: path.join(fixture, 'http-fixture.json'),
              MARITIMEFS_PACKAGE_PHASE: phase,
              MARITIMEFS_LIVE_TEST: '0',
              MARITIMEFS_DEV_REAL: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let diagnostic = '';
        child.stdout.on('data', (chunk) => {
          if (diagnostic.length < 16_384) diagnostic += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          if (diagnostic.length < 16_384) diagnostic += chunk.toString();
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Installed package phase timed out: ${phase}`));
        }, 60_000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else {
            void writeFile('.vscode-test/package-session-failure.log', diagnostic).catch(() => {});
            reject(new Error(`Installed package session failed: ${phase} (${code})`));
          }
        });
      });
      const result = JSON.parse(await readFile(phaseReport, 'utf8'));
      results.push(result);
      for (const name of result.checks) console.log(`PASS installed VSIX: ${name}`);
      if (!result.passed || result.liveMaritimeRequests !== 0)
        throw new Error(`Installed package check failed: ${result.failure ?? phase}`);
    }
    if (digest(await readFile(filename)) !== archiveHash)
      throw new Error('VSIX changed during verification.');
    if (!(await readFile(path.join(installed, 'dist/extension.cjs'))).equals(bundled))
      throw new Error('Installed production bytes changed during verification.');
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          version: packaged.version,
          vsixSha256: archiveHash,
          installedBundleSha256: digest(bundled),
          platform: process.platform,
          arch: process.arch,
          at: new Date().toISOString(),
          scope:
            'Installed production VSIX; normal fresh profile; isolated HTTP fixture, not live Maritime.',
          passed: true,
          sessions: results,
          liveMaritimeRequests: 0,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Installed-package verification passed. Report: ${reportPath}`);
  } catch (error) {
    let checkpoint;
    let hooks;
    try {
      checkpoint = JSON.parse(await readFile(path.join(fixture, 'store.json'), 'utf8'));
    } catch {
      /* No checkpoint. */
    }
    try {
      hooks = JSON.parse(await readFile(path.join(fixture, 'store.json.hooks'), 'utf8'));
    } catch {
      /* No loader trace. */
    }
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          version: packaged.version,
          vsixSha256: archiveHash,
          passed: false,
          sessions: results,
          checkpoint,
          hooks,
          failure: error instanceof Error ? error.message : 'Package verification failed',
        },
        null,
        2,
      ) + '\n',
    );
    throw error;
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Installed package verification failed.');
  process.exitCode = 1;
});
