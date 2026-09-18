---
name: elle-snapshot
description: Capture browser pages or components, import PNG or Figma references, and compare visual snapshots with the Elle Snapshot CLI. Use for screenshot regression checks, design matching, visual bug verification, or a capture–compare–inspect–adjust feedback loop.
---

# Elle Snapshot

Use the existing `elle-snapshot` CLI to produce inspectable visual evidence. This
skill contains instructions only; the CLI, Bun, and Playwright Chromium must be
installed separately. It is independent of any particular application or agent.

## Prepare the check

1. Run `elle-snapshot --help`. If unavailable but the source checkout is known, use
   `node /path/to/elle-snapshot/bin/elle-snapshot.js` instead. In that checkout,
   dependencies install with `bun install --frozen-lockfile` and Chromium with
   `bun x playwright install chromium`. Use an approved checkout; do not substitute
   a different package with the same name.
2. Establish the reference: approved PNG, Figma export, or before-change capture.
   A before-change baseline tests regression, not design compliance. Preserve it.
3. Record the actual application URL, selector, viewport, state and branch/worktree.
   Verify that the server is rendering the intended code, including server-side
   templates where applicable. Use matching content, flags and viewport each time.
4. Choose a fresh output directory for each capture/comparison. Commands below use
   example paths and selectors: replace them with the intended page and component.

## Capture and compare

Import a reference PNG (skip this step if you already have its bundle):

```bash
elle-snapshot bundle-image --image reference.png --label reference \
  --output-dir .snapshots/reference
```

Capture the current component:

```bash
elle-snapshot capture-url --url http://localhost:5173 \
  --selector '#app' --viewport-width 1440 --viewport-height 900 \
  --output-dir .snapshots/iteration-01/current
```

Inspect `capture.bundle.json` and its screenshot. Confirm the intended element
matched and is visible—not a login screen, loading state, or the wrong instance.
Capture records `page`, then `selector-1`, `selector-2`, etc. for repeated selectors;
each selector captures only its first match. Missing selectors make the CLI exit 1.

```bash
elle-snapshot compare \
  --source .snapshots/reference/capture.bundle.json \
  --target .snapshots/iteration-01/current/capture.bundle.json \
  --source-asset image --target-asset selector-1 \
  --output-dir .snapshots/iteration-01/comparison
```

For browser-to-browser regression checks, capture the baseline using the same URL,
selector and viewport before changing the application. Select `selector-1` on
**both** sides instead of `image`. Always choose explicit asset keys; unknown,
empty, unmatched or ambiguous asset arguments are errors.

## Inspect → adjust → recapture

Read `compare.report.md`, then visually inspect **both input images and `diff.png`**.
Fix the largest relevant unintended discrepancy first, capture into a new iteration
directory, and compare again. A numeric pass or successful build does not establish
visual correctness. Preserve previous evidence so the improvement is inspectable.

Report the reference/capture/report paths, what matches, intentional differences,
and unresolved checks. For interaction bugs, separately check keyboard, focus,
lifecycle or other relevant behavior; screenshots do not prove functionality.
If image inspection, authentication or the live environment is unavailable, state
that verification is blocked instead of claiming the UI matches.

## Figma references

If given an existing Figma export, keep its PNG, `metadata.json`,
`design-evidence.json`, and `capture.bundle.json` together. Read the design evidence
before estimating dimensions or typography from the image. Compare the bundle's
`image` asset with the matching browser selector.

For a new export, the human must have Figma Desktop and the development plugin:

1. From the Elle Snapshot **source checkout**, run `bun run figma:build`, then import
   `figma-plugin/manifest.json` in Figma's development-plugin menu.
2. From the application directory, run
   `elle-snapshot figma-receive --output-dir .snapshots/figma`.
3. Paste the token printed by the running receiver into the plugin. Select one node
   and click **Send selection**. Verify that a bundle and design evidence were saved.
4. Stop the receiver when finished. Keep the token out of logs shared with others.

The supplied plugin uses `127.0.0.1:4317`. The token changes on receiver restart and
is not saved by the plugin. Figma design evidence is for inspection; the comparator
does not automatically match it against browser styles.

## Interpretation and guardrails

- `--match-size` changes the **browser viewport**, not the component's dimensions.
  For a cropped design, set the intended page viewport explicitly. Bundle size
  matching uses its first comparable asset, usually the full-page screenshot.
- `--viewport-only` limits the page capture; full-page is the default.
  `--wait-after-load-ms` controls a fixed delay after load (default 1200 ms).
- Comparison is report-only by default. With `--fail-on-diff`, exit 0 means pass,
  2 means needs-work/fail, and 1 means input/runtime error. This is a threshold gate,
  **not exact pixel equality**. Dimensions must match for a pass; thresholds are fixed.
- PNG is the only supported image format. Images are top-left aligned and padded,
  not automatically resized or registered. DOM comparisons use bounded trees and
  positional heuristics; do not treat their scores as semantic equivalence.
- There is no auth-state option, interaction scripting, masking, or configurable
  app-ready wait. Stabilize fonts, data, animation, ads and video where possible;
  record unavoidable variability rather than blaming the implementation.
- Share whole capture directories. New artifact paths are relative; old absolute
  bundles require recapture/import for portable sharing. Preserve the surrounding
  directory layout when sharing comparison reports and their source images.
- Use trusted local bundles and pages. Artifacts may include private text, DOM,
  URLs and design details; inspect before sharing and keep them out of public Git.
