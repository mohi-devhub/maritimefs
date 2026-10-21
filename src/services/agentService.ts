import * as vscode from 'vscode';
import type { Agent, MaritimeClient } from '../api/types';
export class AgentService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  agents: Agent[] = [];
  loaded = false;
  private revision = 0;
  constructor(private readonly client: () => MaritimeClient) {}
  async refresh(): Promise<Agent[]> {
    const revision = ++this.revision;
    const agents = await this.client().listAgents();
    if (revision === this.revision) {
      this.agents = agents;
      this.loaded = true;
      this.emitter.fire();
    }
    return agents;
  }
  seed(agents: Agent[]): void {
    ++this.revision;
    this.agents = agents;
    this.loaded = true;
    this.emitter.fire();
  }
  update(agent: Agent): void {
    const index = this.agents.findIndex((a) => a.id === agent.id);
    if (index >= 0) this.agents[index] = agent;
    this.emitter.fire();
  }
  reset(): void {
    ++this.revision;
    this.agents = [];
    this.loaded = false;
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}
