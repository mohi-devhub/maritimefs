import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { setTimeout, clearTimeout } from 'node:timers';

/** Test Hosts deliberately disable disk storage. Use normal isolated sessions. */
export async function verifyCredentialPersistence(executable) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'maritimefs-credentials-'));
  try {
    const extensions = path.join(fixture, 'extensions');
    const extension = path.join(extensions, 'maritimefs-tests.credential-persistence-0.0.0');
    await mkdir(extension, { recursive: true });
    await writeFile(
      path.join(extension, 'package.json'),
      JSON.stringify({
        name: 'credential-persistence',
        publisher: 'maritimefs-tests',
        version: '0.0.0',
        engines: { vscode: '^1.105.0' },
        activationEvents: ['*'],
        main: './extension.cjs',
      }),
    );
    await build({
      entryPoints: ['src/test/integration/credentialFixture.ts'],
      outfile: path.join(extension, 'extension.cjs'),
      platform: 'node',
      format: 'cjs',
      bundle: true,
      target: 'node22',
      external: ['vscode'],
    });
    for (const phase of ['store', 'restore']) {
      const report = path.join(fixture, `${phase}.json`);
      await new Promise((resolve, reject) => {
        const child = spawn(
          executable,
          [
            `--user-data-dir=${path.join(fixture, 'profile')}`,
            `--extensions-dir=${extensions}`,
            '--new-window',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-updates',
            '--disable-workspace-trust',
            '--no-sandbox',
            // Only a fake credential is used; Linux CI has no OS keyring.
            ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
          ],
          {
            env: {
              ...process.env,
              MARITIMEFS_CREDENTIAL_REPORT: report,
              MARITIMEFS_CREDENTIAL_PHASE: phase,
            },
            stdio: 'ignore',
          },
        );
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Credential persistence fixture timed out (${phase})`));
        }, 45_000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Credential persistence fixture exited with code ${code}`));
        });
      });
      const result = JSON.parse(await readFile(report, 'utf8'));
      if (result.phase !== phase || result.passed !== true)
        throw new Error(`Native credential persistence check failed (${phase})`);
      console.log(`PASS native SecretStorage ${phase} in an isolated normal VS Code process`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
