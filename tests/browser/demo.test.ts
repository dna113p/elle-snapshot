import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { json, root, temporaryDirectory } from '../helpers.ts';

test('standalone demo captures bundled fixtures and preserves previous runs', async () => {
  const dir = await temporaryDirectory();
  const output = join(dir,'demo');
  const run = () => spawnSync('bun',[join(root,'scripts/demo.ts'),'--output-dir',output],{
    cwd:dir,encoding:'utf8',timeout:30_000,
  });
  try {
    const result = run();
    assert.equal(result.status,0,result.stderr);
    const reportPath = join(output,'comparison/compare.report.json');
    const report = await json(reportPath);
    assert.notEqual(report.verdict,'pass');
    assert.ok(report.metrics.mismatchPixels > 0);
    assert.equal(report.sourceAssetKey,'selector-1 (.card)');
    assert.equal(report.targetAssetKey,'selector-1 (.card)');
    const before = await readFile(reportPath,'utf8');
    assert.equal(run().status,1,'Demo should refuse an existing output directory');
    assert.equal(await readFile(reportPath,'utf8'),before);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
