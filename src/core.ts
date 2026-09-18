import { createServer, type ServerResponse } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import pixelmatch from 'pixelmatch';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { ensureDir, readJson, writeJson, writeText } from './fs.ts';
import { slugify } from './strings.ts';

const STYLE_KEYS = [
  'display',
  'position',
  'flexDirection',
  'flexWrap',
  'alignItems',
  'justifyContent',
  'gap',
  'rowGap',
  'columnGap',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'width',
  'height',
  'maxWidth',
  'minHeight',
  'backgroundColor',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textTransform',
  'borderRadius',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'boxShadow',
  'opacity',
  'overflow',
  'gridTemplateColumns',
] as const;

type StyleKey = (typeof STYLE_KEYS)[number];
type StyleMap = Record<StyleKey, string>;

export type SnapshotRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SnapshotNode = {
  path: string;
  tagName: string;
  id: string | null;
  className: string;
  text: string;
  styles: StyleMap;
  rect: SnapshotRect;
  childCount: number;
  children: SnapshotNode[];
  htmlSnippet: string;
};

export type SnapshotAsset = {
  key: string;
  label: string;
  sourceType: 'url' | 'file' | 'figma';
  selector?: string;
  matched: boolean;
  screenshotPath?: string;
  domPath?: string;
  rect?: SnapshotRect;
  width?: number;
  height?: number;
  textPreview?: string;
  warning?: string;
};

export type SnapshotBundle = {
  schemaVersion: 1;
  label: string;
  sourceType: 'url' | 'file' | 'figma';
  source: string;
  title?: string;
  capturedAt: string;
  viewport?: {
    width: number;
    height: number;
  };
  outputDir: string;
  rootDomPath?: string;
  assets: SnapshotAsset[];
  metadata?: Record<string, unknown>;
};

export type CompareIssue = {
  type: 'screenshot' | 'structure' | 'text' | 'style' | 'size' | 'missing';
  severity: 'high' | 'medium' | 'low';
  message: string;
  sourcePath?: string;
  targetPath?: string;
};

export type CompareReport = {
  generatedAt: string;
  sourceBundlePath: string;
  targetBundlePath: string;
  sourceAssetKey: string;
  targetAssetKey: string;
  sourceScreenshotPath: string;
  targetScreenshotPath: string;
  diffImagePath: string;
  metrics: {
    width: number;
    height: number;
    mismatchPixels: number;
    totalPixels: number;
    screenshotSimilarity: number;
    sourceNodeCount: number;
    targetNodeCount: number;
    tagMismatchCount: number;
    textMismatchCount: number;
    styleMismatchCount: number;
    styleComparisons: number;
    structureScore: number;
    textScore: number;
    styleScore: number;
    overallScore: number;
  };
  verdict: 'pass' | 'needs-work' | 'fail';
  issues: CompareIssue[];
};

export type CaptureUrlSnapshotOptions = {
  url: string;
  label?: string;
  selectors?: string[];
  waitAfterLoadMs?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  fullPage?: boolean;
  outputDir?: string;
  matchSizePath?: string;
};

export type BundleImageSnapshotOptions = {
  imagePath: string;
  label?: string;
  outputDir?: string;
  sourceType?: 'file' | 'figma';
  metadata?: Record<string, unknown>;
};

export type CompareSnapshotsOptions = {
  sourceCapturePath: string;
  targetCapturePath: string;
  sourceAsset?: string;
  targetAsset?: string;
  outputDir?: string;
};

export type FigmaReceiverOptions = {
  port?: number;
  outputDir?: string;
  token?: string;
};

const snapshotSlug = (value: string) => slugify(value).slice(0, 80) || 'snapshot';
const cwdRelative = (path: string) => relative(process.cwd(), path) || '.';
const normalizePathInput = (value: string) => (value.startsWith('@') ? value.slice(1) : value);
const normalizeWhitespace = (value: string | undefined | null) => (value ?? '').replace(/\s+/g, ' ').trim();
const truncateText = (value: string, max = 160) => (value.length <= max ? value : `${value.slice(0, max - 1)}...`);
const timestampSlug = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');
const clampScore = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

