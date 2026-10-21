import { describe, expect, it } from 'vitest';
import { AccessSession } from '../../services/accessSession';
import { MockMaritimeClient } from '../../dev/mockClient';
describe('wake consent and lifecycle', () => {
  it('blocks restored workspaces without even a file request', async () => {
    const client = new MockMaritimeClient();
    const access = new AccessSession(() => client);
    await expect(access.require('mock-active')).rejects.toMatchObject({ code: 'locked' });
    expect(client.calls).toEqual([]);
  });
  it('does not wake a sleeping agent after consent is declined', async () => {
    const client = new MockMaritimeClient();
    const access = new AccessSession(() => client);
    await expect(access.open('mock-sleeping', async () => false)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(client.agents[1]?.status).toBe('sleeping');
    expect(client.calls).toEqual(['getAgent']);
  });
  it('discovers volume roots only after consent and locks on sleep', async () => {
    const client = new MockMaritimeClient();
    const access = new AccessSession(() => client);
    expect(await access.open('mock-sleeping', async () => true)).toBe('/data');
    expect(client.agents[1]?.status).toBe('active');
    await client.lifecycle('mock-sleeping', 'sleep');
    await expect(access.require('mock-sleeping')).rejects.toMatchObject({ code: 'unavailable' });
    expect(access.root('mock-sleeping')).toBeUndefined();
  });
  it('shows real returned lifecycle states', async () => {
    const client = new MockMaritimeClient();
    expect((await client.lifecycle('mock-active', 'sleep')).status).toBe('sleeping');
    expect((await client.lifecycle('mock-active', 'start')).status).toBe('active');
    expect((await client.lifecycle('mock-active', 'restart')).status).toBe('active');
  });
});

describe('approval invalidation during pending requests', () => {
  it('does not restore a session after disconnect clears an in-flight open', async () => {
    const client = new MockMaritimeClient();
    const access = new AccessSession(() => client);
    let release!: () => void;
    const original = client.listFiles.bind(client);
    client.listFiles = async (id, path) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(id, path);
    };
    const pending = access.open('mock-active', async () => true);
    await Promise.resolve();
    access.clear();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(access.root('mock-active')).toBeUndefined();
  });
});
