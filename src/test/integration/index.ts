import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../activation';
import type { MockMaritimeClient } from '../../dev/mockClient';
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionTestApi>('mohi-devhub.maritimefs');
  assert.ok(extension, 'Extension is discoverable');
  const api = await extension.activate();
  assert.ok(api, 'Test-only API is available');
  let checks = 0;
  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (error) {
      console.error(`FAIL ${name}`, error);
      throw error;
    }
    checks++;
    console.log(`PASS ${name}`);
  }
  let confirmed = 0;
  api.ui.confirm = async () => {
    confirmed++;
    return true;
  };
  const id = 'mock-active';
  const uri = vscode.Uri.from({
    scheme: 'maritime',
    authority: id,
    path: '/data/workspace/hello.txt',
  });
  let client: MockMaritimeClient;
  await check('connect account and list simulated agents through palette commands', async () => {
    await vscode.commands.executeCommand('maritimefs.connect');
    assert.equal(api.auth.connected, true);
    client = api.auth.client as MockMaritimeClient;
    assert.equal(client.simulated, true);
    assert.equal(api.agents.agents.length, 3);
    assert.equal((await api.tree.getChildren()).length, 3);
  });
  await check('restored filesystem stays locked without file requests', async () => {
    client.calls.length = 0;
    await assert.rejects(
      Promise.resolve(vscode.workspace.fs.readFile(uri)),
      /account is connected/,
    );
    assert.equal(client.calls.includes('listFiles'), false);
    assert.equal(client.calls.includes('download'), false);
  });
  async function openFromTreeAndCheckExplorer(): Promise<void> {
    // copyFilePath uses the focused Explorer selection. This checks the real
    // workbench navigation, rather than only checking workspaceFolders metadata.
    const clipboard = await vscode.env.clipboard.readText();
    try {
      await vscode.commands.executeCommand('workbench.view.extension.maritimefs');
      const agent = (await api.tree.getChildren()).find(
        (node) => node.kind === 'agent' && node.agent.id === id,
      );
      assert.ok(agent);
      const filesNode = (await api.tree.getChildren(agent)).find((node) => node.kind === 'files');
      assert.ok(filesNode);
      const files = api.tree.getTreeItem(filesNode);
      assert.ok(files?.command);
      await vscode.env.clipboard.writeText('maritimefs-explorer-not-selected');
      const root = await vscode.commands.executeCommand<vscode.Uri>(
        files.command.command,
        ...(files.command.arguments ?? []),
      );
      assert.equal(root?.toString(), 'maritime://mock-active/data');
      await vscode.commands.executeCommand('copyFilePath');
      const selected = await vscode.env.clipboard.readText();
      assert.ok(selected.endsWith('/data'), `Explorer must select the remote root: ${selected}`);
    } finally {
      await vscode.env.clipboard.writeText(clipboard);
    }
  }
  await check('Files reveals and selects the agent workspace in native Explorer', async () => {
    await openFromTreeAndCheckExplorer();
    assert.equal(api.access.root(id), '/data');
    assert.ok(vscode.workspace.workspaceFolders?.some((f) => f.uri.authority === id));
  });
  await check('Files reopens a locked existing folder without adding a duplicate', async () => {
    await vscode.commands.executeCommand('maritimefs.lockWorkspaces');
    assert.equal(api.access.root(id), undefined);
    await openFromTreeAndCheckExplorer();
    assert.equal(api.access.root(id), '/data');
    assert.equal(
      vscode.workspace.workspaceFolders?.filter((f) => f.uri.authority === id).length,
      1,
    );
  });
  await check('browse and read remote text and binary files', async () => {
    const entries = await vscode.workspace.fs.readDirectory(uri.with({ path: '/data/workspace' }));
    assert.ok(entries.some(([name]) => name === 'hello.txt'));
    assert.deepEqual(
      [...(await vscode.workspace.fs.readFile(uri.with({ path: '/data/workspace/binary.bin' })))],
      [0, 255, 128, 1],
    );
    assert.equal((await vscode.workspace.fs.stat(uri)).type, vscode.FileType.File);
  });
  await check('edit a native TextDocument and save with persistence', async () => {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      'Edited and saved in VS Code\n',
    );
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await doc.save(), true);
    assert.equal(
      new TextDecoder().decode(await client.download(id, uri.path)),
      'Edited and saved in VS Code\n',
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.equal(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)),
      'Edited and saved in VS Code\n',
    );
  });
  const created = uri.with({ path: '/data/workspace/created.bin' });
  const renamed = created.with({ path: '/data/workspace/renamed.bin' });
  await check('create, rename and delete with provider confirmation', async () => {
    await vscode.workspace.fs.writeFile(created, new Uint8Array([255, 0, 127]));
    await assert.rejects(
      api.provider.rename(created, created.with({ authority: 'mock-sleeping' }), {
        overwrite: false,
      }),
    );
    await vscode.workspace.fs.rename(created, renamed);
    await assert.rejects(client.download(id, created.path));
    assert.deepEqual([...(await vscode.workspace.fs.readFile(renamed))], [255, 0, 127]);
    const before = confirmed;
    await vscode.workspace.fs.delete(renamed, { recursive: false, useTrash: false });
    assert.equal(confirmed, before + 1);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(renamed)));
  });
  await check(
    'rename an open dirty document, save at the new name, and keep the old name absent',
    async () => {
      const from = uri.with({ path: '/data/workspace/editor-rename.txt' });
      const to = from.with({ path: '/data/workspace/editor-renamed.txt' });
      await vscode.workspace.fs.writeFile(from, new TextEncoder().encode('before rename'));
      const document = await vscode.workspace.openTextDocument(from);
      await vscode.window.showTextDocument(document);
      const dirty = new vscode.WorkspaceEdit();
      dirty.insert(from, document.positionAt(document.getText().length), ' with unsaved edits');
      assert.equal(await vscode.workspace.applyEdit(dirty), true);
      assert.equal(document.isDirty, true);
      // WorkspaceEdit uses VS Code's editor-aware file operation, unlike the raw fs API.
      const rename = new vscode.WorkspaceEdit();
      rename.renameFile(from, to, { overwrite: false });
      assert.equal(await vscode.workspace.applyEdit(rename), true);
      const moved = await vscode.workspace.openTextDocument(to);
      await vscode.window.showTextDocument(moved);
      assert.equal(moved.getText(), 'before rename with unsaved edits');
      assert.equal(await moved.save(), true);
      assert.equal(
        new TextDecoder().decode(await client.download(id, to.path)),
        'before rename with unsaved edits',
      );
      await assert.rejects(client.download(id, from.path));
      const entries = await vscode.workspace.fs.readDirectory(
        from.with({ path: '/data/workspace' }),
      );
      assert.ok(entries.some(([name]) => name === 'editor-renamed.txt'));
      assert.equal(
        entries.some(([name]) => name === 'editor-rename.txt'),
        false,
      );
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.workspace.fs.delete(to, { useTrash: false });
    },
  );
  await check('detect a write conflict without overwriting external content', async () => {
    await api.provider.readFile(uri);
    await client.upload(id, uri.path, new TextEncoder().encode('external change'));
    await assert.rejects(
      api.provider.writeFile(uri, new TextEncoder().encode('my edits'), {
        create: true,
        overwrite: true,
      }),
    );
    assert.equal(new TextDecoder().decode(await client.download(id, uri.path)), 'external change');
  });
  await check('execute pwd once and show output in command runner', async () => {
    api.ui.input = async () => '["pwd"]';
    const before = client.calls.filter((c) => c === 'exec').length;
    await vscode.commands.executeCommand('maritimefs.openTerminal', id);
    await vscode.commands.executeCommand('maritimefs.execute', id);
    assert.equal(client.calls.filter((c) => c === 'exec').length, before + 1);
  });
  await check('fetch historical logs in a native output channel', async () => {
    await vscode.commands.executeCommand('maritimefs.viewLogs', id);
    assert.ok(client.calls.includes('logs'));
  });
  await check('confirm lifecycle operations and show actual states', async () => {
    await vscode.commands.executeCommand('maritimefs.sleep', id);
    assert.equal((await client.getAgent(id)).status, 'sleeping');
    assert.equal(api.access.root(id), undefined);
    await vscode.commands.executeCommand('maritimefs.wake', id);
    assert.equal((await client.getAgent(id)).status, 'active');
    await vscode.commands.executeCommand('maritimefs.restart', id);
    assert.equal(api.agents.agents.find((a) => a.id === id)?.status, 'active');
  });
  await check('sleeping agents stay asleep when wake consent is declined', async () => {
    api.ui.confirm = async () => false;
    await vscode.commands.executeCommand('maritimefs.openWorkspace', 'mock-sleeping');
    assert.equal((await client.getAgent('mock-sleeping')).status, 'sleeping');
    api.ui.confirm = async () => true;
  });
  await check('network errors surface as filesystem failures', async () => {
    await api.access.open(id, async () => true);
    client.failNext = 'network';
    await assert.rejects(api.provider.readFile(uri));
  });
  await check('watch and refresh are explicit and generate local events', async () => {
    let events = 0;
    const sub = api.provider.onDidChangeFile(() => events++);
    const watcher = api.provider.watch();
    api.volume.refresh(id);
    assert.ok(events > 0);
    sub.dispose();
    watcher.dispose();
  });
  await check('disconnect revokes credentials and file access', async () => {
    await vscode.commands.executeCommand('maritimefs.disconnect');
    assert.equal(api.auth.connected, false);
    assert.equal(api.access.root(id), undefined);
    await assert.rejects(api.provider.readFile(uri), /disconnected/);
  });
  await check('development simulation reconnects with a fresh ephemeral filesystem', async () => {
    const oldClient = client;
    await vscode.commands.executeCommand('maritimefs.connect');
    assert.equal(api.auth.connected, true);
    assert.notEqual(api.auth.client, oldClient);
    assert.equal(
      new TextDecoder().decode(await api.auth.client.download(id, uri.path)),
      'Hello from MaritimeFS\n',
    );
    await vscode.commands.executeCommand('maritimefs.disconnect');
  });
  console.log(`${checks} VS Code Extension Host integration scenarios passed.`);
}
