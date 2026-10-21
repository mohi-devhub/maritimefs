import * as vscode from 'vscode';
export class Interaction {
  input(options: vscode.InputBoxOptions): PromiseLike<string | undefined> {
    return vscode.window.showInputBox(options);
  }
  async confirm(message: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
  }
}
