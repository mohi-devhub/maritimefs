import * as vscode from 'vscode';
import { ApiError, normalizeError } from '../api/errors';
import type { Agent, LifecycleAction, MaritimeClient } from '../api/types';
import type { CredentialManager } from '../auth/credentialManager';
import type { AccessSession } from '../services/accessSession';
import type { AgentService } from '../services/agentService';
import type { RemoteVolume } from '../filesystem/remoteVolume';
import { remoteUri } from '../filesystem/maritimeFileSystemProvider';
import { agentId } from '../filesystem/pathUtils';
import type { LogManager } from '../logs/logManager';
import type { CommandRunner } from '../terminal/remoteTerminal';
import { parseArgv } from '../terminal/argv';
import type { Interaction } from './interaction';
import { label } from '../utils/redact';
export interface CommandContext {
  auth: CredentialManager;
  access: AccessSession;
  agents: AgentService;
  volume: RemoteVolume;
  logs: LogManager;
  runner: CommandRunner;
  ui: Interaction;
  simulated: boolean;
  setActive: (agent: Agent | undefined) => void;
}
export function registerCommands(context: CommandContext): vscode.Disposable[] {
  const { auth, access, agents, volume, logs, runner, ui } = context;
  function sameConnection(client: MaritimeClient): void {
    if (client !== auth.client) throw new ApiError('cancelled');
  }
  async function select(argument?: unknown): Promise<Agent | undefined> {
    let id: string | undefined;
    if (typeof argument === 'string') id = agentId(argument);
    else if (argument && typeof argument === 'object' && 'agent' in argument) {
      const a = argument.agent;
      if (a && typeof a === 'object' && 'id' in a && typeof a.id === 'string') id = agentId(a.id);
    }
    if (id) return auth.client.getAgent(id);
    if (!agents.loaded) await agents.refresh();
    const picked = await vscode.window.showQuickPick(
      agents.agents.map((agent) => ({
        label: label(agent.name),
        description: label(agent.status),
        detail: agent.id,
        agent,
      })),
      {
        title: 'MaritimeFS: Select Target Agent',
        placeHolder: 'Choose the agent this action will affect',
      },
    );
    return picked?.agent;
  }
  function trusted(): void {
    if (!vscode.workspace.isTrusted) throw new ApiError('permission');
  }
  async function canWake(agent: Agent): Promise<boolean> {
    return ui.confirm(
      `${label(agent.name)} (${agent.id}) is sleeping. This action can wake it and consume account resources. Continue?`,
      'Allow Wake',
    );
  }
  async function open(argument?: unknown): Promise<vscode.Uri | undefined> {
    const client = auth.client;
    const agent = await select(argument);
    if (!agent) return;
    sameConnection(client);
    const root = await access.open(agent.id, () => canWake(agent));
    const uri = remoteUri(agent.id, root);
    context.setActive(await auth.client.getAgent(agent.id));
    // Show Explorer before changing workspace identity: VS Code may restart this host
    // when converting an empty/single-folder window to a multi-folder workspace.
    await vscode.commands.executeCommand('workbench.view.explorer');
    sameConnection(client);
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.some((f) => f.uri.toString() === uri.toString())) {
      let subscription: vscode.Disposable | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The update's boolean only means it was accepted, not that Explorer can
      // resolve the new folder yet. Subscribe first so a fast event isn't missed.
      const added = new Promise<boolean>((resolve) => {
        subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
          if (vscode.workspace.workspaceFolders?.some((f) => f.uri.toString() === uri.toString()))
            resolve(true);
        });
        timer = setTimeout(() => resolve(false), 10_000);
      });
      try {
        const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
          uri,
          name: `${context.simulated ? 'SIMULATED · ' : ''}${label(agent.name)}`,
        });
        if (!ok || !(await added)) throw new ApiError('workspace');
      } finally {
        subscription?.dispose();
        clearTimeout(timer);
      }
    }
    sameConnection(client);
    volume.refresh(agent.id);
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return uri;
  }
  async function lifecycle(action: LifecycleAction, argument?: unknown): Promise<void> {
    trusted();
    const client = auth.client;
    const agent = await select(argument);
    if (!agent) return;
    const verb = action === 'start' ? 'Wake' : action === 'sleep' ? 'Sleep' : 'Restart';
    if (
      !(await ui.confirm(
        `${verb} ${label(agent.name)} (${agent.id})? ${action === 'start' ? 'Waking uses account resources.' : 'This can interrupt running work.'}`,
        verb,
      ))
    )
      return;
    sameConnection(client);
    trusted();
    access.revoke(agent.id);
    volume.clear();
    const result = await client.lifecycle(agent.id, action);
    agents.update(result);
    context.setActive(result);
    void vscode.window.showInformationMessage(
      `${label(result.name)}: ${label(result.status)}. Refresh status if the operation is still transitioning.`,
    );
  }
  const handlers: Record<string, (argument?: unknown) => Promise<unknown>> = {
    restoreConnection: async () => {
      await auth.restore();
      void vscode.window.showInformationMessage(
        auth.connected
          ? 'MaritimeFS account is connected. Use Open Agent Workspace to unlock remote files.'
          : 'No saved Maritime key was found in this VS Code profile. Use Connect Account.',
      );
    },
    connect: async () => {
      const key = context.simulated
        ? 'simulated'
        : await ui.input({
            title: 'Connect Maritime Account',
            prompt:
              'Enter a personal Maritime API key (mk_…). Stored only in VS Code SecretStorage.',
            password: true,
            ignoreFocusOut: true,
          });
      if (!key) return;
      const list = await auth.connect(key);
      agents.seed(list);
      void vscode.window.showInformationMessage(
        context.simulated ? 'MaritimeFS connected to SIMULATED agents.' : 'MaritimeFS connected.',
      );
    },
    disconnect: async () => {
      await auth.disconnect();
      context.setActive(undefined);
    },
    connectionStatus: async () => {
      if (!auth.connected) {
        void vscode.window.showInformationMessage('MaritimeFS is disconnected.');
        return;
      }
      const list = await agents.refresh();
      void vscode.window.showInformationMessage(
        `${context.simulated ? 'SIMULATED connection' : 'Maritime authenticated'} · ${list.length} agents visible`,
      );
    },
    refresh: async () => {
      const list = await agents.refresh();
      for (const agent of list) {
        if (agent.status !== 'active') access.revoke(agent.id);
        volume.refresh(agent.id);
      }
    },
    openWorkspace: open,
    lockWorkspaces: async () => {
      access.clear();
      volume.clear();
      context.setActive(undefined);
    },
    refreshFiles: async (argument) => {
      const agent = await select(argument);
      if (agent) {
        await access.require(agent.id);
        volume.refresh(agent.id);
      }
    },
    switchAgent: async () => {
      const agent = await select();
      if (agent) context.setActive(agent);
    },
    refreshStatus: async (argument) => {
      const selected = await select(argument);
      if (selected) {
        const agent = await auth.client.getAgent(selected.id);
        agents.update(agent);
        context.setActive(agent);
        if (agent.status !== 'active') access.revoke(agent.id);
      }
    },
    wake: (argument) => lifecycle('start', argument),
    sleep: (argument) => lifecycle('sleep', argument),
    restart: (argument) => lifecycle('restart', argument),
    openTerminal: async (argument) => {
      const agent = await select(argument);
      if (agent) {
        runner.show(agent.id, agent.name);
        context.setActive(agent);
      }
    },
    execute: async (argument) => {
      trusted();
      const client = auth.client;
      const selected = await select(argument);
      if (!selected) return;
      const input = await ui.input({
        title: `Execute on ${label(selected.name)} (${selected.id})`,
        prompt:
          'Non-interactive JSON argv array, e.g. ["pwd"]. Use ["sh","-lc","…"] only when you intend shell execution.',
        value: '["pwd"]',
        ignoreFocusOut: true,
      });
      if (!input) return;
      const argv = parseArgv(input);
      sameConnection(client);
      const agent = await client.getAgent(selected.id);
      if (agent.status === 'sleeping') {
        if (!(await canWake(agent))) return;
      } else if (agent.status !== 'active') throw new ApiError('unavailable');
      sameConnection(client);
      trusted();
      await runner.execute(agent.id, agent.name, argv);
      context.setActive(await auth.client.getAgent(agent.id));
    },
    viewLogs: async (argument) => {
      const agent = await select(argument);
      if (agent) await logs.show(agent.id, agent.name);
    },
  };
  return Object.entries(handlers).map(([name, handler]) =>
    vscode.commands.registerCommand(`maritimefs.${name}`, async (argument?: unknown) => {
      try {
        return await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `MaritimeFS: ${name}` },
          async () => handler(argument),
        );
      } catch (error) {
        const safe = normalizeError(error);
        if (safe.code !== 'cancelled') void vscode.window.showErrorMessage(safe.message);
        return undefined;
      }
    }),
  );
}