const resolveOutputDir = (provided: string | undefined, label: string) =>
  provided
    ? resolve(process.cwd(), normalizePathInput(provided))
    : resolve(process.cwd(), 'snapshots', `${timestampSlug()}-${snapshotSlug(label)}`);

// Bundle artifact paths are relative to capture.bundle.json. Keep accepting old
// absolute-path bundles, but do not silently rebase missing legacy files.
const portablePath = (base: string, path: string) => relative(base, path).split('\\').join('/') || '.';
const writeBundle = async (bundlePath: string, bundle: SnapshotBundle) => {
  const base = dirname(bundlePath);
  const artifact = (path?: string) => path ? portablePath(base, path) : undefined;
  await writeJson(bundlePath, {
    ...bundle,
    source: bundle.sourceType === 'url' ? bundle.source : artifact(bundle.assets[0]?.screenshotPath),
    outputDir: '.',
    rootDomPath: artifact(bundle.rootDomPath),
    assets: bundle.assets.map((asset) => ({
      ...asset, screenshotPath: artifact(asset.screenshotPath), domPath: artifact(asset.domPath),
    })),
  });
};

const loadBundle = async (path: string): Promise<SnapshotBundle> => {
  const bundle = await readJson<SnapshotBundle>(path);
  if (!bundle || bundle.schemaVersion !== 1 || !Array.isArray(bundle.assets) || typeof bundle.label !== 'string') {
    throw new Error(`Invalid or unsupported snapshot bundle: ${path}`);
  }
  const resolveArtifact = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value) throw new Error(`Invalid artifact path in ${path}`);
    return isAbsolute(value) ? value : resolve(dirname(path), value);
  };
  const keys = new Set<string>();
  return {
    ...bundle,
    assets: bundle.assets.map((asset) => {
      if (!asset || typeof asset.key !== 'string' || !asset.key || keys.has(asset.key) ||
          typeof asset.label !== 'string' || typeof asset.matched !== 'boolean' ||
          (asset.selector !== undefined && typeof asset.selector !== 'string')) {
        throw new Error(`Invalid or duplicate asset in ${path}`);
      }
      keys.add(asset.key);
      return {...asset, screenshotPath: resolveArtifact(asset.screenshotPath), domPath: resolveArtifact(asset.domPath)};
    }),
  };
};

const positiveInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
};

const decodePng = (bytes: Buffer) => {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Expected a PNG image.');
  }
  const pixels = bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (!pixels || pixels > 40_000_000) throw new Error('PNG must contain between 1 and 40 million pixels.');
  return PNG.sync.read(bytes);
};
const readPng = async (path: string) => decodePng(await readFile(path));
const pngDimensions = async (path: string) => {
  const png = await readPng(path);
  return { width: png.width, height: png.height };
};

const maybeBundleDimensions = async (path: string) => {
  const resolved = resolve(process.cwd(), normalizePathInput(path));
  if (extname(resolved).toLowerCase() === '.png') {
    return pngDimensions(resolved);
  }

  const bundle = await loadBundle(resolved);
  const asset = pickComparableAsset(bundle);
  return pngDimensions(asset.screenshotPath);
};

const createCanvasLike = (source: PNG, width: number, height: number) => {
  const canvas = new PNG({ width, height });
  PNG.bitblt(source, canvas, 0, 0, source.width, source.height, 0, 0);
  return canvas;
};

const flattenNodes = (node: SnapshotNode, items: SnapshotNode[] = []) => {
  items.push(node);
  for (const child of node.children) {
    flattenNodes(child, items);
  }
  return items;
};

