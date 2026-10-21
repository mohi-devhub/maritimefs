import { ApiError } from './errors';
import type { Agent, ExecResult, FileList, LogEntry } from './types';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError('invalid');
  return value;
}
export function agent(value: unknown): Agent {
  const a = object(value);
  return {
    id: string(a.id),
    name: string(a.name),
    status: string(a.status),
    ...(typeof a.projectId === 'string' ? { projectId: a.projectId } : {}),
  };
}
export function array<T>(value: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new ApiError('invalid');
  return value.map(parse);
}
export function fileList(value: unknown): FileList {
  const v = object(value);
  return {
    root: string(v.root),
    path: string(v.path),
    entries: array(v.entries, (value) => {
      const e = object(value);
      if (
        typeof e.isDir !== 'boolean' ||
        typeof e.size !== 'number' ||
        !Number.isSafeInteger(e.size) ||
        e.size < 0 ||
        typeof e.mtime !== 'number' ||
        !Number.isFinite(e.mtime) ||
        e.mtime < 0
      )
        throw new ApiError('invalid');
      if (e.isSymlink || e.isLink || e.type === 'symlink') throw new ApiError('permission');
      return { name: string(e.name), isDir: e.isDir, size: e.size, mtime: e.mtime };
    }),
  };
}
export function execution(value: unknown): ExecResult {
  const v = object(value);
  if (typeof v.exitCode !== 'number' || !Number.isSafeInteger(v.exitCode))
    throw new ApiError('invalid');
  return {
    exitCode: v.exitCode,
    stdout: string(v.stdout),
    stderr: string(v.stderr),
    ...(typeof v.executionId === 'string' ? { executionId: v.executionId } : {}),
    ...(typeof v.status === 'string' ? { status: v.status } : {}),
  };
}
export function logEntry(value: unknown): LogEntry {
  const v = object(value);
  return {
    id: string(v.id),
    message: string(v.message),
    level: string(v.level),
    timestamp: v.timestamp === null ? null : string(v.timestamp),
  };
}
