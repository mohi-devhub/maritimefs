import { describe, expect, it } from 'vitest';
import { CredentialManager, SECRET_KEY } from '../../auth/credentialManager';
import type { SecretStore } from '../../auth/credentialManager';
import { MockMaritimeClient } from '../../dev/mockClient';
function setup() {
  const values = new Map<string, string>();
  const clients: MockMaritimeClient[] = [];
  const secrets: SecretStore = {
    get: async (k) => values.get(k),
    store: async (k, v) => {
      values.set(k, v);
    },
    delete: async (k) => {
      values.delete(k);
    },
  };
  const manager = new CredentialManager(secrets, () => {
    const client = new MockMaritimeClient();
    clients.push(client);
    return client;
  });
  return { manager, values, clients, secrets };
}
describe('SecretStorage authentication', () => {
  it('validates before storing and reconnects without restarting', async () => {
    const { manager, values, clients } = setup();
    await manager.connect('test-one');
    expect(values.get(SECRET_KEY)).toBe('test-one');
    await manager.connect('test-two');
    expect(clients[0]?.disposed).toBe(true);
    expect(manager.connected).toBe(true);
    await manager.disconnect();
    expect(values.size).toBe(0);
    expect(manager.connected).toBe(false);
  });
  it('does not replace a working connection when candidate credentials fail', async () => {
    const values = new Map<string, string>();
    const manager = new CredentialManager(
      {
        get: async (k) => values.get(k),
        store: async (k, v) => {
          values.set(k, v);
        },
        delete: async (k) => {
          values.delete(k);
        },
      },
      (key) => {
        const client = new MockMaritimeClient();
        if (key === 'bad') client.failNext = 'auth';
        return client;
      },
    );
    await manager.connect('good');
    const good = manager.client;
    await expect(manager.connect('bad')).rejects.toMatchObject({ code: 'auth' });
    expect(values.get(SECRET_KEY)).toBe('good');
    expect(manager.client).toBe(good);
    manager.dispose();
  });
  it('restores stored credentials without network requests', async () => {
    const { manager, values, clients } = setup();
    values.set(SECRET_KEY, 'test-key');
    await manager.restore();
    expect(clients[0]?.calls).toEqual([]);
    manager.dispose();
  });
  it('preserves a stored key across manager disposal and a fresh instance', async () => {
    const { manager, secrets } = setup();
    await manager.connect('test-key');
    manager.dispose();
    const client = new MockMaritimeClient();
    const next = new CredentialManager(secrets, () => client);
    await next.restore();
    expect(next.connected).toBe(true);
    expect(client.calls).toEqual([]);
    await next.disconnect();
    await next.restore();
    expect(next.connected).toBe(false);
  });
  it('does not replace or dispose an already connected client when restoring again', async () => {
    const { manager, clients } = setup();
    await manager.connect('test-key');
    const client = manager.client;
    await manager.restore();
    expect(manager.client).toBe(client);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.disposed).toBe(false);
    manager.dispose();
  });
  it('redacts storage read errors and permits an explicit retry', async () => {
    const { manager, secrets, values } = setup();
    values.set(SECRET_KEY, 'test-key');
    const get = secrets.get;
    secrets.get = async () => {
      throw new Error('native error with sensitive content');
    };
    await expect(manager.restore()).rejects.toMatchObject({ code: 'credentialStorage' });
    await expect(manager.restore()).rejects.not.toThrow('sensitive content');
    expect(manager.connected).toBe(false);
    secrets.get = get;
    await manager.restore();
    expect(manager.connected).toBe(true);
    manager.dispose();
  });
  it('redacts storage write failures and keeps the previous connection', async () => {
    const { manager, secrets, values, clients } = setup();
    await manager.connect('test-key');
    const original = manager.client;
    secrets.store = async () => {
      throw new Error('native error with sensitive content');
    };
    await expect(manager.connect('replacement')).rejects.toMatchObject({
      code: 'credentialStorage',
    });
    expect(manager.client).toBe(original);
    expect(values.get(SECRET_KEY)).toBe('test-key');
    expect(clients[1]?.disposed).toBe(true);
    manager.dispose();
  });
  it('cannot restore a delayed key read after disconnect', async () => {
    const { manager, secrets } = setup();
    let release!: (key: string) => void;
    secrets.get = () =>
      new Promise<string>((resolve) => {
        release = resolve;
      });
    const restoring = manager.restore();
    await manager.disconnect();
    release('test-key');
    await restoring;
    expect(manager.connected).toBe(false);
  });
  it('refuses an empty or multiline key without touching storage', async () => {
    const { manager, values } = setup();
    await expect(manager.connect('')).rejects.toMatchObject({ code: 'invalid' });
    await expect(manager.connect('x\ny')).rejects.toMatchObject({ code: 'invalid' });
    expect(values.size).toBe(0);
  });
});

describe('credential changes during pending storage', () => {
  it('serializes disconnect after a pending key store', async () => {
    const values = new Map<string, string>();
    let release!: () => void;
    let storing!: () => void;
    const started = new Promise<void>((r) => {
      storing = r;
    });
    const manager = new CredentialManager(
      {
        get: async (k) => values.get(k),
        store: async (k, v) => {
          storing();
          await new Promise<void>((r) => {
            release = r;
          });
          values.set(k, v);
        },
        delete: async (k) => {
          values.delete(k);
        },
      },
      () => new MockMaritimeClient(),
    );
    const connecting = manager.connect('test-key');
    await started;
    const rejection = expect(connecting).rejects.toMatchObject({ code: 'cancelled' });
    const disconnecting = manager.disconnect();
    release();
    await rejection;
    await disconnecting;
    expect(values.size).toBe(0);
    expect(manager.connected).toBe(false);
  });
});

describe('pending validation disposal', () => {
  it('disposes a validating client immediately when disconnected', async () => {
    const client = new MockMaritimeClient();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const original = client.listAgents.bind(client);
    client.listAgents = async () => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      return original();
    };
    const manager = new CredentialManager(
      { get: async () => undefined, store: async () => {}, delete: async () => {} },
      () => client,
    );
    const connecting = manager.connect('test-key');
    const failure = expect(connecting).rejects.toMatchObject({ code: 'cancelled' });
    await ready;
    await manager.disconnect();
    expect(client.disposed).toBe(true);
    release();
    await failure;
    expect(manager.connected).toBe(false);
  });
});