const serializeNodeInPage = (styleKeys: readonly string[]) => {
  const normalize = (value: string | null | undefined) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();

  const serialize = (node: Element, path: string, depth: number): SnapshotNode => {
    const elementNode = node as HTMLElement;
    const computed = window.getComputedStyle(elementNode);
    const rect = elementNode.getBoundingClientRect();
    const styles = Object.fromEntries(styleKeys.map((key) => [key, normalize((computed as any)[key])])) as StyleMap;
    const children =
      depth > 0
        ? Array.from(elementNode.children)
            .slice(0, 12)
            .map((child, index) => serialize(child, `${path}.${index}`, depth - 1))
        : [];

    return {
      path,
      tagName: elementNode.tagName.toLowerCase(),
      id: elementNode.id || null,
      className: normalize(elementNode.className || ''),
      text: normalize((elementNode.innerText || elementNode.textContent || '').slice(0, 300)),
      styles,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      childCount: elementNode.children.length,
      children,
      htmlSnippet: normalize(elementNode.outerHTML.slice(0, 1200)),
    };
  };

  const root = document.querySelector('main') ?? document.body;
  return serialize(root, '0', 4);
};

const captureSelector = async (page: Page, selector: string, outDir: string, index: number): Promise<SnapshotAsset> => {
  const key = `selector-${index + 1}`;
  const slug = `${String(index + 1).padStart(2, '0')}-${snapshotSlug(selector)}`;
  const locator = page.locator(selector).first();
  const count = await locator.count();

  if (count === 0) {
    return {
      key,
      label: selector,
      sourceType: 'url',
      selector,
      matched: false,
      warning: `No element matched selector: ${selector}`,
    };
  }

  const screenshotPath = join(outDir, `${slug}.png`);
  await locator.screenshot({ path: screenshotPath, animations: 'disabled' });

  const dom = (await locator.evaluate(
    (element, styleKeys: string[]) => {
      const normalize = (value: string | null | undefined) =>
        String(value ?? '')
          .replace(/\s+/g, ' ')
          .trim();

      const serialize = (node: Element, path: string, depth: number): any => {
        const elementNode = node as HTMLElement;
        const computed = window.getComputedStyle(elementNode);
        const rect = elementNode.getBoundingClientRect();
        const styles = Object.fromEntries(styleKeys.map((key) => [key, normalize((computed as any)[key])]));
        const children =
          depth > 0
            ? Array.from(elementNode.children)
                .slice(0, 10)
                .map((child, childIndex) => serialize(child, `${path}.${childIndex}`, depth - 1))
            : [];

        return {
          path,
          tagName: elementNode.tagName.toLowerCase(),
          id: elementNode.id || null,
          className: normalize(elementNode.className || ''),
          text: normalize((elementNode.innerText || elementNode.textContent || '').slice(0, 240)),
          styles,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          childCount: elementNode.children.length,
          children,
          htmlSnippet: normalize(elementNode.outerHTML.slice(0, 1200)),
        };
      };

      return serialize(element, '0', 4);
    },
    [...STYLE_KEYS],
  )) as SnapshotNode;

  const domPath = join(outDir, `${slug}.json`);
  await writeJson(domPath, dom);
  const dimensions = await pngDimensions(screenshotPath);

  return {
    key,
    label: selector,
    sourceType: 'url',
    selector,
    matched: true,
    screenshotPath,
    domPath,
    rect: dom.rect,
    ...dimensions,
    textPreview: truncateText(dom.text, 120),
  };
};

