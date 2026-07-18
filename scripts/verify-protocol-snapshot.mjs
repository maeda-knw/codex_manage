import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotDirectory = join(repositoryRoot, 'src', 'codex', 'protocol', 'generated');
const codexEntryPoint = join(repositoryRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const generatedDirectory = await mkdtemp(join(tmpdir(), 'codex-protocol-snapshot-'));

try {
  const generation = spawnSync(
    process.execPath,
    [codexEntryPoint, 'app-server', 'generate-ts', '--out', generatedDirectory],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );
  if (generation.error) throw generation.error;
  if (generation.status !== 0) {
    throw new Error(
      `codex app-server generate-ts exited with status ${generation.status ?? 'unknown'}: ${generation.stderr.trim()}`
    );
  }

  const [snapshotFiles, generatedFiles] = await Promise.all([
    listTypeScriptFiles(snapshotDirectory),
    listTypeScriptFiles(generatedDirectory)
  ]);
  const snapshotProtocolFiles = snapshotFiles.filter((path) => path !== 'version.ts');
  const changes = await compareSnapshots(snapshotProtocolFiles, generatedFiles);
  const pinnedVersion = await readPinnedCodexVersion();
  const recordedVersion = await readRecordedSnapshotVersion();
  if (pinnedVersion !== recordedVersion) {
    changes.unshift(`version mismatch: package=${pinnedVersion}, snapshot=${recordedVersion}`);
  }

  if (changes.length > 0) {
    const summary = changes.slice(0, 20).map((change) => `- ${change}`).join('\n');
    const remainder = changes.length > 20 ? `\n- ...and ${changes.length - 20} more` : '';
    throw new Error(
      `Generated App Server protocol differs from the checked-in snapshot:\n${summary}${remainder}\n` +
      'Run npm run generate:protocol and review the compatibility boundaries.'
    );
  }

  console.log(
    `Verified ${generatedFiles.length} generated protocol files against codex-cli ${pinnedVersion}.`
  );
} finally {
  await rm(generatedDirectory, { recursive: true, force: true });
}

async function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const child of await listTypeScriptFiles(absolutePath)) {
        files.push(join(entry.name, child));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

async function compareSnapshots(snapshotFiles, generatedFiles) {
  const changes = [];
  const snapshotSet = new Set(snapshotFiles);
  const generatedSet = new Set(generatedFiles);
  for (const path of snapshotFiles) {
    if (!generatedSet.has(path)) changes.push(`missing generated file: ${path}`);
  }
  for (const path of generatedFiles) {
    if (!snapshotSet.has(path)) changes.push(`new generated file: ${path}`);
  }
  for (const path of snapshotFiles) {
    if (!generatedSet.has(path)) continue;
    const [snapshot, generated] = await Promise.all([
      readFile(join(snapshotDirectory, path), 'utf8'),
      readFile(join(generatedDirectory, path), 'utf8')
    ]);
    if (normalizeLineEndings(snapshot) !== normalizeLineEndings(generated)) {
      changes.push(`content changed: ${path}`);
    }
  }
  return changes;
}

async function readPinnedCodexVersion() {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const version = packageJson.devDependencies?.['@openai/codex'];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Expected an exact @openai/codex development dependency version.');
  }
  return version;
}

async function readRecordedSnapshotVersion() {
  const versionSource = await readFile(join(snapshotDirectory, 'version.ts'), 'utf8');
  const version = /GENERATED_CODEX_CLI_VERSION = '([^']+)'/u.exec(versionSource)?.[1];
  if (!version) throw new Error('Could not read the generated protocol version marker.');
  return version;
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/gu, '\n');
}
