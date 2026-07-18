import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const projectRoot = process.cwd();

export async function runDoctor({ quiet = false, root = projectRoot, silent = false } = {}) {
  const problems = [];
  const warnings = [];
  const packageJson = await readJson(join(root, 'package.json'));
  const packageLock = await readJson(join(root, 'package-lock.json'));
  const expectedNode = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
  const actualNode = process.versions.node;

  if (actualNode !== expectedNode) {
    warnings.push(`Node.js ${actualNode} is active; .nvmrc pins ${expectedNode}.`);
  }

  const npmUserAgent = process.env.npm_config_user_agent ?? '';
  const expectedNpm = String(packageJson.packageManager ?? '').replace(/^npm@/u, '');
  const actualNpm = /^npm\/([^\s]+)/u.exec(npmUserAgent)?.[1];
  if (actualNpm && expectedNpm && actualNpm !== expectedNpm) {
    warnings.push(`npm ${actualNpm} is active; packageManager pins npm ${expectedNpm}.`);
  }

  const lockedPackages = packageLock.packages ?? {};
  for (const name of Object.keys(packageJson.devDependencies ?? {})) {
    const lockEntry = lockedPackages[`node_modules/${name}`];
    if (!lockEntry?.version) {
      problems.push(`${name} is missing from package-lock.json.`);
      continue;
    }
    const installed = await readJson(join(root, 'node_modules', name, 'package.json'), false);
    if (!installed) {
      problems.push(`${name}@${lockEntry.version} is not installed.`);
    } else if (installed.version !== lockEntry.version) {
      problems.push(`${name} is ${installed.version}; package-lock.json requires ${lockEntry.version}.`);
    }
  }

  const executableSuffix = process.platform === 'win32' ? '.cmd' : '';
  for (const relativePath of [
    `node_modules/.bin/tsc${executableSuffix}`,
    `node_modules/.bin/esbuild${executableSuffix}`,
    `node_modules/.bin/vsce${executableSuffix}`,
    'node_modules/typescript/bin/tsc',
    'node_modules/esbuild/bin/esbuild',
    'node_modules/@vscode/vsce/vsce',
    'node_modules/@azure/identity/dist/commonjs/index.js'
  ]) {
    try {
      await access(join(root, relativePath), constants.R_OK);
    } catch {
      problems.push(`Required dependency file is missing: ${relativePath}`);
    }
  }

  if (!silent && (!quiet || problems.length > 0)) {
    for (const warning of warnings) console.warn(`[doctor] Warning: ${warning}`);
    for (const problem of problems) console.error(`[doctor] Error: ${problem}`);
  }
  if (!silent && problems.length > 0) {
    console.error('[doctor] Dependencies are incomplete. Run npm run bootstrap:offline, then npm run bootstrap if the cache is insufficient.');
  } else if (!silent && !quiet) {
    console.log(`[doctor] Dependency installation is healthy (${Object.keys(packageJson.devDependencies ?? {}).length} direct development dependencies checked).`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

async function readJson(path, required = true) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(projectRoot, 'scripts', 'doctor.mjs')) {
  void runDoctor().then((result) => {
    if (!result.ok) process.exitCode = 1;
  });
}