export const captureUrlSnapshot = async (options: CaptureUrlSnapshotOptions) => {
  const label = options.label?.trim() || options.url;
  const matchedSize = options.matchSizePath ? await maybeBundleDimensions(options.matchSizePath) : undefined;
  const viewport = {
    width: positiveInteger(options.viewportWidth ?? matchedSize?.width ?? 1440, 'Viewport width'),
    height: positiveInteger(options.viewportHeight ?? matchedSize?.height ?? 1600, 'Viewport height'),
  };
  const outDir = resolveOutputDir(options.outputDir, label);
  await ensureDir(outDir);

  const waitMs = options.waitAfterLoadMs ?? 1200;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('Wait time must be nonnegative.');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(options.url, { waitUntil: 'load' });
    if ((options.waitAfterLoadMs ?? 1200) > 0) {
      await page.waitForTimeout(options.waitAfterLoadMs ?? 1200);
    }

    const pageScreenshotPath = join(outDir, 'page.png');
    await page.screenshot({ path: pageScreenshotPath, fullPage: options.fullPage ?? true, animations: 'disabled' });
    const pageDimensions = await pngDimensions(pageScreenshotPath);

    const rootDom = (await page.evaluate(serializeNodeInPage, [...STYLE_KEYS])) as SnapshotNode;
    const rootDomPath = join(outDir, 'page-root.json');
    await writeJson(rootDomPath, rootDom);

    const assets: SnapshotAsset[] = [
      {
        key: 'page',
        label: 'Full page',
        sourceType: 'url',
        matched: true,
        screenshotPath: pageScreenshotPath,
        domPath: rootDomPath,
        rect: rootDom.rect,
        ...pageDimensions,
        textPreview: truncateText(rootDom.text, 120),
      },
    ];

    for (const [index, selector] of (options.selectors ?? []).entries()) {
      assets.push(await captureSelector(page, selector, outDir, index));
    }

    const bundle: SnapshotBundle = {
      schemaVersion: 1,
      label,
      sourceType: 'url',
      source: options.url,
      title: await page.title(),
      capturedAt: new Date().toISOString(),
      viewport,
      outputDir: outDir,
      rootDomPath,
      assets,
      metadata: options.matchSizePath
        ? {
            matchedSizeFrom: basename(normalizePathInput(options.matchSizePath)),
            matchedSize,
          }
        : undefined,
    };

    const bundlePath = join(outDir, 'capture.bundle.json');
    await writeBundle(bundlePath, bundle);
    return { bundle, bundlePath };
  } finally {
    await browser.close();
  }
};

export const bundleImageSnapshot = async (options: BundleImageSnapshotOptions) => {
  const sourceImagePath = resolve(process.cwd(), normalizePathInput(options.imagePath));
  const label = options.label?.trim() || basename(sourceImagePath) || 'image';
  const outDir = resolveOutputDir(options.outputDir, label);
  await ensureDir(outDir);

  const dimensions = await pngDimensions(sourceImagePath);
  const screenshotPath = join(outDir, `${slugify(label).slice(0, 80) || 'image'}.png`);
  if (sourceImagePath !== screenshotPath) await copyFile(sourceImagePath, screenshotPath);
  const bundle: SnapshotBundle = {
    schemaVersion: 1,
    label,
    sourceType: options.sourceType ?? 'file',
    source: sourceImagePath,
    capturedAt: new Date().toISOString(),
    outputDir: outDir,
    assets: [
      {
        key: 'image',
        label,
        sourceType: options.sourceType ?? 'file',
        matched: true,
        screenshotPath,
        ...dimensions,
      },
    ],
    metadata: options.metadata,
  };

  const bundlePath = join(outDir, 'capture.bundle.json');
  await writeBundle(bundlePath, bundle);
  return { bundle, bundlePath };
};

const pickComparableAsset = (bundle: SnapshotBundle, preferred?: string) => {
  const hasPreference = preferred !== undefined;
  if (hasPreference && !preferred.trim()) throw new Error('Asset name must not be empty.');
  const matches = hasPreference
    ? bundle.assets.filter((item) => item.key === preferred || item.label === preferred || item.selector === preferred)
    : [];
  if (hasPreference && (matches.length !== 1 || !matches[0].matched || !matches[0].screenshotPath)) {
    throw new Error(`Asset "${preferred}" is missing, unmatched, or ambiguous in bundle "${bundle.label}". Available: ${bundle.assets.map((item) => item.key).join(', ')}`);
  }
  const chosen = hasPreference ? matches[0] : bundle.assets.find((item) => item.matched && item.screenshotPath);

  if (chosen?.screenshotPath) {
    return {
      key: chosen.key,
      label: chosen.label,
      selector: chosen.selector,
      screenshotPath: chosen.screenshotPath,
      domPath: chosen.domPath,
    };
  }

  throw new Error(`Bundle ${bundle.label} does not include any comparable screenshot assets.`);
};

