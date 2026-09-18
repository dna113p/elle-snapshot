#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageRoot, 'src', 'cli.ts');

const aliases = new Map([
  ['snapshot:capture-url', 'capture-url'],
  ['snapshot:bundle-image', 'bundle-image'],
  ['snapshot:compare', 'compare'],
  ['figma:receive', 'figma-receive'],
  ['receive-figma', 'figma-receive'],
]);

const args = process.argv.slice(2);
const command = aliases.get(args[0]) ?? args[0];
const result = spawnSync('bun', [cliPath, ...(command ? [command, ...args.slice(1)] : [])], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error('Could not find `bun` on PATH. Install Bun before using elle-snapshot.');
  } else {
    console.error(result.error.message);
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
