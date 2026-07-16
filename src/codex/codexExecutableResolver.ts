import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';

const CODEX_PACKAGE_NAME = '@openai/codex';
const DEFAULT_VERSION_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT = 16_384;

export type CodexCommandSource = 'configured-native' | 'path-native' | 'npm-shim';

export interface CodexCommand {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly resolvedPath: string;
  readonly source: CodexCommandSource;
}

export interface CodexExecutableResolverOptions {
  readonly configuredPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly processExecutable?: string;
}

export interface CodexVersionProbe {
  readonly raw: string;
  readonly version: string | undefined;
}

export class CodexExecutableResolverError extends Error {
  public readonly code: 'not-found' | 'invalid-npm-shim';

  public constructor(code: 'not-found' | 'invalid-npm-shim', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexExecutableResolverError';
    this.code = code;
  }
}

export async function resolveCodexCommand(
  options: CodexExecutableResolverOptions = {}
): Promise<CodexCommand> {
  const configuredPath = options.configuredPath?.trim();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  if (configuredPath && configuredPath.toLowerCase() !== 'codex') {
    return resolveConfiguredCommand(configuredPath, { ...options, cwd, env, platform });
  }

  const pathDirectories = pathEntries(env, platform);
  const native = await findNativeOnPath(pathDirectories, platform);
  if (native) {
    return {
      executable: native,
      prefixArgs: [],
      resolvedPath: native,
      source: 'path-native'
    };
  }

  const npmShim = await findNpmShimOnPath(pathDirectories, {
    ...options,
    cwd,
    env,
    platform
  });
  if (npmShim) {
    return npmShim;
  }

  throw new CodexExecutableResolverError(
    'not-found',
    'Codex CLI was not found in PATH. Install @openai/codex or set codexThreadManager.codexPath.'
  );
}