const compareNodeTrees = (sourceRoot?: SnapshotNode, targetRoot?: SnapshotNode) => {
  if (!sourceRoot || !targetRoot) {
    return {
      sourceNodeCount: sourceRoot ? flattenNodes(sourceRoot).length : 0,
      targetNodeCount: targetRoot ? flattenNodes(targetRoot).length : 0,
      tagMismatchCount: 0,
      textMismatchCount: 0,
      styleMismatchCount: 0,
      styleComparisons: 0,
      structureScore: sourceRoot || targetRoot ? 0 : 1,
      textScore: sourceRoot || targetRoot ? 0 : 1,
      styleScore: sourceRoot || targetRoot ? 0 : 1,
      issues: sourceRoot || targetRoot
        ? [
            {
              type: 'missing' as const,
              severity: 'medium' as const,
              message: 'DOM/style evidence is only present on one side, so comparison falls back mostly to pixels.',
            },
          ]
        : [],
    };
  }

  const sourceNodes = flattenNodes(sourceRoot);
  const targetNodes = flattenNodes(targetRoot);
  const issues: CompareIssue[] = [];
  let tagMismatchCount = 0;
  let textMismatchCount = 0;
  let styleMismatchCount = 0;
  let styleComparisons = 0;
  let textComparisons = 0;

  const maxNodes = Math.max(sourceNodes.length, targetNodes.length);
  for (let index = 0; index < maxNodes; index += 1) {
    const source = sourceNodes[index];
    const target = targetNodes[index];

    if (!source || !target) {
      issues.push({
        type: 'missing',
        severity: 'high',
        message: !source
          ? `TARGET has extra node ${target?.tagName ?? 'unknown'} at flat index ${index}.`
          : `TARGET is missing SOURCE node ${source.tagName} at flat index ${index}.`,
        sourcePath: source?.path,
        targetPath: target?.path,
      });
      continue;
    }

    if (source.tagName !== target.tagName) {
      tagMismatchCount += 1;
      if (issues.length < 32) {
        issues.push({
          type: 'structure',
          severity: 'high',
          message: `Tag mismatch at ${source.path}: SOURCE ${source.tagName} vs TARGET ${target.tagName}.`,
          sourcePath: source.path,
          targetPath: target.path,
        });
      }
    }

    const sourceText = normalizeWhitespace(source.text);
    const targetText = normalizeWhitespace(target.text);
    if (sourceText || targetText) {
      textComparisons += 1;
      const textMatches =
        sourceText === targetText ||
        (sourceText.length > 0 && targetText.includes(sourceText)) ||
        (targetText.length > 0 && sourceText.includes(targetText));

      if (!textMatches) {
        textMismatchCount += 1;
        if (issues.length < 32) {
          issues.push({
            type: 'text',
            severity: 'medium',
            message: `Text mismatch at ${source.path}: SOURCE "${truncateText(sourceText, 80)}" vs TARGET "${truncateText(targetText, 80)}".`,
            sourcePath: source.path,
            targetPath: target.path,
          });
        }
      }
    }

    for (const key of STYLE_KEYS) {
      const sourceValue = normalizeWhitespace(source.styles[key]).toLowerCase();
      const targetValue = normalizeWhitespace(target.styles[key]).toLowerCase();
      if (!sourceValue && !targetValue) continue;
      styleComparisons += 1;
      if (sourceValue !== targetValue) {
        styleMismatchCount += 1;
        if (issues.length < 32) {
          issues.push({
            type: 'style',
            severity: ['fontSize', 'fontWeight', 'lineHeight', 'width', 'height', 'paddingTop', 'paddingBottom'].includes(key)
              ? 'high'
              : 'low',
            message: `Style mismatch at ${source.path} for ${key}: SOURCE "${source.styles[key]}" vs TARGET "${target.styles[key]}".`,
            sourcePath: source.path,
            targetPath: target.path,
          });
        }
      }
    }
  }

  const structurePenalty = tagMismatchCount + Math.abs(sourceNodes.length - targetNodes.length);
  return {
    sourceNodeCount: sourceNodes.length,
    targetNodeCount: targetNodes.length,
    tagMismatchCount,
    textMismatchCount,
    styleMismatchCount,
    styleComparisons,
    structureScore: clampScore(1 - structurePenalty / Math.max(sourceNodes.length, targetNodes.length, 1)),
    textScore: clampScore(1 - textMismatchCount / Math.max(textComparisons, 1)),
    styleScore: clampScore(1 - styleMismatchCount / Math.max(styleComparisons, 1)),
    issues,
  };
};

