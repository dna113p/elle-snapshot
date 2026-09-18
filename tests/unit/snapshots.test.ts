import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { bundleImageSnapshot, compareSnapshots } from '../../src/core.ts';
import { cli, image, json, temporaryDirectory } from '../helpers.ts';

let dir: string;
beforeEach(async () => { dir = await temporaryDirectory(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const bundle = async (name: string, color = 0, width = 16, height = 16) => bundleImageSnapshot({
  imagePath: await image(dir, name, color, width, height), label: name, outputDir: join(dir, name),
});

test('writes portable image bundles and compares them after moving without original files', async () => {
  const source = await bundle('source');
  const saved = await json(source.bundlePath);
  assert.equal(saved.outputDir, '.');
  assert.equal(saved.source, 'source.png');
  assert.equal(saved.assets[0].screenshotPath, 'source.png');
  assert.ok(!JSON.stringify(saved).includes(dir));
  await cp(join(dir, 'source'), join(dir, 'moved'), { recursive: true });
  await rm(join(dir, 'source'), { recursive: true });
  const target = await bundle('target');
  const compared = await compareSnapshots({sourceCapturePath: join(dir, 'moved/capture.bundle.json'), targetCapturePath: target.bundlePath});
  assert.equal(compared.report.verdict, 'pass');
  assert.equal(compared.report.metrics.screenshotSimilarity, 1);
  assert.ok(!isAbsolute(compared.report.sourceScreenshotPath));
  assert.equal(compared.report.diffImagePath, 'diff.png');
});

test('reads existing absolute-path bundles', async () => {
  const source = await bundle('legacy');
  await writeFile(source.bundlePath, JSON.stringify(source.bundle));
  const compared = await compareSnapshots({ sourceCapturePath: source.bundlePath, targetCapturePath: source.bundlePath });
  assert.equal(compared.report.verdict, 'pass');
});

test('rejects unknown, unmatched, ambiguous and partial asset names', async () => {
  const source = await bundle('source');
  const saved = await json(source.bundlePath);
  saved.assets.push({key:'missing', label:'missing', matched:false});
  saved.assets[0].selector = '.card';
  await writeFile(source.bundlePath, JSON.stringify(saved));
  for (const name of ['typo', 'missing', 'card']) {
    await assert.rejects(compareSnapshots({sourceCapturePath:source.bundlePath,targetCapturePath:source.bundlePath,targetAsset:name}), /missing, unmatched, or ambiguous/);
  }
  saved.assets.push({...saved.assets[0],key:'other'});
  await writeFile(source.bundlePath, JSON.stringify(saved));
  await assert.rejects(compareSnapshots({sourceCapturePath:source.bundlePath,targetCapturePath:source.bundlePath,targetAsset:'source'}), /ambiguous/);
});

test('rejects unsupported schema and duplicate asset keys', async () => {
  const source = await bundle('source');
  const saved = await json(source.bundlePath);
  saved.schemaVersion = 99;
  await writeFile(source.bundlePath, JSON.stringify(saved));
  await assert.rejects(compareSnapshots({sourceCapturePath:source.bundlePath,targetCapturePath:source.bundlePath}), /unsupported/);
  saved.schemaVersion = 1;
  saved.assets.push(saved.assets[0]);
  await writeFile(source.bundlePath, JSON.stringify(saved));
  await assert.rejects(compareSnapshots({sourceCapturePath:source.bundlePath,targetCapturePath:source.bundlePath}), /duplicate/);
});

test('different pixels produce an issue and opt-in CI failure, default stays report-only', async () => {
  const source = await bundle('source', 0);
  const target = await bundle('target', 255);
  const args = ['compare','--source',source.bundlePath,'--target',target.bundlePath,'--output-dir',join(dir,'report')];
  const normal = cli(args, dir);
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /Verdict: fail/);
  assert.equal(cli([...args, '--fail-on-diff'], dir).status, 2);
  assert.equal(cli([...args, '--target-asset', 'typo'], dir).status, 1);
  const report = await json(join(dir,'report/compare.report.json'));
  assert.ok(report.issues.some((issue: {type: string}) => issue.type === 'screenshot'));
  assert.equal(cli(['compare','--source',source.bundlePath,'--target',source.bundlePath,'--fail-on-diff'], dir).status, 0);
});

test('size mismatches cannot pass even when pixel similarity is high', async () => {
  const source = await bundle('source',255,100,100);
  const target = await bundle('target',255,100,101);
  const compared = await compareSnapshots({sourceCapturePath:source.bundlePath,targetCapturePath:target.bundlePath});
  assert.notEqual(compared.report.verdict, 'pass');
  assert.ok(compared.report.issues.some(issue => issue.type === 'size'));
});

test('rejects non-PNG input and supplies a safe name for non-ASCII labels', async () => {
  const path = join(dir,'wrong.png');
  await writeFile(path, 'not a PNG');
  await assert.rejects(bundleImageSnapshot({imagePath:path,outputDir:join(dir,'wrong')}), /PNG/);
  const result = await bundleImageSnapshot({imagePath:await image(dir,'valid'),label:'✨',outputDir:join(dir,'unicode')});
  assert.equal((await json(result.bundlePath)).assets[0].screenshotPath, 'image.png');
});

test('help works through the public launcher and errors have a nonzero exit', () => {
  const help = cli(['--help'], dir);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--fail-on-diff/);
  assert.equal(cli(['bundle-image'], dir).status, 1);
  assert.equal(cli(['unknown'], dir).status, 1);
});

test('bounds generated filenames for long labels', async () => {
  const result = await bundle('a'.repeat(80));
  const long = await bundleImageSnapshot({imagePath:result.bundle.assets[0].screenshotPath!,label:'long '.repeat(100),outputDir:join(dir,'long')});
  const saved = await json(long.bundlePath);
  assert.ok(saved.assets[0].screenshotPath.length <= 84);
  const compared = await compareSnapshots({sourceCapturePath:long.bundlePath,targetCapturePath:long.bundlePath});
  assert.equal(compared.report.verdict,'pass');
});

test('empty explicit asset options are errors, never default comparisons', async () => {
  const source = await bundle('source');
  for (const value of ['', '   ']) {
    await assert.rejects(compareSnapshots({sourceCapturePath:source.bundlePath,targetCapturePath:source.bundlePath,sourceAsset:value}), /must not be empty/);
    const result = cli(['compare','--source',source.bundlePath,'--target',source.bundlePath,'--target-asset',value,'--fail-on-diff'],dir);
    assert.equal(result.status,1,result.stdout);
    assert.match(result.stderr,/must not be empty/);
  }
});

test('default imported image labels contain only the basename on every platform', async () => {
  const original = await bundle('private-directory');
  const result = await bundleImageSnapshot({imagePath:original.bundle.assets[0].screenshotPath!,outputDir:join(dir,'import')});
  const saved = await json(result.bundlePath);
  assert.equal(saved.label,'private-directory.png');
  assert.equal(saved.assets[0].label,'private-directory.png');
  assert.ok(!saved.label.includes(dir));
});
