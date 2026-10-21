import * as vscode from 'vscode';
import type { MaritimeClient } from '../api/types';
import { label, redact } from '../utils/redact';
/** One attached command per explicit action. No shell, stdin session, streaming or automatic retries. */
export class CommandRunner implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('MaritimeFS · Command Runner');
  constructor(private readonly client: () => MaritimeClient) {}
  show(id: string, name: string): void {
    this.channel.clear();
    this.channel.appendLine(
      `${label(name)} (${id})${this.client().simulated ? ' — SIMULATED' : ''}`,
    );
    this.channel.appendLine(
      'Non-interactive command runner. Use MaritimeFS: Execute Command to submit a JSON argv array, e.g. ["pwd"]. Commands run in the agent default working directory.',
    );
    this.channel.show(true);
  }
  async execute(id: string, name: string, argv: string[]): Promise<void> {
    this.show(id, name);
    this.channel.appendLine('Executing once (30 second remote timeout)…');
    const result = await this.client().exec(id, argv);
    if (result.stdout) this.channel.appendLine(redact(result.stdout));
    if (result.stderr) this.channel.appendLine(`[stderr]\n${redact(result.stderr)}`);
    if (result.executionId) this.channel.appendLine(`Execution: ${label(result.executionId)}`);
    this.channel.appendLine(
      `Exit code: ${result.exitCode}${result.status ? ` (${label(result.status)})` : ''}`,
    );
  }
  dispose(): void {
    this.channel.dispose();
  }
}
