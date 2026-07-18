import { spawnSync } from 'node:child_process';
import { runDoctor } from './doctor.mjs';

const offline = process.argv.includes('--offline');
const current = await runDoctor({ quiet: true });
if (current.ok) {
  console.log('[bootstrap] Existing dependencies passed the health check; npm ci was skipped.');
  process.exit(0);
}

const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const commandArgs = npmExecPath ? [npmExecPath] : [];
commandArgs.push(
  'ci',
  '--include=dev',
  '--install-links=true',
  '--no-audit',
  '--prefer-offline',
  '--fetch-retries=1',
  '--fetch-timeout=15000'
);
if (offline) commandArgs.push('--offline');

console.log(`[bootstrap] Installing locked dependencies${offline ? ' from the local npm cache only' : ' with cache preference'}…`);
const installation = spawnSync(command, commandArgs, {
  cwd: process.cwd(),
  stdio: 'inherit',
  windowsHide: true
});
if (installation.error) throw installation.error;
if (installation.status !== 0) {
  console.error(
    offline
      ? '[bootstrap] The npm cache is incomplete. Retry npm run bootstrap with network access.'
      : '[bootstrap] npm ci failed. Check network access and the npm debug log shown above.'
  );
  process.exit(installation.status ?? 1);
}

const verified = await runDoctor();
if (!verified.ok) {
  console.error('[bootstrap] npm reported success, but the installed dependency tree is incomplete.');
  process.exit(1);
}
