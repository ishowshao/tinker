# Release Process

Tinker uses Semantic Versioning. A release is identified by the same immutable
version in `package.json`, the Git tag, npm, and the GitHub Release.

## Prerequisites

- The release commit is on `main` and CI is green.
- `CHANGELOG.md` describes the user-visible changes.
- The version does not already exist on npm.
- npm Trusted Publishing authorizes `ishowshao/tinker` and the exact workflow
  filename `publish.yml` with the `npm-production` GitHub environment.

## Stable release

1. Update `package.json`, `CITATION.cff`, and `CHANGELOG.md` to the new version.
2. Run `bun install`, `bun run check`, and `bun run release:verify`.
3. Commit and push the release changes to `main`.
4. Create and push the matching tag, such as `v1.2.0`.
5. Monitor the `Publish npm package` workflow.
6. Verify the npm version, `latest` dist-tag, provenance, GitHub Release, and a
   clean registry installation.

The tag workflow fast-fails when the tag and package version differ. It publishes
through npm OIDC without a stored write token and creates the GitHub Release only
after npm accepts the package.

## Prerelease

Use versions such as `1.3.0-beta.1` or `1.3.0-rc.1` with matching `v` tags. The
workflow derives the npm dist-tag from the first prerelease identifier (`beta` or
`rc`) so a prerelease never replaces `latest`.

Published versions and release tags are immutable and must never be reused.
