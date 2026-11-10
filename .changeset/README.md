# Changesets

Every change that consumers will notice gets a changeset: a small markdown file
describing the change and the bump it deserves.

```bash
bun run changeset    # pick patch / minor / major, write one sentence
```

Commit that file together with the change. It is consumed at release time, when
`changeset version` turns all pending changesets into a version bump and a
`CHANGELOG.md` entry.

Not every commit needs one. Tooling, CI, internal refactors and documentation that
leave the published surface untouched do not.

## Why a file instead of the commit message

Tools like semantic-release derive the bump from Conventional Commits (`feat:`,
`fix(scope):`). Lingner commits use `[feat] ...` instead, so nothing here parses
commit messages. The bump is stated explicitly, which also means it is reviewable
in the pull request rather than inferred afterwards.

## Releasing

```bash
bun run release
```

See `scripts/release.ts` for what that does and in which order. The short version:
checks, bump, rebuild (`dist/` is committed and carries the version), commit, tag.
Tags are plain semver without a `v` prefix, because consumers pin the tag in their
dependency URL.
