# Tinker Release Guide

This document defines the official Tinker release process adopted with version
`1.2.0`. Its purpose is to make every npm release traceable to a unique Git tag,
GitHub Actions run, GitHub Release, and npm provenance statement.

Official releases are triggered only by pushing a version tag, through
`.github/workflows/publish.yml`. Do not run `npm publish` locally, and do not
configure a long-lived npm token for the publishing workflow.

## Release Chain

Every official release must form the following immutable chain:

```text
release commit on main
  -> vX.Y.Z Git tag
  -> GitHub Actions publishing run
  -> tinker-agent@X.Y.Z
  -> npm provenance
  -> GitHub Release vX.Y.Z
```

The version must be identical in all four locations:

- `version` in `package.json`
- Git tag `vX.Y.Z`
- npm package version `tinker-agent@X.Y.Z`
- GitHub Release `vX.Y.Z`

The publishing workflow checks that the Git tag and the version in
`package.json` match, and fails immediately if they do not.

## Choosing a Version Number

Tinker follows Semantic Versioning in the form `MAJOR.MINOR.PATCH`:

- `PATCH`: backward-compatible bug fixes and small internal improvements, such
  as `1.2.0 -> 1.2.1`.
- `MINOR`: backward-compatible new features, such as `1.2.1 -> 1.3.0`.
- `MAJOR`: breaking changes that require users to adjust configuration,
  commands, persisted data, or integrations, such as `1.9.0 -> 2.0.0`.

If it is unclear whether a change breaks compatibility, explicitly check the
following before release:

- Have any CLI commands or arguments changed?
- Have any configuration files, environment variables, or default behaviors
  changed?
- Can older versions no longer use the current session data or protocol?
- Have any tools, MCP contracts, or public TypeScript interfaces been removed or
  changed semantically?

Use a prerelease version when users should test a release before it becomes
stable:

- `1.3.0-beta.1`, `1.3.0-beta.2`
- `1.3.0-rc.1`

Prereleases are published under the corresponding npm `beta` or `rc` dist-tag
and never replace `latest`. To promote a prerelease to stable, publish a new
`1.3.0` release; do not treat `1.3.0-rc.1` itself as the stable release.

## Prerequisites

Before starting a release, confirm that:

- All intended changes have reached `main`.
- The local worktree has no uncommitted changes.
- The Linux and macOS CI jobs for `main` are green.
- `CHANGELOG.md` describes all user-visible changes.
- The intended version does not already exist on npm.
- The npm Trusted Publisher still authorizes:
  - GitHub repository: `ishowshao/tinker`
  - Workflow: `publish.yml`
  - GitHub Environment: `npm-production`

If the repository name, GitHub organization, workflow filename, or environment
name changes, update the npm Trusted Publisher first. Otherwise, OIDC publishing
will fail.

## Step 1: Prepare the Release Commit

Assume that the next release is `1.3.0`. Update the following files:

1. Change `version` in `package.json` to `1.3.0`.
2. Update `version` and `date-released` in `CITATION.cff`.
3. In `CHANGELOG.md`:
   - Move completed entries from `Unreleased` into
     `## [1.3.0] - YYYY-MM-DD`.
   - Organize changes under categories such as `Added`, `Changed`, `Fixed`, and
     `Removed`.
   - Update the starting tag in the `Unreleased` comparison link to `v1.3.0`.
   - Add the GitHub Release link for `1.3.0`.

Do not use a raw list of internal refactors as release notes. The changelog
should explain what users gain, how behavior changes, and whether users must take
any action.

Update dependencies and the lockfile, then run the complete release checks:

```bash
bun install
bun run check
bun run release:verify
git diff --check
```

`release:verify` checks the actual npm tarball, the globally installed `tinker`
command, bundled Bun, bundled ripgrep, license metadata, and required bundled
dependency patches.

Review the change scope, then commit and push it:

```bash
git status --short
git diff
git add package.json bun.lock CITATION.cff CHANGELOG.md
git commit -m "release: prepare v1.3.0"
git push origin main
```

If the release contains additional code or documentation, include all files
required by the release commit. Do not mechanically copy the example `git add`
file list.

## Step 2: Wait for Main Branch CI

After pushing, wait for the `CI` workflow to finish. It runs
`bun install --frozen-lockfile` and `bun run check` independently on these
GitHub-hosted environments:

- `ubuntu-latest`
- `macos-latest`

Use the GitHub CLI to monitor the run:

```bash
gh run list --workflow CI --branch main --limit 3
gh run watch <run-id> --exit-status
```

Do not create a release tag if either platform fails. Fix the problem, push a new
commit, and wait for the new CI run to become fully green.

## Step 3: Perform the Final Pre-Publishing Audit

Before creating the tag, verify the exact commit, worktree, Git tags, and npm
registry state:

```bash
git status --porcelain=v1
git rev-parse HEAD
git tag --list v1.3.0
git ls-remote --tags origin refs/tags/v1.3.0
npm view tinker-agent@1.3.0 version --json
```

Expected results:

