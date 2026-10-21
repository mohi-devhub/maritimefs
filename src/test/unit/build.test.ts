import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('production and development dependency boundaries', () => {
  it('bundles the real SDK without any dev/test module or runtime simulation switch', async () => {
    const result = await build({
      entryPoints: ['src/extension.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['vscode'],
      metafile: true,
      write: false,
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs).toContain('src/api/maritimeClient.ts');
    expect(inputs.some((name) => /src\/(dev|test)\//.test(name))).toBe(false);
    const code = result.outputFiles![0]!.text;
    for (const marker of [
      'MockMaritimeClient',
      'SIMULATED research-agent',
      'MARITIMEFS_LIVE_TEST',
      'MARITIMEFS_DEV_REAL',
      'maritimefs.mode',
    ])
      expect(code).not.toContain(marker);
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      contributes: { configuration?: unknown };
    };
    expect(manifest.contributes.configuration).toBeUndefined();
  });
  it('keeps simulation available only in the separately built development entry', async () => {
    const result = await build({
      entryPoints: ['src/dev/extension.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['vscode'],
      metafile: true,
      write: false,
    });
    expect(Object.keys(result.metafile!.inputs)).toContain('src/dev/mockClient.ts');
    expect(result.outputFiles![0]!.text).toContain(
      'This development build cannot run as an installed extension.',
    );
  });
});
