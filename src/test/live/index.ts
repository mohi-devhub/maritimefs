import * as assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Maritime } from 'maritime-sdk';
import type { ExtensionTestApi } from '../../activation';
import { LiveGuard } from './guard';
export async function run(): Promise<void> {
  const id = process.env.MARITIMEFS_LIVE_AGENT_ID;
  const key = process.env.MARITIMEFS_LIVE_API_KEY;
  const reportPath = process.env.MARITIMEFS_LIVE_REPORT;
  assert.ok(id && key && reportPath, 'Explicit live-test configuration required');
  delete process.env.MARITIMEFS_LIVE_API_KEY;
  const nativeFetch = globalThis.fetch;
  const guard = new LiveGuard(id, nativeFetch);
  globalThis.fetch = guard.fetch;
  const observer = new Maritime({
    apiKey: key,
    baseUrl: 'https://api.maritime.sh',
    maxRetries: 0,
    timeout: 20000,
    fetch: guard.fetch,
  });
  const previous =
    process.env.MARITIMEFS_LIVE_RESUME === '1'
      ? (JSON.parse(await readFile(reportPath, 'utf8')) as {
          agentId: string;
          checks: string[];
          execution?: typeof guard.execution;
        })
      : undefined;
  if (previous) assert.equal(previous.agentId, id, 'Cannot resume acceptance on a different agent');
  const checks: string[] = previous?.checks.slice() ?? [];
  if (previous?.execution) guard.execution = previous.execution;
  const cleanup: { files?: string; agentStatus?: string; credential?: string } = {};
  let api: ExtensionTestApi | undefined;
  let directory: string | undefined;
  let failure: string | undefined;
  async function check(name: string, fn: () => Promise<void>) {
    if (
      previous?.checks.includes(name) &&
      ![
        'real SecretStorage authentication and agent discovery',
        'native remote workspace and discovered volume',
        'disposable directory and text file creation',
      ].includes(name)
    ) {
      console.log(`SKIP LIVE already verified: ${name}`);
      return;
    }
    try {
      await fn();
      if (!checks.includes(name)) checks.push(name);
      console.log(`PASS LIVE ${name}`);
    } catch {
      failure = name;
      console.error(`FAIL LIVE ${name}`);
      throw new Error(`Live check failed: ${name}`);
    }
  }
  const encoded = (text: string) => new TextEncoder().encode(text);
  try {
    const extension = vscode.extensions.getExtension<ExtensionTestApi>('mohi-devhub.maritimefs');
    assert.ok(extension);
    api = await extension.activate();
    assert.ok(api);
    api.ui.input = async () => key;
    api.ui.confirm = async (message, action) => {
      if (!message.includes(id)) return false;
      if (action === 'Allow Wake' || action === 'Sleep') return true;
      return action === 'Delete' && !!directory && message.includes(directory);
    };
    await check('real SecretStorage authentication and agent discovery', async () => {
      await vscode.commands.executeCommand('maritimefs.connect');
      assert.equal(api!.auth.connected, true);
      assert.equal(api!.auth.client.simulated, false);
      assert.ok(api!.agents.agents.some((a) => a.id === id));
    });
    await check('native remote workspace and discovered volume', async () => {
      await vscode.commands.executeCommand('maritimefs.openWorkspace', id);
      assert.ok(api!.access.root(id));
      assert.equal(api!.access.root(id), guard.root);
    });
    const root = api.access.root(id)!;
    directory = `${root}/.maritimefs-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
    guard.directory = directory;
    const uri = (name = '') =>
      vscode.Uri.from({
        scheme: 'maritime',
        authority: id,
        path: directory + (name ? '/' + name : ''),
      });
    await check('disposable directory and text file creation', async () => {
      await vscode.workspace.fs.createDirectory(uri());
      await vscode.workspace.fs.writeFile(uri('hello.txt'), encoded('MaritimeFS live seed\n'));
    });
    await check('native TextDocument editing, save, and independent byte readback', async () => {
      const file = uri('hello.txt');
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        file,
        new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
        'MaritimeFS live edited and saved\n',
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(await doc.save(), true);
      assert.deepEqual(
        await observer.agents.files.download(id, file.path),
        encoded('MaritimeFS live edited and saved\n'),
      );
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      assert.deepEqual(
        new Uint8Array(await vscode.workspace.fs.readFile(file)),
        encoded('MaritimeFS live edited and saved\n'),
      );
    });
    await check('binary bytes, empty files, and case-sensitive names', async () => {
      const binary = new Uint8Array([0, 255, 128, 10, 13]);
      await vscode.workspace.fs.writeFile(uri('Bytes.bin'), binary);
      await vscode.workspace.fs.writeFile(uri('bytes.bin'), new Uint8Array());
      assert.deepEqual(
        new Uint8Array(await vscode.workspace.fs.readFile(uri('Bytes.bin'))),
        binary,
      );
      assert.equal((await vscode.workspace.fs.readFile(uri('bytes.bin'))).byteLength, 0);
      await api!.provider.writeFile(uri('bytes.bin'), encoded('previously empty'), {
        create: false,
        overwrite: true,
      });
      assert.deepEqual(
        await observer.agents.files.download(id, uri('bytes.bin').path),
        encoded('previously empty'),
      );
      const entries = await vscode.workspace.fs.readDirectory(uri());
      assert.ok(
        entries.some(([name]) => name === 'Bytes.bin') &&
          entries.some(([name]) => name === 'bytes.bin'),
      );
    });
    await check('external modification is refused without overwriting', async () => {
      const file = uri('hello.txt');
      await api!.provider.readFile(file);
      await observer.agents.files.upload(id, {
        filename: 'hello.txt',
        destDir: directory,
        content: encoded('External live change\n'),
      });
      await assert.rejects(
        api!.provider.writeFile(file, encoded('Must not overwrite\n'), {
          create: true,
          overwrite: true,
        }),
      );
      assert.deepEqual(
        await observer.agents.files.download(id, file.path),
        encoded('External live change\n'),
      );
    });
    await check('rename and confirmed file deletion', async () => {
      await vscode.workspace.fs.rename(uri('hello.txt'), uri('renamed.txt'));
      await vscode.workspace.fs.delete(uri('renamed.txt'), { recursive: false, useTrash: false });
    });
    await check('one pwd command with real output and exit code', async () => {
      api!.ui.input = async () => '["pwd"]';
      await vscode.commands.executeCommand('maritimefs.execute', id);
      assert.equal(guard.execution?.exitCode, 0);
      assert.ok(guard.execution?.stdout.trim().startsWith('/'));
    });
    await check('historical logs displayed through the command', async () => {
      await vscode.commands.executeCommand('maritimefs.viewLogs', id);
      assert.equal(typeof guard.logCount, 'number');
    });
  } finally {
    guard.cleanup = true;
    if (directory) {
      try {
        await observer.agents.files.delete(id, directory);
        cleanup.files = 'deleted';
        console.log('LIVE CLEANUP test directory deleted');
      } catch (error) {
        cleanup.files =
          typeof error === 'object' && error !== null && 'status' in error && error.status === 404
            ? 'absent'
            : 'failed';
      }
    }
    try {
      if (api?.auth.connected) {
        await vscode.commands.executeCommand('maritimefs.sleep', id);
      } else {
        await observer.agents.sleep(id);
      }
      const state = await observer.agents.get(id);
      cleanup.agentStatus = state.status;
      if (api && state.status === 'sleeping') {
        const before = guard.calls.filter((c) => c.route.includes('/files/')).length;
        await assert.rejects(
          api.provider.readDirectory(
            vscode.Uri.from({ scheme: 'maritime', authority: id, path: guard.root! }),
          ),
        );
        await assert.rejects(api.access.open(id, async () => false));
        assert.equal(guard.calls.filter((c) => c.route.includes('/files/')).length, before);
        if (!checks.includes('sleep, locked access and declined wake without file requests'))
          checks.push('sleep, locked access and declined wake without file requests');
      }
    } catch {
      cleanup.agentStatus ??= 'failed';
    }
    if (api) {
      await api.auth.disconnect();
      cleanup.credential = 'removed from isolated SecretStorage';
    }
    globalThis.fetch = nativeFetch;
    const report = {
      at: new Date().toISOString(),
      agentId: id,
      root: guard.root,
      checks,
      failure,
      cleanup,
      execution: guard.execution
        ? {
            exitCode: guard.execution.exitCode,
            stdout: guard.execution.stdout,
            stderr: guard.execution.stderr,
          }
        : undefined,
      logCount: guard.logCount,
      requests: guard.calls.length,
      calls: guard.calls,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      `LIVE RESULT ${checks.length} checks; ${guard.calls.length} HTTP requests; final agent state: ${cleanup.agentStatus}`,
    );
  }
  assert.equal(cleanup.files, 'deleted', 'Disposable file cleanup must succeed');
  assert.equal(cleanup.agentStatus, 'sleeping', 'Agent must finish asleep');
}
