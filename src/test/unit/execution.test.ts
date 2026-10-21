import { describe, expect, it } from 'vitest';
import { parseArgv } from '../../terminal/argv';
import { formatLog } from '../../logs/formatLog';
import { redact } from '../../utils/redact';
describe('explicit non-interactive commands', () => {
  it('preserves argv boundaries without shell interpolation', () =>
    expect(parseArgv('["printf","$(touch /tmp/no)","a b"]')).toEqual([
      'printf',
      '$(touch /tmp/no)',
      'a b',
    ]));
  it.each(['pwd', '[]', '[""]', '["pwd",2]', '["a\\u0000"]', '{}'])(
    'rejects invalid argv %s',
    (input) => expect(() => parseArgv(input)).toThrow(),
  );
});
describe('log formatting and redaction', () => {
  it('formats historical records with timestamps', () =>
    expect(
      formatLog({ timestamp: '2026-10-21T00:00:00Z', level: 'error', message: 'Failed' }),
    ).toBe('2026-10-21T00:00:00Z [error] Failed'));
  it('redacts known token formats and common secret assignments', () => {
    const text = redact('mk_exampletoken Bearer example API_KEY="abc xyz" password=hidden');
    expect(text).not.toContain('example');
    expect(text).not.toContain('abc');
    expect(text).not.toContain('hidden');
  });
  it('supports unknown log timestamps', () =>
    expect(formatLog({ timestamp: null, level: 'info', message: 'ready' })).toContain(
      'unknown time',
    ));
});
