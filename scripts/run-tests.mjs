import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const outputDirectory = await mkdtemp(join(tmpdir(), 'codex-thread-manager-tests-'));
const entryPoints = [
  'test/unit/codexExecutableResolver.test.mjs',
  'test/unit/dependencyDoctor.test.mjs',
  'test/unit/jsonlTransport.test.ts',
  'test/unit/markdownRenderer.test.mjs',
  'test/unit/pinStore.test.ts',
  'test/unit/conversationPanelManager.test.ts',
  'test/unit/conversationInteraction.test.ts',
  'test/unit/conversationProtocol.test.ts',
  'test/unit/conversationReducer.test.ts',
  'test/unit/conversationQuality.test.ts',
  'test/unit/conversationSession.test.ts',
  'test/unit/conversationViewModel.test.ts',
  'test/unit/conversationWebview.test.ts',
  'test/unit/protocolGuards.test.ts',
  'test/unit/threadRepository.test.ts',
  'test/unit/threadListWebviewProvider.test.ts',
  'test/unit/threadTreeProvider.test.ts',
  'test/unit/threadsProtocol.test.ts',
  'test/integration/appServerCompatibility.test.ts',
  'test/integration/appServerConversation.test.ts',
  'test/integration/appServerOperations.test.ts',
  'test/integration/realCli.test.ts'
];
try {
  await build({
    entryPoints,
    bundle: true,
    entryNames: '[dir]/[name]',
    format: 'cjs',
    outbase: 'test',
    platform: 'node',
    target: 'node20',
    outdir: outputDirectory,
    plugins: [{
      name: 'vscode-test-double',
      setup(buildContext) {
        buildContext.onResolve({ filter: /^vscode$/ }, () => ({
          path: resolve('test/support/vscode.ts')
        }));
      }
    }],
    logLevel: 'silent'
  });
  run(process.execPath, [
    '--test',
    ...entryPoints.map((entryPoint) =>
      join(outputDirectory, entryPoint.replace(/^test[\\/]/u, '').replace(/\.(?:mjs|ts)$/u, '.js'))
    )
  ]);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`Test command exited with status ${result.status ?? 'unknown'}.`);
  }
}
