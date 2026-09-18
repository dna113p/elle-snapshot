# Public release checklist

This source tree is prepared for a GitHub-first preview, not npm publication.
The following owner decisions and live checks must precede the first public release:

- [ ] Confirm the right to publish all source and choose an open-source license.
      Add `LICENSE`, replace `UNLICENSED` in `package.json`, and update the README.
- [ ] Choose the GitHub owner/repository and add its URL to `package.json` metadata.
- [ ] Review `git status --short` and `git ls-files --others --exclude-standard`;
      exclude private captures, personal setup files, secrets and dependency folders.
- [ ] Run a fresh `bun install --frozen-lockfile`, install Chromium, then
      `bun run validate` using only release files in a clean directory.
- [ ] Import the development plugin in Figma Desktop; check its token field, export,
      error state, metadata and resulting comparison against a browser capture.
- [ ] Create the repository, enable private vulnerability reporting, and push source.
- [ ] Confirm the GitHub CI matrix passes before tagging `v0.1.0`.

`private: true` is deliberate and can remain for a public GitHub repository. Publishing
to npm is a separate decision requiring license/package metadata and package-content
review. There are no credentials or automated publishing steps in CI.
