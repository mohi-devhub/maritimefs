import { readFile, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { MockMaritimeClient } from '../../dev/mockClient';
import { ApiError } from '../../api/errors';

export const FIXTURE_KEY = 'package-verification-fixture';
export const FIXTURE_AGENT = 'mock-active';

/** Companion test extension only. Exercises the installed SDK's HTTP boundary. */
export class PackageHttpFixture {
  readonly client = new MockMaritimeClient();
  readonly requests: string[] = [];
  readonly unexpected: string[] = [];
  failure?: 'auth' | 'upload';
  constructor() {
    this.client.agents[0]!.name = 'Package HTTP fixture';
  }
  async restore(filename: string): Promise<void> {
    const saved = JSON.parse(await readFile(filename, 'utf8')) as {
      files: [string, { bytes?: string; mtime: number }][];
    };
    this.client.files.set(
      FIXTURE_AGENT,
      new Map(
        saved.files.map(([name, node]) => [
          name,
          {
            mtime: node.mtime,
            ...(node.bytes === undefined ? {} : { bytes: Buffer.from(node.bytes, 'base64') }),
          },
        ]),
      ),
    );
  }
  async save(filename: string): Promise<void> {
    const files = [...this.client.files.get(FIXTURE_AGENT)!].map(([name, node]) => [
      name,
      {
        mtime: node.mtime,
        ...(node.bytes === undefined ? {} : { bytes: Buffer.from(node.bytes).toString('base64') }),
      },
    ]);
    await writeFile(filename, JSON.stringify({ files }));
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.origin !== 'https://api.maritime.sh')
      throw new Error('Network access blocked by package test.');
    this.requests.push(`${method} ${url.pathname}`);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (
      new Headers(init?.headers).get('authorization') !== `Bearer ${FIXTURE_KEY}` ||
      this.failure === 'auth'
    )
      return json({ detail: 'fixture authentication failure' }, 401);
    const base = `/api/agents/${FIXTURE_AGENT}`;
    try {
      if (method === 'GET' && url.pathname === '/api/agents')
        return json([await this.client.getAgent(FIXTURE_AGENT)]);
      if (method === 'GET' && url.pathname === base)
        return json(await this.client.getAgent(FIXTURE_AGENT));
      if (method === 'GET' && url.pathname === `${base}/logs`)
        return json(await this.client.logs(FIXTURE_AGENT));
      const target = url.searchParams.get('path') ?? undefined;
      if (method === 'GET' && url.pathname === `${base}/files/list`)
        return json(await this.client.listFiles(FIXTURE_AGENT, target));
      if (method === 'GET' && url.pathname === `${base}/files/download` && target)
        return new Response(Buffer.from(await this.client.download(FIXTURE_AGENT, target)));
      if (method === 'POST' && url.pathname === `${base}/files/upload`) {
        if (this.failure === 'upload') return json({ detail: 'fixture permission failure' }, 403);
        const form = init?.body;
        if (!(form instanceof FormData)) throw new Error('Invalid fixture upload.');
        const file = form.get('file');
        const destination = form.get('dest_dir');
        if (!file || typeof file === 'string' || typeof destination !== 'string')
          throw new Error('Invalid fixture upload.');
        const filename = posix.join(destination, file.name);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this.client.upload(FIXTURE_AGENT, filename, bytes);
        return json({ ok: true, path: filename, size: bytes.length });
      }
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (
        method === 'POST' &&
        url.pathname === `${base}/files/mkdir` &&
        typeof body.path === 'string'
      ) {
        await this.client.mkdir(FIXTURE_AGENT, body.path);
        return json({ ok: true });
      }
      if (
        method === 'POST' &&
        url.pathname === `${base}/files/move` &&
        typeof body.from === 'string' &&
        typeof body.to === 'string'
      ) {
        await this.client.move(FIXTURE_AGENT, body.from, body.to);
        return json({ ok: true });
      }
      if (method === 'DELETE' && url.pathname === `${base}/files/delete` && target) {
        await this.client.delete(FIXTURE_AGENT, target);
        return json({ ok: true });
      }
      if (
        method === 'POST' &&
        url.pathname === `${base}/exec` &&
        Array.isArray(body.command) &&
        body.command.every((item): item is string => typeof item === 'string')
      )
        return json(await this.client.exec(FIXTURE_AGENT, body.command));
      this.unexpected.push(`${method} ${url.pathname}`);
      return json({ detail: 'Unexpected fixture route' }, 400);
    } catch (error) {
      if (error instanceof ApiError) {
        const status =
          { missing: 404, exists: 409, permission: 403 }[
            error.code as 'missing' | 'exists' | 'permission'
          ] ?? 400;
        return json({ detail: 'Fixture operation refused' }, status);
      }
      this.unexpected.push(`${method} ${url.pathname}`);
      return json({ detail: 'Fixture contract error' }, 400);
    }
  };
}
