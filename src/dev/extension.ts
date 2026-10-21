import * as vscode from 'vscode';
import { activateRuntime } from '../activation';
import type { ExtensionTestApi } from '../activation';
import { SdkMaritimeClient } from '../api/maritimeClient';
import { MockMaritimeClient } from './mockClient';

/** Built into an isolated development fixture, never into dist or a VSIX. */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<ExtensionTestApi | undefined> {
  if (context.extensionMode === vscode.ExtensionMode.Production)
    throw new Error('This development build cannot run as an installed extension.');
  const testing = context.extensionMode === vscode.ExtensionMode.Test;
  const simulated = testing
    ? process.env.MARITIMEFS_LIVE_TEST !== '1'
    : process.env.MARITIMEFS_DEV_REAL !== '1';
  return activateRuntime(context, {
    simulated,
    createClient: (key) => (simulated ? new MockMaritimeClient() : new SdkMaritimeClient(key)),
    exposeTestApi: testing,
  });
}