const renderReportMarkdown = (report: CompareReport) => {
  const lines: string[] = [];
  lines.push('# Snapshot Compare Report');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Source bundle: ${report.sourceBundlePath}`);
  lines.push(`- Target bundle: ${report.targetBundlePath}`);
  lines.push(`- Source asset: ${report.sourceAssetKey}`);
  lines.push(`- Target asset: ${report.targetAssetKey}`);
  lines.push(`- Verdict: ${report.verdict}`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push(`- Screenshot similarity: ${(report.metrics.screenshotSimilarity * 100).toFixed(2)}%`);
  lines.push(`- Overall score: ${(report.metrics.overallScore * 100).toFixed(2)}%`);
  lines.push(`- Structure score: ${(report.metrics.structureScore * 100).toFixed(2)}%`);
  lines.push(`- Text score: ${(report.metrics.textScore * 100).toFixed(2)}%`);
  lines.push(`- Style score: ${(report.metrics.styleScore * 100).toFixed(2)}%`);
  lines.push(`- Size compared: ${report.metrics.width}x${report.metrics.height}`);
  lines.push(`- Pixel mismatches: ${report.metrics.mismatchPixels} / ${report.metrics.totalPixels}`);
  lines.push(`- SOURCE node count: ${report.metrics.sourceNodeCount}`);
  lines.push(`- TARGET node count: ${report.metrics.targetNodeCount}`);
  lines.push(`- Tag mismatches: ${report.metrics.tagMismatchCount}`);
  lines.push(`- Text mismatches: ${report.metrics.textMismatchCount}`);
  lines.push(`- Style mismatches: ${report.metrics.styleMismatchCount} / ${report.metrics.styleComparisons}`);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- SOURCE screenshot: ${report.sourceScreenshotPath}`);
  lines.push(`- TARGET screenshot: ${report.targetScreenshotPath}`);
  lines.push(`- Diff image: ${report.diffImagePath}`);
  lines.push('');
  lines.push('## Top issues');
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('- No obvious mismatches detected by the automated comparison.');
  } else {
    for (const issue of report.issues.slice(0, 24)) {
      lines.push(`- [${issue.severity}] ${issue.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

export const compareSnapshots = async (options: CompareSnapshotsOptions) => {
  const sourceCapturePath = resolve(process.cwd(), normalizePathInput(options.sourceCapturePath));
  const targetCapturePath = resolve(process.cwd(), normalizePathInput(options.targetCapturePath));
  const sourceBundle = await loadBundle(sourceCapturePath);
  const targetBundle = await loadBundle(targetCapturePath);
  const sourceAsset = pickComparableAsset(sourceBundle, options.sourceAsset);
  const targetAsset = pickComparableAsset(targetBundle, options.targetAsset);
  const outputDir = options.outputDir
    ? resolve(process.cwd(), normalizePathInput(options.outputDir))
    : resolve(dirname(targetCapturePath), '..', 'comparisons', `${snapshotSlug(sourceBundle.label)}-vs-${snapshotSlug(targetBundle.label)}-${timestampSlug()}`);
  await ensureDir(outputDir);

  const [sourcePng, targetPng, sourceDom, targetDom] = await Promise.all([
    readPng(sourceAsset.screenshotPath),
    readPng(targetAsset.screenshotPath),
    sourceAsset.domPath ? readJson<SnapshotNode>(sourceAsset.domPath) : Promise.resolve(undefined),
    targetAsset.domPath ? readJson<SnapshotNode>(targetAsset.domPath) : Promise.resolve(undefined),
  ]);

  const width = Math.max(sourcePng.width, targetPng.width);
  const height = Math.max(sourcePng.height, targetPng.height);
  if (width * height > 40_000_000) throw new Error('Combined comparison canvas exceeds 40 million pixels.');
  const sourceCanvas = createCanvasLike(sourcePng, width, height);
  const targetCanvas = createCanvasLike(targetPng, width, height);
  const diffImage = new PNG({ width, height });
  const mismatchPixels = pixelmatch(sourceCanvas.data, targetCanvas.data, diffImage.data, width, height, {
    threshold: 0.12,
    alpha: 0.7,
  });
  const diffImagePath = join(outputDir, 'diff.png');
  await ensureDir(outputDir);
  await writeFile(diffImagePath, PNG.sync.write(diffImage));

  const domComparison = compareNodeTrees(sourceDom, targetDom);
  const totalPixels = width * height;
  const screenshotSimilarity = clampScore(1 - mismatchPixels / Math.max(totalPixels, 1));
  const hasDomEvidence = Boolean(sourceDom && targetDom);
  const overallScore = hasDomEvidence
    ? clampScore(
        screenshotSimilarity * 0.45 +
          domComparison.structureScore * 0.25 +
          domComparison.styleScore * 0.2 +
          domComparison.textScore * 0.1,
      )
    : screenshotSimilarity;

  const sizeIssues: CompareIssue[] = [];
  if (sourcePng.width !== targetPng.width || sourcePng.height !== targetPng.height) {
    sizeIssues.push({
      type: 'size',
      severity: 'medium',
      message: `Screenshot size mismatch: SOURCE ${sourcePng.width}x${sourcePng.height} vs TARGET ${targetPng.width}x${targetPng.height}.`,
    });
  }

  const pixelIssues: CompareIssue[] = mismatchPixels > 0 ? [{
    type: 'screenshot', severity: screenshotSimilarity < 0.92 ? 'high' : 'low',
    message: `${mismatchPixels} pixels differ (${((1 - screenshotSimilarity) * 100).toFixed(2)}%). Inspect diff.png; scores are advisory.`,
  }] : [];
  const issues = [...sizeIssues, ...pixelIssues, ...domComparison.issues];
  const verdict: CompareReport['verdict'] =
    sizeIssues.length === 0 && overallScore >= 0.9 && screenshotSimilarity >= 0.92 ? 'pass' : overallScore >= 0.72 ? 'needs-work' : 'fail';

  const report: CompareReport = {
    generatedAt: new Date().toISOString(),
    sourceBundlePath: portablePath(outputDir, sourceCapturePath),
    targetBundlePath: portablePath(outputDir, targetCapturePath),
    sourceAssetKey: sourceAsset.selector ? `${sourceAsset.key} (${sourceAsset.selector})` : sourceAsset.key,
    targetAssetKey: targetAsset.selector ? `${targetAsset.key} (${targetAsset.selector})` : targetAsset.key,
    sourceScreenshotPath: portablePath(outputDir, sourceAsset.screenshotPath),
    targetScreenshotPath: portablePath(outputDir, targetAsset.screenshotPath),
    diffImagePath: basename(diffImagePath),
    metrics: {
      width,
      height,
      mismatchPixels,
      totalPixels,
      screenshotSimilarity,
      sourceNodeCount: domComparison.sourceNodeCount,
      targetNodeCount: domComparison.targetNodeCount,
      tagMismatchCount: domComparison.tagMismatchCount,
      textMismatchCount: domComparison.textMismatchCount,
      styleMismatchCount: domComparison.styleMismatchCount,
      styleComparisons: domComparison.styleComparisons,
      structureScore: domComparison.structureScore,
      textScore: domComparison.textScore,
      styleScore: domComparison.styleScore,
      overallScore,
    },
    verdict,
    issues,
  };

  const reportJsonPath = join(outputDir, 'compare.report.json');
  const reportMarkdownPath = join(outputDir, 'compare.report.md');
  await Promise.all([writeJson(reportJsonPath, report), writeText(reportMarkdownPath, renderReportMarkdown(report))]);
  return { report, reportJsonPath, reportMarkdownPath, diffImagePath };
};

export const startFigmaSnapshotReceiver = async ({ port = 4317, outputDir = 'snapshots/figma-selection', token = randomBytes(24).toString('hex') }: FigmaReceiverOptions = {}) => {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  if (token.length < 16) throw new Error('Receiver token must be at least 16 characters.');
  const outDir = resolve(process.cwd(), outputDir);
  await ensureDir(outDir);
  const maxBodyBytes = 20 * 1024 * 1024;

  const sendJson = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(data, null, 2));
  };

  const server = createServer(async (req, res) => {
    if (req.url !== '/figma-selection') {
      sendJson(res, 404, { error: 'Use POST /figma-selection' });
      return;
    }
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST /figma-selection' });
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      sendJson(res, 401, { error: 'Paste the receiver token into the Figma plugin.' });
      req.resume();
      return;
    }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, { error: 'Expected application/json' });
      req.resume();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          sendJson(res, 413, { error: 'Export exceeds the 20 MiB request limit. Select a smaller node.' });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let payload;
      let png: Buffer;
      let dimensions: { width: number; height: number };
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!payload?.selection || typeof payload.selection.name !== 'string' ||
            payload.image?.format !== 'png' || typeof payload.image.base64 !== 'string' ||
            !payload.image.base64 || (payload.exportName !== undefined && typeof payload.exportName !== 'string')) {
          throw new Error('Expected { selection: { name }, image: { format: "png", base64 } }');
        }
        png = Buffer.from(payload.image.base64, 'base64');
        const decoded = decodePng(png);
        dimensions = { width: decoded.width, height: decoded.height };
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const { selection, image } = payload;
      const displayName = (payload.exportName || selection.name || 'selection').trim() || 'selection';
      const baseName = slugify(displayName).slice(0, 80) || 'selection';
      // mkdir is exclusive, so concurrent exports never overwrite one another.
      let safeName = baseName;
      let exportDir = join(outDir, safeName);
      for (let suffix = 2; ; suffix += 1) {
        try { await mkdir(exportDir); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          safeName = `${baseName}-${suffix}`;
          exportDir = join(outDir, safeName);
        }
      }
      const pngPath = join(exportDir, `${safeName}.png`);
      const metadataPath = join(exportDir, 'metadata.json');
      const designEvidencePath = payload.designEvidence ? join(exportDir, 'design-evidence.json') : undefined;
      const bundlePath = join(exportDir, 'capture.bundle.json');
      const metadata = {
        receivedAt: new Date().toISOString(), displayName, exportName: displayName,
        filesystemName: safeName, originalName: selection.name, selection,
        context: payload.context ?? { text: '' },
        image: { format: image.format, scale: image.scale ?? 1 },
        pngPath: basename(pngPath),
        designEvidencePath: designEvidencePath ? basename(designEvidencePath) : undefined,
        designEvidenceReceived: Boolean(payload.designEvidence),
      };
      await writeFile(pngPath, png);
      await writeJson(metadataPath, metadata);
      if (designEvidencePath) await writeJson(designEvidencePath, payload.designEvidence);
      const bundle: SnapshotBundle = {
        schemaVersion: 1, label: displayName, sourceType: 'figma', source: pngPath,
        capturedAt: new Date().toISOString(), outputDir: exportDir,
        assets: [{ key: 'image', label: displayName, sourceType: 'figma', matched: true, screenshotPath: pngPath, ...dimensions }],
        metadata,
      };
      await writeBundle(bundlePath, bundle);
      console.log(`[figma] ${displayName} → ${cwdRelative(bundlePath)}`);
      sendJson(res, 200, {
        ok: true, exportName: displayName, filesystemName: safeName,
        hasDesignEvidence: Boolean(payload.designEvidence), pngPath, metadataPath, designEvidencePath, bundlePath,
      });
    } catch (error) {
      console.error('Figma export failed:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Could not save export. Check the receiver terminal.' });
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Elle Snapshot Figma receiver: http://127.0.0.1:${actualPort}/figma-selection`);
  console.log(`Receiver token (paste into plugin): ${token}`);
  console.log(`Writing exports to ${outDir}. Keep this terminal open; Ctrl+C stops the receiver.`);
  return server;
};
