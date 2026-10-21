import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import * as vscode from 'vscode';
import { PackageHttpFixture, FIXTURE_AGENT, FIXTURE_KEY } from './httpFixture';

/** Installed separately in a temporary profile; never changes the production VSIX. */
export async function activate(): Promise<void> {
  const reportFile = process.env.MARITIMEFS_PACKAGE_REPORT;
  const stateFile = process.env.MARITIMEFS_PACKAGE_STATE;
  const phase = process.env.MARITIMEFS_PACKAGE_PHASE;
  if (!reportFile || !stateFile || !phase) return;
  await writeFile(
    reportFile,
    JSON.stringify({ phase, pending: 'controller bootstrap', passed: false }),
  );
  const checks: string[] = [];
  const fixture = new PackageHttpFixture();
  const originalFetch = globalThis.fetch;
  type Loader = (
    request: string,
    parent: { filename?: string } | null,
    isMain?: boolean,
  ) => unknown;
  const modules = Module as unknown as { _load: Loader };
  const originalLoad = modules._load;
  const information: string[] = [];
  const errors: string[] = [];
  let credential = FIXTURE_KEY;
  let allowConfirmation = true;
  let failure: string | undefined;
  let diagnostic: string | undefined;
  let activeCheck = 'initialization';
  const uri = (name = 'hello.txt') =>
    vscode.Uri.from({
      scheme: 'maritime',
      authority: FIXTURE_AGENT,
      path: '/data/workspace/' + name,
    });
  const bytes = (value: string) => new TextEncoder().encode(value);
  const text = (value: Uint8Array) => new TextDecoder().decode(value);
  async function check(name: string, action: () => Promise<void>) {
    activeCheck = name;
    await writeFile(reportFile!, JSON.stringify({ phase, pending: name, checks, passed: false }));
    await action();
    checks.push(name);
  }
  try {
    if (phase !== 'store') await fixture.restore(stateFile);
    globalThis.fetch = fixture.fetch;
    const prompts: Partial<typeof vscode.window> = {};
    prompts.showInputBox = (async (options) => {
      if (options?.password) {
        assert.equal(phase, 'store', 'A stored connection must not ask for a key again.');
        return credential;
      }
      return '["pwd"]';
    }) as typeof vscode.window.showInputBox;
    prompts.showQuickPick = (async (items: unknown) => {
      const choices: unknown = await items;
      return Array.isArray(choices) ? choices[0] : undefined;
    }) as typeof vscode.window.showQuickPick;
    prompts.showWarningMessage = (async (
      _message: string,
      _options: unknown,
      ...items: unknown[]
    ) => (allowConfirmation ? items[0] : undefined)) as typeof vscode.window.showWarningMessage;
    prompts.showInformationMessage = (async (message: string) => {
      information.push(message);
    }) as typeof vscode.window.showInformationMessage;
    prompts.showErrorMessage = (async (message: string) => {
      errors.push(message);
    }) as typeof vscode.window.showErrorMessage;
    const extension = vscode.extensions.getExtension('mohi-devhub.maritimefs');
    assert.ok(extension);
    assert.equal(
      extension.isActive,
      false,
      'The companion must establish isolation before activation.',
    );
    // VS Code creates an API object per extension. Wrap only this installed module's
    // native prompt methods at require-time; the archived JS bytes stay unchanged.
    const target = realpathSync(path.join(extension.extensionPath, 'dist/extension.cjs'));
    modules._load = (request, parent, isMain) => {
      const exported = originalLoad.call(modules, request, parent, isMain);
      if (request !== 'vscode') return exported;
      if (!parent?.filename || realpathSync(parent.filename) !== target) return exported;
      const native = exported as typeof vscode;
      const window = Object.create(Object.getPrototypeOf(native.window), {
        ...Object.getOwnPropertyDescriptors(native.window),
        ...Object.fromEntries(
          Object.entries(prompts).map(([name, value]) => [
            name,
            { value, enumerable: true, configurable: true },
          ]),
        ),
      }) as typeof vscode.window;
      return Object.create(Object.getPrototypeOf(native), {
        ...Object.getOwnPropertyDescriptors(native),
        window: { value: window, enumerable: true, configurable: true },
      }) as typeof vscode;
    };
    await check(
      'installed production activation exposes no test API or simulation setting',
      async () => {
        assert.equal(await extension.activate(), undefined);
        const contributes = extension.packageJSON.contributes as { configuration?: unknown };
        assert.equal(contributes.configuration, undefined);
        assert.equal(fixture.requests.length, 0, 'Activation must not issue remote requests.');
      },
    );
    if (phase === 'logged-out') {
      await check('disconnect persists after another normal VS Code restart', async () => {
        await vscode.commands.executeCommand('maritimefs.connectionStatus');
        assert.ok(information.at(-1)?.includes('disconnected'));
        assert.equal(fixture.requests.length, 0);
      });
    } else {
      if (phase === 'store') {
        await check(
          'invalid credentials use real SDK HTTP validation and remain disconnected',
          async () => {
            credential = 'deliberately-invalid-package-fixture';
            await vscode.commands.executeCommand('maritimefs.connect');
            assert.ok(errors.at(-1)?.includes('credentials were rejected'));
            await vscode.commands.executeCommand('maritimefs.connectionStatus');
            assert.ok(information.at(-1)?.includes('disconnected'));
            credential = FIXTURE_KEY;
          },
        );
        await check('connect through the packaged UI and SDK', async () => {
          await vscode.commands.executeCommand('maritimefs.connect');
          await vscode.commands.executeCommand('maritimefs.connectionStatus');
          assert.ok(information.at(-1)?.includes('Maritime authenticated'));
        });
      } else {
        await check(
          'SecretStorage restores the packaged connection without entering a key',
          async () => {
            await vscode.commands.executeCommand('maritimefs.connectionStatus');
            assert.ok(information.at(-1)?.includes('Maritime authenticated'));
          },
        );
      }
      await check('file access starts locked without any file request', async () => {
        const before = fixture.requests.filter((route) => route.includes('/files/')).length;
        await assert.rejects(Promise.resolve(vscode.workspace.fs.readFile(uri())), /locked/);
        assert.equal(fixture.requests.filter((route) => route.includes('/files/')).length, before);
      });
      await check('open an agent workspace with the packaged native filesystem', async () => {
        const root = await vscode.commands.executeCommand<vscode.Uri>(
          'maritimefs.openWorkspace',
          FIXTURE_AGENT,
        );
        assert.equal(root?.toString(), 'maritime://mock-active/data');
        assert.ok(
          (await vscode.workspace.fs.readDirectory(uri().with({ path: '/data/workspace' }))).some(
            ([name]) => name === 'hello.txt',
          ),
        );
      });
      if (phase === 'store') {
        await check(
          'native editor save persists through the official SDK upload path',
          async () => {
            const document = await vscode.workspace.openTextDocument(uri());
            await vscode.window.showTextDocument(document);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              uri(),
              new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length),
              ),
              'Saved by the frozen production VSIX\n',
            );
            assert.equal(await vscode.workspace.applyEdit(edit), true);
            assert.equal(await document.save(), true);
            assert.equal(
              text(await fixture.client.download(FIXTURE_AGENT, uri().path)),
              'Saved by the frozen production VSIX\n',
            );
            assert.ok(fixture.requests.some((route) => route.endsWith('/files/upload')));
          },
        );
        await check('binary and empty files, rename, confirmed deletion, and mkdir', async () => {
          await vscode.workspace.fs.createDirectory(uri('directory'));
          await vscode.workspace.fs.writeFile(
            uri('package-created.bin'),
            new Uint8Array([0, 255, 128]),
          );
          assert.deepEqual(
            [...(await vscode.workspace.fs.readFile(uri('package-created.bin')))],
            [0, 255, 128],
          );
          await vscode.workspace.fs.writeFile(uri('empty.txt'), new Uint8Array());
          assert.equal((await vscode.workspace.fs.readFile(uri('empty.txt'))).length, 0);
          await vscode.workspace.fs.rename(uri('package-created.bin'), uri('package-renamed.bin'));
          await assert.rejects(
            fixture.client.download(FIXTURE_AGENT, uri('package-created.bin').path),
          );
          await vscode.workspace.fs.delete(uri('package-renamed.bin'), { useTrash: false });
          await assert.rejects(
            fixture.client.download(FIXTURE_AGENT, uri('package-renamed.bin').path),
          );
        });
        await check('conflicting and failed writes preserve remote content', async () => {
          const file = uri('conflict.txt');
          await vscode.workspace.fs.writeFile(file, bytes('first'));
          await vscode.workspace.fs.readFile(file);
          await fixture.client.upload(FIXTURE_AGENT, file.path, bytes('external'));
          await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(file, bytes('mine'))));
          assert.equal(text(await fixture.client.download(FIXTURE_AGENT, file.path)), 'external');
          await vscode.workspace.fs.readFile(file);
          fixture.failure = 'upload';
          await assert.rejects(
            Promise.resolve(vscode.workspace.fs.writeFile(file, bytes('denied'))),
          );
          fixture.failure = undefined;
          assert.equal(text(await fixture.client.download(FIXTURE_AGENT, file.path)), 'external');
        });
        await check(
          'one explicit command and historical logs traverse the packaged SDK',
          async () => {
            await vscode.commands.executeCommand('maritimefs.execute', FIXTURE_AGENT);
            await vscode.commands.executeCommand('maritimefs.viewLogs', FIXTURE_AGENT);
            assert.equal(fixture.requests.filter((route) => route.endsWith('/exec')).length, 1);
            assert.ok(fixture.requests.some((route) => route.endsWith('/logs')));
          },
        );
        await check(
          'sleep and declined access do not issue a wake-inducing file request',
          async () => {
            await fixture.client.lifecycle(FIXTURE_AGENT, 'sleep');
            const before = fixture.requests.filter((route) => route.includes('/files/')).length;
            await assert.rejects(Promise.resolve(vscode.workspace.fs.readFile(uri())));
            allowConfirmation = false;
            await vscode.commands.executeCommand('maritimefs.openWorkspace', FIXTURE_AGENT);
            assert.equal((await fixture.client.getAgent(FIXTURE_AGENT)).status, 'sleeping');
            assert.equal(
              fixture.requests.filter((route) => route.includes('/files/')).length,
              before,
            );
            await fixture.client.lifecycle(FIXTURE_AGENT, 'start');
          },
        );
      } else {
        await check('saved bytes survive a normal VS Code restart', async () => {
          assert.equal(
            text(await vscode.workspace.fs.readFile(uri())),
            'Saved by the frozen production VSIX\n',
          );
        });
        await check(
          'disconnect revokes the packaged credential and filesystem access',
          async () => {
            await vscode.commands.executeCommand('maritimefs.disconnect');
            await vscode.commands.executeCommand('maritimefs.connectionStatus');
            assert.ok(information.at(-1)?.includes('disconnected'));
            await assert.rejects(
              Promise.resolve(vscode.workspace.fs.readFile(uri())),
              /disconnected/,
            );
          },
        );
      }
    }
    assert.deepEqual(
      fixture.unexpected,
      [],
      'No unexpected or external requests may escape the fixture.',
    );
    await fixture.save(stateFile);
  } catch (error) {
    // Never write arbitrary exceptions or input values into the report.
    failure = activeCheck;
    diagnostic =
      error instanceof Error
        ? error.message.replaceAll(FIXTURE_KEY, '[fixture credential]')
        : 'Controller failure';
  } finally {
    globalThis.fetch = originalFetch;
    modules._load = originalLoad;
    await writeFile(
      reportFile,
      JSON.stringify({
        phase,
        vscode: vscode.version,
        checks,
        passed: !failure,
        ...(failure ? { failure, diagnostic } : {}),
        fixtureRequests: fixture.requests.length,
        liveMaritimeRequests: 0,
      }),
    );
    void vscode.commands.executeCommand('workbench.action.quit');
  }
}
