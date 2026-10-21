import { posix } from 'node:path';
import { ApiError } from '../api/errors';
export interface RemoteUri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
}
export function normalizePath(path: string): string {
  if (
    !path.startsWith('/') ||
    Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '\\') ||
    path.includes('%') ||
    path.split('/').includes('..')
  )
    throw new ApiError('invalid');
  return posix.normalize(path).replace(/\/$/, '') || '/';
}
export function agentId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new ApiError('invalid');
  return id;
}
export function parseUri(uri: RemoteUri): { id: string; path: string } {
  if (uri.scheme !== 'maritime' || uri.query || uri.fragment) throw new ApiError('invalid');
  return { id: agentId(uri.authority), path: normalizePath(uri.path) };
}
export function confined(path: string, root: string): string {
  const normalized = normalizePath(path);
  const base = normalizePath(root);
  if (base === '/' || (normalized !== base && !normalized.startsWith(base + '/')))
    throw new ApiError('permission');
  return normalized;
}
export function entryName(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/')) throw new ApiError('invalid');
  normalizePath('/' + name);
  return name;
}