export function probeCodexVersion(
  command: CodexCommand,
  timeoutMs = DEFAULT_VERSION_TIMEOUT_MS
): Promise<CodexVersionProbe> {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(command.executable, [...command.prefixArgs, '--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }

      const raw = (stdout.trim() || stderr.trim()).slice(0, MAX_VERSION_OUTPUT);
      const match = /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(raw);
      resolveProbe({ raw, version: match?.[1] });
    };

    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(0, MAX_VERSION_OUTPUT);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      finish(new Error(`codex --version failed with ${detail}.`));
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`codex --version timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });
}

interface NormalizedResolverOptions extends CodexExecutableResolverOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

async function resolveConfiguredCommand(
  configuredPath: string,
  options: NormalizedResolverOptions
): Promise<CodexCommand> {
  const candidate = pathLike(configuredPath)
    ? isAbsolute(configuredPath)
      ? configuredPath
      : resolve(options.cwd, configuredPath)
    : await findNamedOnPath(configuredPath, options.env, options.platform);

  if (!candidate || !(await isFile(candidate, options.platform))) {
    throw new CodexExecutableResolverError(
      'not-found',
      `The configured Codex CLI path does not exist or is not executable: ${configuredPath}`
    );
  }

  const npmCommand = await tryResolveOfficialNpmShim(candidate, options);
  if (npmCommand) {
    return npmCommand;
  }

  if (options.platform === 'win32' && !['.exe', '.com'].includes(extname(candidate).toLowerCase())) {
    throw new CodexExecutableResolverError(
      'invalid-npm-shim',
      'The configured Windows script is not an official @openai/codex npm shim.'
    );
  }

  return {
    executable: await canonicalPath(candidate),
    prefixArgs: [],
    resolvedPath: await canonicalPath(candidate),
    source: 'configured-native'
  };
}

async function findNativeOnPath(
  directories: readonly string[],
  platform: NodeJS.Platform
): Promise<string | undefined> {
  if (platform === 'win32') {
    for (const directory of directories) {
      for (const filename of ['codex.exe', 'codex.com']) {
        const candidate = join(directory, filename);
        if (await isFile(candidate, platform)) {
          return canonicalPath(candidate);
        }
      }
    }
    return undefined;
  }

  for (const directory of directories) {
    const candidate = join(directory, 'codex');
    if (!(await isFile(candidate, platform))) {
      continue;
    }
    if (!(await tryFindOfficialPackage(candidate))) {
      return canonicalPath(candidate);
    }
  }
  return undefined;
}

async function findNpmShimOnPath(
  directories: readonly string[],
  options: NormalizedResolverOptions
): Promise<CodexCommand | undefined> {
  const filenames = options.platform === 'win32' ? ['codex.cmd', 'codex.ps1', 'codex'] : ['codex'];
  for (const directory of directories) {
    for (const filename of filenames) {
      const candidate = join(directory, filename);
      if (!(await isFile(candidate, options.platform))) {
        continue;
      }
      const command = await tryResolveOfficialNpmShim(candidate, options);
      if (command) {
        return command;
      }
    }
  }
  return undefined;
}

async function tryResolveOfficialNpmShim(
  shimPath: string,
  options: NormalizedResolverOptions
): Promise<CodexCommand | undefined> {
  const packageInfo = await tryFindOfficialPackage(shimPath);
  if (!packageInfo) {
    return undefined;
  }

  const nodePath = await resolveNodeExecutable(dirname(shimPath), options);
  if (!nodePath) {
    throw new CodexExecutableResolverError(
      'not-found',
      'The official @openai/codex npm shim was found, but the Node.js executable was not found in PATH.'
    );
  }

  return {
    executable: nodePath,
    prefixArgs: [packageInfo.binPath],
    resolvedPath: await canonicalPath(shimPath),
    source: 'npm-shim'
  };
}

interface OfficialPackageInfo {
  readonly binPath: string;
}

async function tryFindOfficialPackage(shimPath: string): Promise<OfficialPackageInfo | undefined> {
  const canonicalShim = await canonicalPath(shimPath);
  const manifestCandidates = [
    join(dirname(shimPath), 'node_modules', '@openai', 'codex', 'package.json'),
    ...ancestorManifestPaths(dirname(canonicalShim))
  ];
  const seen = new Set<string>();

  for (const manifestPath of manifestCandidates) {
    const key = manifestPath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const manifest = await readPackageManifest(manifestPath);
    if (!manifest || manifest.name !== CODEX_PACKAGE_NAME) {
      continue;
    }
    const binEntry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.codex;
    if (typeof binEntry !== 'string' || !binEntry) {
      continue;
    }
    const binPath = resolve(dirname(manifestPath), binEntry);
    if (!(await isFile(binPath, process.platform))) {
      continue;
    }

    const canonicalBin = await canonicalPath(binPath);
    if (canonicalShim !== canonicalBin && !isWindowsShim(shimPath)) {
      continue;
    }
    return { binPath: canonicalBin };
  }
  return undefined;
}

interface PackageManifest {
  readonly name?: unknown;
  readonly bin?: string | { readonly codex?: unknown };
}

async function readPackageManifest(manifestPath: string): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

function ancestorManifestPaths(startDirectory: string): string[] {
  const paths: string[] = [];
  let directory = startDirectory;
  for (;;) {
    paths.push(join(directory, 'package.json'));
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) {
      return paths;
    }
    directory = parent;
  }
}

async function resolveNodeExecutable(
  shimDirectory: string,
  options: NormalizedResolverOptions
): Promise<string | undefined> {
  const filename = options.platform === 'win32' ? 'node.exe' : 'node';
  const adjacent = join(shimDirectory, filename);
  if (await isFile(adjacent, options.platform)) {
    return canonicalPath(adjacent);
  }

  for (const directory of pathEntries(options.env, options.platform)) {
    const candidate = join(directory, filename);
    if (await isFile(candidate, options.platform)) {
      return canonicalPath(candidate);
    }
  }

  const processExecutable = options.processExecutable ?? process.execPath;
  if (basename(processExecutable).toLowerCase() === filename.toLowerCase() && await isFile(processExecutable, options.platform)) {
    return canonicalPath(processExecutable);
  }
  return undefined;
}

async function findNamedOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<string | undefined> {
  const names = platform === 'win32' && !extname(name)
    ? [`${name}.exe`, `${name}.com`, `${name}.cmd`, `${name}.ps1`, name]
    : [name];
  for (const directory of pathEntries(env, platform)) {
    for (const filename of names) {
      const candidate = join(directory, filename);
      if (await isFile(candidate, platform)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const rawPath = platform === 'win32'
    ? env.Path ?? env.PATH ?? env.path ?? ''
    : env.PATH ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  return rawPath.split(separator).map((entry) => stripQuotes(entry.trim())).filter(Boolean);
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function pathLike(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.includes('\\') || value.startsWith('.');
}

function isWindowsShim(value: string): boolean {
  return ['.cmd', '.ps1', ''].includes(extname(value).toLowerCase());
}

async function isFile(value: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(value)).isFile()) {
      return false;
    }
    if (platform !== 'win32') {
      await access(value, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return resolve(value);
  }
}
