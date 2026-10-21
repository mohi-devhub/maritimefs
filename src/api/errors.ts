export type ErrorCode =
  | 'locked'
  | 'disconnected'
  | 'credentialStorage'
  | 'moveIncomplete'
  | 'workspace'
  | 'auth'
  | 'permission'
  | 'billing'
  | 'missing'
  | 'exists'
  | 'conflict'
  | 'rateLimit'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'invalid'
  | 'tooLarge';
const messages: Record<ErrorCode, string> = {
  locked:
    'Remote workspace access is locked. Your account is connected; run MaritimeFS: Open Agent Workspace. You do not need to enter the API key again.',
  disconnected: 'MaritimeFS is disconnected. Run MaritimeFS: Connect Account.',
  credentialStorage:
    'VS Code could not access secure credential storage. Check your OS keychain and run MaritimeFS: Restore Saved Connection. No plaintext credential fallback is used.',
  moveIncomplete:
    'The remote rename could not be verified. Refresh the folder and inspect both paths before retrying. No extra deletion was attempted.',
  workspace:
    'VS Code could not add the remote folder. Open Explorer and run MaritimeFS: Open Agent Workspace again.',
  auth: 'Maritime credentials were rejected. Connect Account again.',
  permission: 'Access denied. Check API key scopes, workspace trust, and remote permissions.',
  billing:
    'Maritime refused this operation due to a plan or quota limit. No plan changes were made.',
  missing: 'The remote agent or path does not exist.',
  exists: 'The destination already exists.',
  conflict:
    'Remote content changed or no read baseline exists. Save a copy of your edits, then reopen the remote file before saving.',
  rateLimit: 'Maritime rate limit reached. Wait before refreshing.',
  network:
    'Cannot reach Maritime. Check your network and retry explicitly. A submitted operation may still have completed.',
  timeout:
    'Maritime request timed out. A submitted operation may still be running; do not blindly resubmit it.',
  cancelled: 'Maritime request cancelled. This does not cancel work already running remotely.',
  unavailable:
    'Agent access is locked or the agent is not active. Use Open Agent Workspace or refresh its status.',
  invalid: 'Invalid Maritime URI, path, command, or API response.',
  tooLarge: 'The file or response exceeds the MaritimeFS memory limit (8 MiB per file).',
};
export class ApiError extends Error {
  constructor(readonly code: ErrorCode) {
    super(messages[code]);
    this.name = 'ApiError';
  }
}
export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (typeof error === 'object' && error !== null) {
    if ('cause' in error && error.cause instanceof ApiError) return error.cause;
    if ('status' in error) {
      const codes: Partial<Record<number, ErrorCode>> = {
        401: 'auth',
        403: 'permission',
        402: 'billing',
        404: 'missing',
        409: 'exists',
        429: 'rateLimit',
        408: 'timeout',
        504: 'timeout',
        400: 'invalid',
        422: 'invalid',
      } as const;
      const code = codes[Number(error.status)];
      if (code) return new ApiError(code);
    }
  }
  return new ApiError('network');
}