- `git status` produces no output.
- No matching tag exists locally or remotely.
- The npm query reports that the version does not exist. Confirm that the result
  is a missing version rather than a network or permission error.

## Step 4: Create and Push the Tag

Create an annotated tag for the exact commit that passed CI:

```bash
git tag -a v1.3.0 -m "Tinker 1.3.0" <release-commit-sha>
git show --no-patch --format=fuller v1.3.0
git push origin v1.3.0
```

Pushing a `v*` tag triggers the `Publish npm package` workflow. The workflow:

1. Verifies that the Git tag matches the version in `package.json`.
2. Installs dependencies from the frozen lockfile.
3. Runs the complete quality gate again.
4. Verifies the actual publishing tarball and a temporary global installation.
5. Publishes through npm Trusted Publishing/OIDC and generates provenance.
6. After npm accepts the package, extracts the release notes from `CHANGELOG.md`
   and creates the GitHub Release.

Monitor the publishing run:

```bash
gh run list --workflow "Publish npm package" --limit 3
gh run watch <run-id> --exit-status
```

## Step 5: Verify the Published Release

A green workflow alone is not sufficient. At minimum, verify the public registry
and GitHub state:

```bash
npm view tinker-agent@1.3.0 \
  name version dist-tags bin engines license repository \
  dist.integrity dist.tarball dist.attestations --json

npm view tinker-agent dist-tags --json
gh release view v1.3.0
```

A stable release must satisfy all of the following:

- `version` is the intended release version.
- `dist-tags.latest` points to the intended release version.
- `bin` exposes only the expected `tinker` command.
- `license` is `Apache-2.0`.
- `dist.attestations.provenance` is present.
- The GitHub Release is neither a draft nor a prerelease.

Finally, install the package from the public registry into a clean prefix instead
of reusing the repository's `node_modules`:

```bash
release_tmp=$(mktemp -d)
npm install --global --prefix "$release_tmp" tinker-agent@1.3.0
test -x "$release_tmp/bin/tinker"
"$release_tmp/bin/tinker"
```

Confirm manually that the TUI starts, then exit and clean up:

```bash
rm -r "$release_tmp"
```

To verify the no-system-Bun and no-system-ripgrep scenario, expose only Node.js
to the test process and confirm that `tinker` still uses the bundled Bun and
ripgrep executables. The repository's `bun run release:verify` command already
covers this scenario automatically.

## Prerelease Process

Prereleases use the same process, but the version and tag include a prerelease
identifier. For example:

```text
package.json: 1.3.0-beta.1
Git tag:      v1.3.0-beta.1
npm package:  tinker-agent@1.3.0-beta.1
npm dist-tag: beta
```

The workflow derives the npm dist-tag from the first prerelease identifier:

- `1.3.0-beta.1` -> `beta`
- `1.3.0-rc.1` -> `rc`

When verifying a prerelease, do not expect `latest` to change, and confirm that
the GitHub Release is marked as a prerelease.

## Handling Release Failures

### Failure After Tag Push but Before npm Publishing

First determine whether the failure can be fixed without changing the tagged
source:

- npm Trusted Publisher, GitHub environment, or temporary service failure: fix
  the external configuration and rerun the same workflow.
- Source, version, changelog, dependency, or workflow defect: do not move or
  reuse the pushed tag. Fix the problem and repeat the complete process with a
  new version number.

### npm Succeeds but GitHub Release Creation Fails

Do not publish the npm package again. Preserve the original tag and npm version,
then rerun the failed Release job or create the missing GitHub Release from the
same tag and changelog entry.

### A Defect Is Found After Publishing

- Do not overwrite, delete, or reuse the published version or Git tag.
- For an ordinary defect, fix it and publish a new PATCH version.
- If a release should no longer be installed, mark it as deprecated on npm and
  publish a corrected version as soon as possible.
- Consider `npm unpublish` only for a clear security or legal requirement, and
  record the decision and its impact separately.

## Immutable Rules

- Do not run `npm publish` locally.
- Do not store a long-lived npm write token in the publishing workflow.
- Do not create a release tag while CI is failing.
- Do not move, overwrite, or reuse a version tag after pushing it.
- Do not overwrite or reuse a published npm version.
- Do not allow a prerelease to replace the npm `latest` dist-tag.
- Do not create the official GitHub Release before npm publishing succeeds.

## Release Completion Checklist

- [ ] The version follows Semantic Versioning.
- [ ] `package.json`, `CITATION.cff`, and `CHANGELOG.md` are updated.
- [ ] `bun run check` passes.
- [ ] `bun run release:verify` passes.
- [ ] The release commit is on `main`, with green Linux and macOS CI jobs.
- [ ] The intended version does not already exist on npm.
- [ ] The annotated tag points to the exact release commit.
- [ ] The `Publish npm package` workflow is green.
- [ ] The npm dist-tag, integrity, and provenance are verified.
- [ ] The GitHub Release exists with the correct state.
- [ ] A clean installation from the public registry has been verified.
- [ ] The local worktree remains clean.
