export interface Agent {
  id: string;
  name: string;
  status: string;
  projectId?: string;
}
export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}
export interface FileList {
  path: string;
  root: string;
  entries: FileEntry[];
}
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionId?: string;
  status?: string;
}
export interface LogEntry {
  id: string;
  level: string;
  message: string;
  timestamp: string | null;
}
export type LifecycleAction = 'start' | 'sleep' | 'restart';
export interface MaritimeClient {
  readonly simulated: boolean;
  listAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent>;
  listFiles(id: string, path?: string): Promise<FileList>;
  download(id: string, path: string): Promise<Uint8Array>;
  upload(id: string, path: string, bytes: Uint8Array): Promise<void>;
  mkdir(id: string, path: string): Promise<void>;
  move(id: string, from: string, to: string): Promise<void>;
  delete(id: string, path: string): Promise<void>;
  exec(id: string, argv: string[]): Promise<ExecResult>;
  lifecycle(id: string, action: LifecycleAction): Promise<Agent>;
  logs(id: string): Promise<LogEntry[]>;
  dispose(): void;
}
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
