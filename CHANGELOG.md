# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-09-22

### Added

- `supernote_download_file` tool — download any file from the Supernote to the local filesystem via Browse & Access. Uses the existing internal `downloadFile()` function. Parameters: `path` (from `supernote_list_files`), optional `ip`, optional `out` (local save path, defaults to `$TMPDIR`).

## [0.2.2] - 2026-09-20

### Fixed

- Surface device errors over rediscovery; harden downloads and CI.
- Test isolation: inject LAN scanner into `captureFrame`, stop capture mock leaking into discover tests.

### Changed

- Clarified tool descriptions for both human and agent consumers.

## [0.2.0] - 2026-09-15

### Added

- `supernote_upload_file` tool — upload a local file to the Supernote via Browse & Access.
