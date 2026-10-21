import { redact, label } from '../utils/redact';
export function formatLog(entry: {
  timestamp: string | null;
  level: string;
  message: string;
}): string {
  return `${label(entry.timestamp ?? 'unknown time')} [${label(entry.level)}] ${redact(entry.message)}`;
}
