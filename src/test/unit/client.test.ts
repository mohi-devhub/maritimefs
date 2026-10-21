import { describe, expect, it, vi } from 'vitest';
import { SdkMaritimeClient } from '../../api/maritimeClient';
import { Transport } from '../../api/transport';
import { MAX_FILE_BYTES } from '../../api/types';
import { normalizeError, ApiError } from '../../api/errors';
import { canRetry, retryDelay } from '../../utils/retry';
const agent = { id: 'a', name: 'A', status: 'active' };
function harness(body: unknown = agent, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  return { fetcher, client: new SdkMaritimeClient('test-key', new Transport(fetcher)) };
}
describe('official SDK adapter', () => {
  it('lists and validates control-plane responses', async () => {
    const { client, fetcher } = harness([agent]);
    expect(await client.listAgents()).toEqual([agent]);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.maritime.sh/api/agents');
    client.dispose();
  });
  it.each([401, 403, 402, 404, 409, 429, 500])(
    'redacts upstream errors for status %s',
    async (status) => {
      const { client } = harness({ detail: 'sensitive upstream data' }, status);
      await expect(client.exec('a', ['pwd'])).rejects.not.toThrow('sensitive');
      client.dispose();
    },
  );
  it('never retries an ambiguous command submission', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('private token');
    });
    const client = new SdkMaritimeClient('test-key', new Transport(fetcher));
    await expect(client.exec('a', ['pwd'])).rejects.toMatchObject({ code: 'network' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.dispose();
  });
  it('uploads binary bytes with dest_dir and without a chat notification', async () => {
    const { client, fetcher } = harness({ ok: true, path: '/data/a.bin', size: 3 });
    const bytes = new Uint8Array([0, 255, 128]);
    await client.upload('a', '/data/a.bin', bytes);
    const init = fetcher.mock.calls[0]?.[1];
    const body = init?.body as FormData;
    expect(body.get('dest_dir')).toBe('/data');
    expect(body.has('message')).toBe(false);
    expect(new Uint8Array(await (body.get('file') as File).arrayBuffer())).toEqual(bytes);
    client.dispose();
  });
  it('rejects malformed listings and explicit symlink metadata', async () => {
    const { client } = harness({
      path: '/data',
      root: '/data',
      entries: [{ name: 'link', isDir: false, size: 1, mtime: 1, isSymlink: true }],
    });
    await expect(client.listFiles('a')).rejects.toMatchObject({ code: 'permission' });
    client.dispose();
  });
  it('bounds file body allocation', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('x', { headers: { 'content-length': String(MAX_FILE_BYTES + 1) } }),
    );
    const client = new SdkMaritimeClient('key', new Transport(fetcher));
    await expect(client.download('a', '/data/a')).rejects.toMatchObject({ code: 'tooLarge' });
    client.dispose();
  });
  it('times out and aborts an in-flight request', async () => {
    const fetcher: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('abort'))),
      );
    const client = new SdkMaritimeClient('key', new Transport(fetcher, 5));
    await expect(client.getAgent('a')).rejects.toMatchObject({ code: 'timeout' });
    client.dispose();
  });
  it('cancels all requests when disposed', async () => {
    const transport = new Transport(
      async (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('abort'))),
        ),
    );
    const client = new SdkMaritimeClient('key', transport);
    const pending = client.getAgent('a');
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('retries control reads with bounded Retry-After', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([agent])));
    const client = new SdkMaritimeClient('key', new Transport(fetcher));
    expect(await client.listAgents()).toEqual([agent]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();
  });
  it('does not retry file GETs that can wake agents', async () => {
    const { client, fetcher } = harness({}, 503);
    await expect(client.listFiles('a')).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
describe('safe error and retry policy', () => {
  it.each([
    [401, 'auth'],
    [403, 'permission'],
    [404, 'missing'],
    [409, 'exists'],
    [429, 'rateLimit'],
    [504, 'timeout'],
  ])('maps %s to %s', (status, code) =>
    expect(normalizeError({ status, message: 'secret' }).code).toBe(code),
  );
  it('never leaks arbitrary exception messages', () =>
    expect(normalizeError(new Error('secret')).message).not.toContain('secret'));
  it('only retries safe control-plane GETs', () => {
    expect(canRetry('GET', '/api/agents/a/logs')).toBe(true);
    expect(canRetry('POST', '/api/agents/a/restart')).toBe(false);
    expect(canRetry('DELETE', '/api/agents/a/files/delete')).toBe(false);
    expect(canRetry('GET', '/api/agents/a/files/list')).toBe(false);
  });
  it('bounds numeric and date backoff', () => {
    expect(retryDelay(0, '900')).toBe(20000);
    expect(retryDelay(1, null)).toBe(1000);
    expect(retryDelay(0, '-1')).toBe(0);
    expect(retryDelay(0, 'Thu, 01 Jan 1970 00:00:02 GMT', 1000)).toBe(1000);
  });
});
