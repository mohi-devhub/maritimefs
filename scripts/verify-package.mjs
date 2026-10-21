import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { 'pre-release': { type: 'boolean' } } });
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const filename = `${manifest.name}-${manifest.version}.vsix`;
const files = execFileSync('unzip', ['-Z1', filename], { encoding: 'utf8' }).trim().split('\n');
if (values['pre-release']) {
  const xml = execFileSync('unzip', ['-p', filename, 'extension.vsixmanifest'], {
    encoding: 'utf8',
  });
  if (!/<Property Id="Microsoft\.VisualStudio\.Code\.PreRelease" Value="true"\s*\/>/.test(xml))
    throw new Error('Marketplace pre-release property is missing from the archive.');
}
if (!files.includes('extension/dist/extension.cjs') || !files.includes('extension/package.json'))
  throw new Error('Missing extension entry point or manifest');
for (const file of files) {
  if (
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|node_modules|src|\.git|scripts)(?:\/|$)/.test(file) ||
    /\.(?:pem|key|map)$/.test(file) ||
    /(?:^|\/)(?:demo|test-results|release-artifacts|dist-test)(?:\/|$)/.test(file) ||
    file.endsWith('/build-meta.json')
  )
    throw new Error(`Unexpected private/development file in package: ${file}`);
}
const packaged = JSON.parse(
  execFileSync('unzip', ['-p', filename, 'extension/package.json'], { encoding: 'utf8' }),
);
if (
  packaged.version !== manifest.version ||
  packaged.contributes?.configuration?.properties?.['maritimefs.mode']
)
  throw new Error('Package version mismatch or production simulation setting exposed');
const bundled = execFileSync('unzip', ['-p', filename, 'extension/dist/extension.cjs']);
if (!bundled.equals(readFileSync('dist/extension.cjs')))
  throw new Error('VSIX bundle does not match the production build');
const graph = JSON.parse(readFileSync('dist/build-meta.json', 'utf8'));
if (Object.keys(graph.inputs).some((input) => /(?:^|\/)src\/(?:dev|test)\//.test(input)))
  throw new Error('Development/test modules entered the production build');
for (const marker of [
  'MockMaritimeClient',
  'SIMULATED research-agent',
  'MARITIMEFS_LIVE_TEST',
  'MARITIMEFS_DEV_REAL',
  'maritimefs.mode',
]) {
  if (bundled.includes(Buffer.from(marker)))
    throw new Error('Development/test behavior found in VSIX bundle');
}
// Inspect packaged text without printing matching values.
for (const file of files.filter((f) => /\.(?:cjs|json|md)$/.test(f))) {
  const content = execFileSync('unzip', ['-p', filename, file], {
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (/\bmk_[A-Za-z0-9_-]{20,}\b/.test(content))
    throw new Error('Potential Maritime credential in package (value suppressed)');
}
console.log(
  `Verified ${filename}: ${files.length} entries; production-only module graph and bundle; no simulation setting, mock backend, dotenv, test/development artifacts, or Maritime credentials.`,
);
