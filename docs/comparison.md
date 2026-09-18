# Comparison and bundle format

## Artifacts and paths

`capture.bundle.json` has `schemaVersion: 1`, provenance (`label`, `sourceType`,
`source`, `capturedAt`, optional viewport), and an `assets` array. Each asset has a
unique `key`, `label`, `matched`, and optional `screenshotPath`, `domPath`, dimensions,
selector and warning. Capture can record unmatched assets without a screenshot.

New on-disk `screenshotPath`, `domPath`, and `rootDomPath` fields are relative to the
bundle file. `outputDir` is `.`. File/Figma `source` points to the bundled image;
URL captures retain the original URL as provenance. Figma metadata artifact paths
are relative to the export directory. Path separators in generated artifact paths
are `/` on every platform. Legacy absolute paths are accepted unchanged.

Report artifact paths are relative to `compare.report.json` / `compare.report.md`.
Move the parent directory containing source, target, and comparison together to
preserve these links. Reports do not embed copies of the source and target images.

The internal TypeScript functions return absolute paths to newly created artifacts
for immediate use; portability rules above describe the serialized files.
Treat bundle files as trusted local input: legacy absolute and relative paths can
reference files outside the bundle. This is not an untrusted-file sandbox.

## Pixel comparison

The PNGs are placed at the top-left of a canvas sized to the maximum width and height.
Smaller images are padded transparently; no scaling, cropping, registration or
alignment is performed. PNGs and the combined comparison canvas are limited to
40 million pixels to bound memory usage.

Pixelmatch uses threshold `0.12`, default anti-alias detection, and diff alpha `0.7`.
Screenshot similarity is `1 - mismatchPixels / totalPixels`. It is not a perceptual
quality metric: a small but important defect can occupy very few pixels. Inspect
both input images and the diff even when the verdict passes.

## DOM and style evidence

Browser captures record a bounded DOM tree with text, rectangles, HTML snippets,
and selected computed styles. The page tree starts at `main` (or `body`), whereas
the page image captures the whole page. Evidence is limited to four descendant
levels and the first 12 children per page node / 10 per selector node. Hidden
nodes can appear in the evidence; shadow DOM and iframe traversal are not supported.

Tree comparison aligns flattened nodes by position, not semantic identity. A wrapper
change can therefore cause cascading mismatches. Text comparison normalizes whitespace
and accepts contained substrings. Computed styles use normalized string equality.
This is a heuristic, not accessibility, behavior, or layout-equivalence testing.

When **both** assets have DOM evidence, overall score is:

- 45% screenshot similarity
- 25% structure score
- 20% style score
- 10% text score

Otherwise overall score is screenshot similarity only. DOM sub-scores shown for
image-only comparisons are placeholders, not measured evidence. One-sided DOM
produces a warning but does not reduce the pixel-only overall score.

Figma `design-evidence.json` is for human/agent inspection. It is **not** converted
into a DOM tree or automatically compared with browser styles. Figma evidence also
has depth/child limits and is not a lossless export of the design document.

## Verdicts and automation

- **pass:** same image dimensions, overall score ≥ 0.90, screenshot similarity ≥ 0.92.
- **needs-work:** not pass, but overall score ≥ 0.72.
- **fail:** overall score < 0.72.

Thresholds are fixed in this preview. `--fail-on-diff` returns exit 2 for either
non-pass verdict; it is not a zero-tolerance pixel gate. Default comparisons exit
0 once reports are written, regardless of verdict. Runtime/input failures exit 1.

## Capture reproducibility

Capture uses a fresh headless Chromium context, waits for the page `load` event,
then waits 1200 ms by default. Screenshot animations are disabled. Explicit font,
network-idle, image, or application-ready conditions are not configurable yet.
There is no auth-state option, pre-capture interaction scripting, masking, device
emulation, or cross-browser matrix. Choose stable fixtures, match viewport/content,
and account for fonts, ads, video and other dynamic data during review.
