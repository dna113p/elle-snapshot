# Contributing

Install using the README, then run `bun run validate`. Keep `bun.lock` committed;
use Bun 1.4.2 (the pinned version) for reproducible validation. No separate Node.js
runtime is needed. Run third-party CLIs with `bun run --bun` / `bun x --bun` so
Node shebangs do not silently select another runtime. `node:` imports and
`@types/node` describe compatibility APIs implemented by Bun, not a Node executable
dependency. After editing
the plugin's TypeScript, run `bun run figma:build` and include `figma-plugin/code.js`.

Add regression tests for behavior changes. Unit tests generate PNGs in temporary
directories; browser tests use inline HTML and require only local Chromium. Keep
private URLs, captured customer content, credentials and local machine paths out
of fixtures and documentation. Never commit `node_modules` or private/generated run
artifacts. The sanitized README images in `docs/images/` are an exception: regenerate
them with `bun run demo` when the bundled example changes.

For plugin changes, also manually import the manifest into Figma Desktop and verify
selection → export → receiver → portable bundle → comparison. Browser tests cannot
validate Figma's real plugin runtime or permissions.

In a PR, explain the behavior change, checks actually run, and any limitations.
For bugs, include runtime/OS versions and a minimal sanitized reproduction.
The public-release license decision must be completed before accepting external
contributions under an assumed open-source license.
