import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
describe('extension manifest', () => {
  it('declares a UI extension and safe virtual workspace support', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      extensionKind: string[];
      capabilities: { virtualWorkspaces: boolean };
    };
    expect(manifest.extensionKind).toEqual(['ui']);
    expect(manifest.capabilities.virtualWorkspaces).toBe(true);
  });
});
