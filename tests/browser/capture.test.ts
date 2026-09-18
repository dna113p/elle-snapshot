import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { captureUrlSnapshot, compareSnapshots } from '../../src/core.ts';
import { cli, json, temporaryDirectory } from '../helpers.ts';

let dir: string;
const url = 'data:text/html,' + encodeURIComponent('<!doctype html><title>Snapshot test</title><style>body{margin:0;background:white}main{height:400px}#card{width:160px;height:80px;background:navy;color:white}</style><main><div id="card">Snapshot smoke</div></main>');
beforeEach(async () => { dir = await temporaryDirectory(); });
afterEach(async () => { await rm(dir,{recursive:true,force:true}); });

test('captures page and selector evidence, then compares after relocation', async () => {
  const result = await captureUrlSnapshot({url,selectors:['#card'],viewportWidth:320,viewportHeight:200,waitAfterLoadMs:0,outputDir:join(dir,'capture')});
  assert.equal(result.bundle.title,'Snapshot test');
  assert.equal(result.bundle.assets[0].height,400);
  assert.equal(result.bundle.assets[1].width,160);
  const saved = await json(result.bundlePath);
  assert.equal(saved.rootDomPath,'page-root.json');
  assert.equal(saved.assets[1].domPath,'01-card.json');
  await rename(join(dir,'capture'),join(dir,'moved'));
  const path = join(dir,'moved/capture.bundle.json');
  const compare = await compareSnapshots({sourceCapturePath:path,targetCapturePath:path,sourceAsset:'selector-1',targetAsset:'#card'});
  assert.equal(compare.report.verdict,'pass');
  assert.ok(compare.report.metrics.sourceNodeCount > 0);
  const matched = await captureUrlSnapshot({url,matchSizePath:path,fullPage:false,waitAfterLoadMs:0,outputDir:join(dir,'matched')});
  assert.deepEqual(matched.bundle.viewport,{width:320,height:400});
});

test('CLI viewport-only works and missing selectors fail instead of silently succeeding', async () => {
  const capture = cli(['capture-url','--url',url,'--viewport-width','320','--viewport-height','200','--viewport-only','--wait-after-load-ms','0','--output-dir',join(dir,'viewport')]);
  assert.equal(capture.status,0,capture.stderr);
  assert.equal((await json(join(dir,'viewport/capture.bundle.json'))).assets[0].height,200);
  const missing = cli(['capture-url','--url',url,'--selector','#missing','--wait-after-load-ms','0','--output-dir',join(dir,'missing')]);
  assert.equal(missing.status,1);
  assert.match(missing.stderr,/No element matched selector/);
});

test('validates numeric viewport and wait options', async () => {
  await assert.rejects(captureUrlSnapshot({url,viewportWidth:0,outputDir:join(dir,'invalid')}),/positive integer/);
  await assert.rejects(captureUrlSnapshot({url,waitAfterLoadMs:-1,outputDir:join(dir,'invalid')}),/nonnegative/);
});
