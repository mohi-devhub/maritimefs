export function redact(text: string): string {
  return text
    .replace(/\bmk_[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/(\bBearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    );
}
export function label(text: string): string {
  return redact(text)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\$\(/g, '(')
    .slice(0, 120);
}
