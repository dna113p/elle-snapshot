import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { captureUrlSnapshot, compareSnapshots } from '../src/core.ts';

const main = async () => {
  const { values } = parseArgs({ options: {
    'output-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  }});
  if (values.help) {
    console.log('bun run demo [--output-dir <new-directory>]\nCapture two bundled example cards and compare their intentional visual differences.');
    return;
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const output = resolve(values['output-dir'] ?? join('.snapshots', 'demo', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(dirname(output), {recursive:true});
  // Refuse to overwrite a previous run, even when --output-dir is explicit.
  await mkdir(output);
  const capture = (name: string) => captureUrlSnapshot({
    url: pathToFileURL(join(root, 'examples', 'basic', `${name}.html`)).href,
    label: `demo-${name}`, selectors: ['.card'], viewportWidth:640, viewportHeight:480,
    waitAfterLoadMs:0, outputDir:join(output,name),
  });
  const baseline = await capture('baseline');
  const current = await capture('current');
  const result = await compareSnapshots({
    sourceCapturePath:baseline.bundlePath, targetCapturePath:current.bundlePath,
    sourceAsset:'selector-1', targetAsset:'selector-1', outputDir:join(output,'comparison'),
  });
  console.log(`Demo complete: ${result.report.verdict} (intentional padding and button-color changes)`);
  console.log(`Baseline: ${baseline.bundle.assets[1].screenshotPath}`);
  console.log(`Current:  ${current.bundle.assets[1].screenshotPath}`);
  console.log(`Report:   ${result.reportMarkdownPath}`);
  console.log(`Diff:     ${result.diffImagePath}`);
  console.log('Inspect both card images and the diff. The demo exits 0 when it completes; a non-pass verdict is expected.');
};

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
