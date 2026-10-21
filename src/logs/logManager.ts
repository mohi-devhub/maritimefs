import * as vscode from 'vscode';
import type { MaritimeClient } from '../api/types';
import { label } from '../utils/redact';
import { formatLog } from './formatLog';
export class LogManager implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('MaritimeFS · Agent Logs');
  constructor(private readonly client: () => MaritimeClient) {}
  async show(id: string, name: string): Promise<void> {
    const entries = await this.client().logs(id);
    this.channel.clear();
    this.channel.appendLine(
      `${label(name)} (${id}) — ${this.client().simulated ? 'SIMULATED — ' : ''}recent logs; refresh manually`,
    );
    for (const entry of entries) this.channel.appendLine(formatLog(entry));
    this.channel.show(true);
  }
  dispose(): void {
    this.channel.dispose();
  }
}
