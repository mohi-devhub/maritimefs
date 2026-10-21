import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { CredentialManager, SECRET_KEY } from '../../auth/credentialManager';
import { MockMaritimeClient } from '../../dev/mockClient';

/** Bundled into a separate fixture extension, never shipped in MaritimeFS. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const report = process.env.MARITIMEFS_CREDENTIAL_REPORT;
  const phase = process.env.MARITIMEFS_CREDENTIAL_PHASE;
  if (!report || (phase !== 'store' && phase !== 'restore')) return;
  const clients: MockMaritimeClient[] = [];
  const manager = new CredentialManager(context.secrets, () => {
    const client = new MockMaritimeClient();
    clients.push(client);
    return client;
  });
  context.subscriptions.push(manager);
  let passed = false;
  try {
    await manager.restore();
    if (phase === 'store') {
      assert.equal(manager.connected, false);
      await manager.connect('simulated-persistence-fixture');
      manager.dispose();
      assert.equal(await context.secrets.get(SECRET_KEY), 'simulated-persistence-fixture');
    } else {
      assert.equal(manager.connected, true);
      assert.deepEqual(clients[0]?.calls, []);
      assert.equal((await manager.client.listAgents()).length, 3);
      await manager.disconnect();
      await manager.restore();
      assert.equal(manager.connected, false);
      assert.equal(await context.secrets.get(SECRET_KEY), undefined);
    }
    passed = true;
  } finally {
    // Reports contain only a phase and result; never credentials or native logs.
    await writeFile(report, JSON.stringify({ phase, passed }));
    void vscode.commands.executeCommand('workbench.action.quit');
  }
}
