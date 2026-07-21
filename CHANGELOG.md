# Changelog

All notable user-facing changes to Tinker are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-07-21

### Added

- Ship Bun 1.3.14 as an npm dependency and launch it through the installed `tinker`
  command, so users no longer need a system-wide Bun installation.
- License the project under Apache License 2.0 and preserve the original Infinite
  Context architecture attribution in `NOTICE`.
- Add CI, release-package verification, community health files, and an npm trusted
  publishing workflow with provenance.

### Changed

- Require Node.js 20 or later for the npm-installed launcher.
- Limit npm package contents to runtime source, license and attribution material,
  and required bundled dependencies.

## [1.1.0] - 2026-07-21

### Added

- First formal npm release under the `tinker-agent` package name with the `tinker`
  executable.

[Unreleased]: https://github.com/ishowshao/tinker/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/ishowshao/tinker/releases/tag/v1.2.0
[1.1.0]: https://www.npmjs.com/package/tinker-agent/v/1.1.0
