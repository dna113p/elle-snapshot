import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { image, root, temporaryDirectory } from '../helpers.ts';

test('public CLI runs with Bun alone and no runtimes on PATH', async () => {
  const dir = await temporaryDirectory();
  const launcher = join(root, 'bin/elle-snapshot.js');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = '';
  const run = (args: string[]) => spawnSync(process.execPath, [launcher, ...args], {
    cwd: dir, env, encoding: 'utf8', timeout: 30_000,
  });
  try {
    assert.ok((await readFile(launcher, 'utf8')).startsWith('#!/usr/bin/env bun\n'));
    const help = run(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Elle Snapshot/);
    const source = await image(dir, 'reference');
    const bundled = run(['bundle-image', '--image', source, '--output-dir', join(dir, 'bundle')]);
    assert.equal(bundled.status, 0, bundled.stderr);
    const bundlePath = join(dir, 'bundle/capture.bundle.json');
    const compared = run(['compare', '--source', bundlePath, '--target', bundlePath, '--fail-on-diff']);
    assert.equal(compared.status, 0, compared.stderr);
    assert.match(compared.stdout, /Verdict: pass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
