import { describe, expect, it } from 'vitest';
import { confined, normalizePath, parseUri } from '../../filesystem/pathUtils';
describe('POSIX paths and remote URIs', () => {
  it('normalizes separators and dot segments', () => {
    expect(normalizePath('/data//a/./b/')).toBe('/data/a/b');
  });
  it.each([
    '/data/../etc',
    '/data/../../etc',
    'relative',
    '/data/a\\b',
    '/data/%2e%2e/a',
    '/data/a\0',
  ])('rejects unsafe path %s', (path) => expect(() => normalizePath(path)).toThrow());
  it('requires whole-segment confinement', () => {
    expect(confined('/opt/data/a', '/opt/data')).toBe('/opt/data/a');
    expect(() => confined('/opt/datafoo/a', '/opt/data')).toThrow();
    expect(() => confined('/etc/passwd', '/data')).toThrow();
    expect(() => confined('/etc', '/')).toThrow();
  });
  it('rejects foreign schemes, authority credentials, queries and fragments', () => {
    const uri = {
      scheme: 'maritime',
      authority: 'agent-1',
      path: '/data/a',
      query: '',
      fragment: '',
    };
    expect(parseUri(uri)).toEqual({ id: 'agent-1', path: '/data/a' });
    for (const invalid of [
      { scheme: 'file' },
      { authority: 'key@agent' },
      { authority: 'agent:443' },
      { query: 'token=x' },
      { fragment: 'x' },
    ])
      expect(() => parseUri({ ...uri, ...invalid })).toThrow();
  });
});
