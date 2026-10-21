import { build } from 'esbuild';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';

const development = process.argv.includes('--development');
const directory = development ? '.vscode-test/development-extension' : 'dist';
await mkdir(directory, { recursive: true });
const result = await build({
  entryPoints: [development ? 'src/dev/extension.ts' : 'src/extension.ts'],
  outfile: `${directory}/extension.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: development,
  metafile: true,
});
if (
  !development &&
  Object.keys(result.metafile.inputs).some((input) => /(?:^|\/)src\/(?:dev|test)\//.test(input))
)
  throw new Error('Development/test code entered the production dependency graph.');
await writeFile(`${directory}/build-meta.json`, JSON.stringify(result.metafile, null, 2) + '\n');
if (development) {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  manifest.main = './extension.cjs';
  manifest.displayName = 'MaritimeFS (Development)';
  await writeFile(`${directory}/package.json`, JSON.stringify(manifest, null, 2) + '\n');
  await cp('resources', `${directory}/resources`, { recursive: true });
}
console.log(
  development
    ? 'Built isolated development/test extension.'
    : 'Built production extension without development/test modules.',
);
