import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const { values } = parseArgs({ options: { 'pre-release': { type: 'boolean' } } });
  const preRelease = values['pre-release'] === true;
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a numeric frozen beta version.');
  const directory = path.resolve('release-artifacts', version);
  const filename = `${manifest.name}-${version}.vsix`;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let existing = false;
  try {
    await access(directory);
    existing = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    const frozen = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (Boolean(frozen.preRelease) !== preRelease)
      throw new Error(
        'This version was already frozen for a different channel. Use a new version.',
      );
    if (digest(await readFile(path.join(directory, filename))) !== frozen.sha256)
      throw new Error('Frozen VSIX checksum mismatch. Do not replace this release.');
    console.log(
      `Release ${version} already frozen from ${frozen.sourceCommit}. Existing bytes preserved.`,
    );
    return;
  }
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
    throw new Error('Commit and review the working tree before freezing a release.');
  const notes = await readFile(`docs/releases/${version}.md`);
  execFileSync('npm', ['run', preRelease ? 'package:prerelease' : 'package'], { stdio: 'inherit' });
  execFileSync('npm', ['run', 'verify:package', ...(preRelease ? ['--', '--pre-release'] : [])], {
    stdio: 'inherit',
  });
  const bytes = await readFile(filename);
  const hash = digest(bytes);
  const bundle = execFileSync('unzip', ['-p', filename, 'extension/dist/extension.cjs']);
  const graph = JSON.parse(await readFile('dist/build-meta.json', 'utf8'));
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  const assets = {
    [filename]: bytes,
    SHA256SUMS: `${hash}  ${filename}\n`,
    'release-notes.md': notes,
    'manifest.json':
      JSON.stringify(
        {
          version,
          preRelease,
          filename,
          sha256: hash,
          bundleSha256: digest(bundle),
          sourceCommit: commit,
          builtAt: new Date().toISOString(),
          node: process.version,
          productionInputs: Object.keys(graph.inputs),
          publication:
            'Unpublished artifact; freezing does not create a GitHub or Marketplace release.',
        },
        null,
        2,
      ) + '\n',
  };
  for (const [name, content] of Object.entries(assets)) {
    const target = path.join(directory, name);
    await writeFile(target, content, { flag: 'wx' });
    await chmod(target, 0o444);
  }
  console.log(`Frozen ${directory}\nSHA-256: ${hash}`);
  console.log('Run npm run release:verify to test these exact bytes in a fresh VS Code profile.');
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Release freeze failed.');
  process.exitCode = 1;
});
