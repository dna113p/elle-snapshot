# Security and privacy

Elle Snapshot is a local developer utility, not a hosted service or a sandbox for
untrusted images, bundles, HTML, or design exports.

- Only capture pages and inspect bundle files you trust. Chromium loads page scripts
  and network resources normally. Bundle paths may reference other local files.
- Screenshots, DOM text/snippets, page URLs, and Figma metadata may contain sensitive
  information. There is no automatic redaction. Review artifacts before publishing.
- The Figma receiver binds to IPv4 loopback, requires a random per-start bearer token,
  caps request bodies at 20 MiB, and validates PNG input before saving. A permissive
  CORS response supports the Figma iframe; authentication still applies to POSTs.
- Treat receiver tokens as temporary secrets. Do not commit them or include terminal
  screenshots containing them in issues. Stop the receiver when finished; do not
  put it behind a tunnel, public reverse proxy, or shared server.
- PNG decoding/comparison is capped at 40 million pixels. This reduces accidental
  resource exhaustion but does not make untrusted binary input safe.

For a vulnerability, use this repository's private GitHub vulnerability-reporting
channel once the maintainer enables it. If unavailable, contact the repository owner
privately through their published profile contact. Do not post exploit details,
credentials, or private captures in a public issue.
