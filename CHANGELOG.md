# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-06-03

Maintenance release. No functional change for `npx`/registry users — but this is the
**first standalone-binary build to carry the 0.2.1 device-error and download fixes**,
because the v0.2.1 binary release was blocked by a CI failure (see below).

### Fixed

- CI test suite no longer fails or hangs depending on test-file load order. Bun's
  `mock.module` is process-global, so `capture.test.ts` mocking `discover.js` leaked a
  stub into `discover.test.ts`. The LAN scanner is now injected into `captureFrame`
  (an optional `scan` seam, mirroring the existing `probe`/`render` injection) instead
  of being mocked at the module level. Runtime behaviour is unchanged — production
  callers never set `scan`.

## [0.2.1] - 2026-06-02

### Changed

- Clarified every tool's description so both humans and coding agents can tell *when*
  and *why* to reach for each one, and added server-level `instructions` that route
  intent to the right tool.

### Fixed

- Surface a device's own error instead of silently re-discovering: an operational
  failure from a host that answered (HTTP error, wrong path, parse failure) now
  propagates as-is, rather than triggering a wasteful LAN scan that masks the real
  problem. Only genuine reachability failures fall back to discovery.
- Hardened file downloads with a 100 MB size cap (rejected early via `Content-Length`
  and enforced mid-stream) and a whole-operation timeout that also bounds body reads.
- A non-idempotent upload is never replayed against a rediscovered device after a
  timeout, since the original write may already have applied.

> Note: the standalone binaries for this version were not published (a CI failure
> blocked the release build); they ship for the first time in 0.2.2.

## [0.2.0] - 2026-06-02

### Added

- **Browse & Access** support (the device's built-in HTTP file server, port 8089) as a
  family of focused tools:
  - `supernote_list_files` — list folders and files on the device.
  - `supernote_read_note` — extract recognized handwriting/text from a `.note` file.
  - `supernote_render_note` — render selected (or all) note pages to PNG images.
  - `supernote_upload_file` — upload a local file to the device (the only mutating tool).
- LAN discovery generalized so it can find the device by its Browse & Access listing
  endpoint (port 8089), not just the screen mirror (port 8080) — the two are separate
  toggles on the device.
- A prominent **unofficial-project disclaimer**: not affiliated with or endorsed by
  Ratta / Supernote; relies on reverse-engineered, undocumented LAN interfaces.

### Changed

- Extracted shared device-address resolution (configured address → LAN-scan fallback)
  so the screen-mirror and Browse & Access clients share one code path.

## [0.1.1] - 2026-06-02

### Added

- MCP registry metadata (`server.json`) so the server can be listed in the
  [MCP registry](https://registry.modelcontextprotocol.io).

## [0.1.0] - 2026-06-02

### Added

- Initial release: `supernote_snapshot` captures a single frame of the Supernote's live
  screen mirror (port 8080) as image input for AI agents.
- Lazy device-address resolution: explicit `ip` argument → `SUPERNOTE_IP` env var →
  optional LAN scan, with actionable errors when the device can't be reached.
- Distribution via `npx`/`bunx` (self-contained `dist/server.js`) and cross-compiled
  standalone binaries attached to GitHub Releases on each version tag.

[Unreleased]: https://github.com/ridget/supernote-mcp/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/ridget/supernote-mcp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ridget/supernote-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ridget/supernote-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ridget/supernote-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ridget/supernote-mcp/releases/tag/v0.1.0
