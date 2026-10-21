import * as vscode from 'vscode';
import type { Agent } from '../api/types';
import type { AgentService } from '../services/agentService';
import { normalizeError } from '../api/errors';
import { label } from '../utils/redact';
export type AgentNode =
  | { kind: 'agent' | 'files' | 'terminal' | 'logs'; agent: Agent }
  | { kind: 'error'; message: string };
export class AgentTreeProvider implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AgentNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  constructor(
    private readonly service: AgentService,
    private readonly connected: () => boolean,
    private readonly root: (id: string) => string | undefined,
  ) {
    this.subscription = service.onDidChange(() => this.refresh());
  }
  refresh(): void {
    this.emitter.fire(undefined);
  }
  async getChildren(node?: AgentNode): Promise<AgentNode[]> {
    if (!node) {
      if (!this.connected()) return [];
      try {
        if (!this.service.loaded) await this.service.refresh();
        return this.service.agents.map((agent) => ({ kind: 'agent', agent }));
      } catch (error) {
        return [{ kind: 'error', message: normalizeError(error).message }];
      }
    }
    return node.kind === 'agent'
      ? (['files', 'terminal', 'logs'] as const).map((kind) => ({ kind, agent: node.agent }))
      : [];
  }
  getTreeItem(node: AgentNode): vscode.TreeItem {
    if (node.kind === 'error') {
      const item = new vscode.TreeItem(node.message);
      item.iconPath = new vscode.ThemeIcon('warning');
      item.command = { command: 'maritimefs.connect', title: 'Connect Account' };
      return item;
    }
    const a = node.agent;
    if (node.kind === 'agent') {
      const item = new vscode.TreeItem(
        label(a.name || a.id),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = a.id;
      item.contextValue = 'maritimeAgent';
      item.description = label(a.status);
      item.tooltip = [
        label(a.name),
        `ID: ${a.id}`,
        `Status: ${label(a.status)}`,
        `Volume: ${this.root(a.id) ?? 'locked; open explicitly'}`,
        ...(a.projectId ? [`Project: ${label(a.projectId)}`] : []),
      ].join('\n');
      item.iconPath = new vscode.ThemeIcon(
        a.status === 'sleeping'
          ? 'debug-pause'
          : a.status === 'active'
            ? 'vm-running'
            : a.status === 'error'
              ? 'error'
              : 'vm',
      );
      return item;
    }
    const item = new vscode.TreeItem(
      node.kind === 'files' ? 'Files' : node.kind === 'terminal' ? 'Command Runner' : 'Logs',
    );
    item.iconPath = new vscode.ThemeIcon(
      node.kind === 'files' ? 'files' : node.kind === 'terminal' ? 'terminal' : 'output',
    );
    item.command = {
      command:
        node.kind === 'files'
          ? 'maritimefs.openWorkspace'
          : node.kind === 'terminal'
            ? 'maritimefs.openTerminal'
            : 'maritimefs.viewLogs',
      title: String(item.label),
      arguments: [a.id],
    };
    return item;
  }
  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
