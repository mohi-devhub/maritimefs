import * as vscode from 'vscode';
import type { Agent, MaritimeClient } from './api/types';
import { CredentialManager } from './auth/credentialManager';
import { AccessSession } from './services/accessSession';
import { AgentService } from './services/agentService';
import { AgentTreeProvider } from './agents/agentTreeProvider';
import { RemoteVolume } from './filesystem/remoteVolume';
import { MaritimeFileSystemProvider } from './filesystem/maritimeFileSystemProvider';
import { LogManager } from './logs/logManager';
import { CommandRunner } from './terminal/remoteTerminal';
import { Interaction } from './commands/interaction';
import { registerCommands } from './commands/registerCommands';
import { label } from './utils/redact';
import { normalizeError } from './api/errors';
export interface ExtensionTestApi {
  auth: CredentialManager;
  access: AccessSession;
  agents: AgentService;
  volume: RemoteVolume;
  provider: MaritimeFileSystemProvider;
  tree: AgentTreeProvider;
  ui: Interaction;
  logs: LogManager;
  runner: CommandRunner;
}
export interface RuntimeOptions {
  simulated: boolean;
  createClient: (key: string) => MaritimeClient;
  exposeTestApi?: boolean;
}
export async function activateRuntime(
  context: vscode.ExtensionContext,
  { simulated, createClient, exposeTestApi = false }: RuntimeOptions,
): Promise<ExtensionTestApi | undefined> {
  const ui = new Interaction();
  const temporarySecrets = new Map<string, string>();
  let connectionChanged = () => {};
  const auth = new CredentialManager(
    simulated
      ? {
          get: async (k) => temporarySecrets.get(k),
          store: async (k, v) => {
            temporarySecrets.set(k, v);
          },
          delete: async (k) => {
            temporarySecrets.delete(k);
          },
        }
      : context.secrets,
    createClient,
    () => connectionChanged(),
  );
  const client = () => auth.client;
  const access = new AccessSession(client);
  const agents = new AgentService(client);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'maritimefs.switchAgent';
  const setActive = (agent: Agent | undefined) => {
    if (!auth.connected) {
      status.hide();
      return;
    }
    const locked =
      !agent && vscode.workspace.workspaceFolders?.some((f) => f.uri.scheme === 'maritime');
    status.command = locked ? 'maritimefs.openWorkspace' : 'maritimefs.switchAgent';
    const icon = locked ? 'lock' : agent?.status === 'sleeping' ? 'debug-pause' : 'vm';
    const name = agent
      ? label(agent.name) + (agent.status === 'sleeping' ? ' (sleeping)' : '')
      : locked
        ? 'Maritime: Open Workspace'
        : 'Maritime';
    status.text = `$(${icon}) ${simulated ? 'SIMULATED · ' : ''}${name}`;
    status.tooltip = agent
      ? `${label(agent.status)} · ${agent.id} — Select agent`
      : locked
        ? 'Account connected. Remote workspace locked — click to open it without entering your key again.'
        : 'MaritimeFS account connected — Select agent';
    status.show();
  };
  const volume = new RemoteVolume(
    client,
    access,
    () => vscode.workspace.isTrusted,
    (id, path) =>
      ui.confirm(
        `Permanently delete ${path} on ${id}? Directories are deleted recursively. This cannot be undone.`,
        'Delete',
      ),
    (changes) => provider.emit(changes),
  );
  const provider = new MaritimeFileSystemProvider(volume);
  const tree = new AgentTreeProvider(
    agents,
    () => auth.connected,
    (id) => access.root(id),
  );
  const logs = new LogManager(client);
  const runner = new CommandRunner(client);
  connectionChanged = () => {
    access.clear();
    volume.clear();
    agents.reset();
    setActive(undefined);
    void vscode.commands.executeCommand('setContext', 'maritimefs.connected', auth.connected);
  };
  const view = vscode.window.createTreeView('maritimefs.agents', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  if (simulated) view.description = 'SIMULATED';
  context.subscriptions.push(
    auth,
    agents,
    status,
    tree,
    view,
    provider,
    logs,
    runner,
    vscode.workspace.registerFileSystemProvider('maritime', provider, { isCaseSensitive: true }),
    ...registerCommands({
      auth,
      access,
      agents,
      volume,
      logs,
      runner,
      ui,
      simulated,
      setActive,
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'maritime') {
        const a = agents.agents.find((a) => a.id === editor.document.uri.authority);
        if (a) setActive(a);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed)
        if (folder.uri.scheme === 'maritime') access.revoke(folder.uri.authority);
    }),
  );
  try {
    await auth.restore();
  } catch (error) {
    // A temporary keychain failure must not make activation fail and prevent a
    // retry. Never display a native storage exception that may include secrets.
    void vscode.window.showErrorMessage(normalizeError(error).message);
  }
  return exposeTestApi && context.extensionMode === vscode.ExtensionMode.Test
    ? { auth, access, agents, volume, provider, tree, ui, logs, runner }
    : undefined;
}
