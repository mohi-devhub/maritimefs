import type * as vscode from 'vscode';
import { activateRuntime } from './activation';
import { SdkMaritimeClient } from './api/maritimeClient';

/** The packaged entry point always uses the official SDK and SecretStorage. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await activateRuntime(context, {
    simulated: false,
    createClient: (key) => new SdkMaritimeClient(key),
  });
}
