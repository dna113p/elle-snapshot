#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import {
  bundleImageSnapshot,
  captureUrlSnapshot,
  compareSnapshots,
  startFigmaSnapshotReceiver,
} from './index.ts';

const usage = `
Elle Snapshot — capture, compare, and export visual evidence

Usage:
  elle-snapshot capture-url --url <url> [options]
  elle-snapshot bundle-image --image <png> [--label <name>] [--output-dir <dir>]
  elle-snapshot compare --source <bundle> --target <bundle> [options]
  elle-snapshot figma-receive [--port <4317>] [--output-dir <dir>]

Capture options:
  --selector <css>           Repeat for multiple elements; captures the first match
  --match-size <bundle|png>  Use the first comparable asset's dimensions as viewport
  --viewport-width <px>     Override viewport width (default: 1440)
  --viewport-height <px>    Override viewport height (default: 1600)
  --viewport-only           Capture only the viewport, not the full document
  --wait-after-load-ms <ms>  Wait after load (default: 1200)
  --label <name>            Label the bundle
  --output-dir <dir>        Save artifacts here (use a new directory per run)

Compare options:
  --source-asset <key>      Exact asset key, label, or selector
  --target-asset <key>      Exact asset key, label, or selector
  --output-dir <dir>        Save diff.png and Markdown/JSON reports here
  --fail-on-diff            Exit 2 for needs-work/fail; default is report-only

Exit codes: 0 completed/pass, 1 input/runtime error, 2 comparison gate not passed.
Run --help with any command to show this help. PNG inputs only.
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    selector: { type: 'string', multiple: true },
    image: { type: 'string' },
    label: { type: 'string' },
    source: { type: 'string' },
    target: { type: 'string' },
    'source-asset': { type: 'string' },
    'target-asset': { type: 'string' },
    'match-size': { type: 'string' },
    'viewport-width': { type: 'string' },
    'viewport-height': { type: 'string' },
    'wait-after-load-ms': { type: 'string' },
    'full-page': { type: 'boolean' },
    'viewport-only': { type: 'boolean' },
    'fail-on-diff': { type: 'boolean' },
    port: { type: 'string' },
    'output-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const aliases = new Map([
  ['snapshot:capture-url', 'capture-url'],
  ['snapshot:bundle-image', 'bundle-image'],
  ['snapshot:compare', 'compare'],
  ['figma:receive', 'figma-receive'],
  ['receive-figma', 'figma-receive'],
]);

const command = aliases.get(positionals[0] ?? '') ?? positionals[0];

if (values.help || !command) {
  console.log(usage.trim());
  process.exit(0);
}

const relativePath = (path: string) => relative(process.cwd(), path) || '.';
const required = (value: string | undefined, label: string) => {
  if (!value) {
    throw new Error(`Missing required option: ${label}`);
  }
  return value;
};
const optionalNumber = (value: string | undefined, label: string) => {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Expected ${label} to be a number.`);
  }
  return number;
};
const selectors = (value: string[] | string | undefined) => {
  if (!value) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
};

const main = async () => {
  switch (command) {
    case 'capture-url': {
      if (values['full-page'] && values['viewport-only']) throw new Error('Choose --full-page or --viewport-only, not both.');
      const result = await captureUrlSnapshot({
        url: required(values.url, '--url'),
        label: values.label,
        selectors: selectors(values.selector),
        waitAfterLoadMs: optionalNumber(values['wait-after-load-ms'], '--wait-after-load-ms'),
        viewportWidth: optionalNumber(values['viewport-width'], '--viewport-width'),
        viewportHeight: optionalNumber(values['viewport-height'], '--viewport-height'),
        fullPage: values['viewport-only'] ? false : values['full-page'],
        outputDir: values['output-dir'],
        matchSizePath: values['match-size'],
      });
      console.log(`Snapshot bundle: ${relativePath(result.bundlePath)}`);
      console.log(`Assets: ${result.bundle.assets.filter((asset) => asset.matched).length}/${result.bundle.assets.length}`);
      console.log(`Viewport: ${result.bundle.viewport?.width}x${result.bundle.viewport?.height}`);
      const missing = result.bundle.assets.filter((asset) => !asset.matched);
      if (missing.length) throw new Error(missing.map((asset) => asset.warning).join('\n'));
      return;
    }
    case 'bundle-image': {
      const result = await bundleImageSnapshot({
        imagePath: required(values.image, '--image'),
        label: values.label,
        outputDir: values['output-dir'],
      });
      console.log(`Snapshot bundle: ${relativePath(result.bundlePath)}`);
      console.log(`Image: ${result.bundle.assets[0]?.width}x${result.bundle.assets[0]?.height}`);
      return;
    }
    case 'compare': {
      const result = await compareSnapshots({
        sourceCapturePath: required(values.source, '--source'),
        targetCapturePath: required(values.target, '--target'),
        sourceAsset: values['source-asset'],
        targetAsset: values['target-asset'],
        outputDir: values['output-dir'],
      });
      console.log(`Verdict: ${result.report.verdict}`);
      console.log(`Overall score: ${(result.report.metrics.overallScore * 100).toFixed(2)}%`);
      console.log(`Screenshot similarity: ${(result.report.metrics.screenshotSimilarity * 100).toFixed(2)}%`);
      console.log(`Report: ${relativePath(result.reportMarkdownPath)}`);
      console.log(`Diff: ${relativePath(result.diffImagePath)}`);
      if (values['fail-on-diff'] && result.report.verdict !== 'pass') process.exitCode = 2;
      return;
    }
    case 'figma-receive': {
      await startFigmaSnapshotReceiver({
        port: optionalNumber(values.port, '--port'),
        outputDir: values['output-dir'],
      });
      return;
    }
    default:
      console.log(usage.trim());
      throw new Error(`Unknown command: ${command}`);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
