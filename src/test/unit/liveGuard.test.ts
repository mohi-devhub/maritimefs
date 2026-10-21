import { describe, expect, it, vi } from 'vitest';
import { LiveGuard } from '../live/guard';
function setup() {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
  const guard = new LiveGuard('approved-agent', fetcher);
  guard.root = '/volume';
  guard.directory = '/volume/test-only';
  return { guard, fetcher };
}
describe('opt-in live acceptance guard', () => {
  it.each([
    '/api/agents',
    '/api/agents/another-agent/sleep',
    '/api/agents/approved-agent/chat',
    '/api/agents/approved-agent/restart',
  ])('refuses unapproved POST %s', async (route) => {
    const { guard, fetcher } = setup();
    await expect(
      guard.fetch('https://api.maritime.sh' + route, { method: 'POST' }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    '/volume/other',
    '/volume/test-only/../other',
    '/volume/test-only-sibling',
    '/volume/test-only/%2e%2e/x',
  ])('refuses mutation path %s', async (path) => {
    const { guard, fetcher } = setup();
    await expect(
      guard.fetch('https://api.maritime.sh/api/agents/approved-agent/files/mkdir', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('allows only one structured pwd command', async () => {
    const { guard, fetcher } = setup();
    const url = 'https://api.maritime.sh/api/agents/approved-agent/exec';
    await guard.fetch(url, { method: 'POST', body: JSON.stringify({ command: ['pwd'] }) });
    await expect(
      guard.fetch(url, { method: 'POST', body: JSON.stringify({ command: ['pwd'] }) }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('blocks chat-style uploads without an approved destination', async () => {
    const { guard, fetcher } = setup();
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    await expect(
      guard.fetch('https://api.maritime.sh/api/agents/approved-agent/files/upload', {
        method: 'POST',
        body: form,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
