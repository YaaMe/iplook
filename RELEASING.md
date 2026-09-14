# Releasing

A release is a tag. Everything else follows from it, with two human gates.

```
git push origin vX.Y.Z
  │
  ├─ tag matches package.json
  ├─ CI already passed on this commit
  ├─ npm run build
  │
  ⏸  approve the deployment on GitHub
  │
  ├─ npm stage publish          OIDC, no token, provenance signed
  │
  ⏸  approve the staged package on npm          requires 2FA
  │
  └─ publish the drafted GitHub Release
```

Two gates with two different roots of trust. The GitHub one confirms a build
that has already passed everything; the npm one confirms the package may
become installable, and rests on your npm 2FA rather than on GitHub. A
compromised workflow can stage something, but cannot ship it.

There is no long-lived credential anywhere.

## Cutting one

```sh
# 1. Bump, commit, and let CI run on that commit — the release refuses a tag
#    on a commit it has never seen.
npm version 0.1.3 --no-git-tag-version
git commit -am "chore: 0.1.3"
git push origin main

# 2. Once CI is green on it:
git tag -s v0.1.3 -m "iplook 0.1.3

<what changed>"
git push origin v0.1.3
```

Then:

1. **Actions → the release run → Review deployments → Approve.** Worth a look
   at `CI passed on this commit` first; it prints the checks it found.
2. **npmjs.com → your profile → Packages → Staged Packages → Approve.** Or
   `npm stage list` and `npm stage approve <id>`, which needs npm ≥ 11.15.
   Approval is blocked until npm's malware scan finishes; the page refreshes
   every minute.
3. **Releases → the draft → Publish release.**

Steps 2 and 3 belong together: the Release is drafted rather than published
because the version is not installable until npm accepts it, and CI cannot
know when that happens.

Afterwards:

```sh
npm view iplook@0.1.3 version bin exports
```

## One-time setup

Both of these exist already. This is what to recreate if they are ever lost.

**A GitHub environment named `npm`** — Settings → Environments → New
environment → `npm`, with **Required reviewers**. Without it the job runs
unattended, and the workflow's `environment: npm` silently does nothing.

**An npm trusted publisher** — npmjs.com → iplook → Settings → Trusted
publishing:

| field | value |
|---|---|
| Organization or user | `YaaMe` |
| Repository | `iplook` |
| Workflow filename | `release.yml` — the basename, not a path |
| Environment | `npm` — must match the workflow's `environment:` |

**The repository name is case-sensitive.** The OIDC claim carries
`YaaMe/iplook`; a configuration reading `yaame/iplook` does not match it.

Leave "Allow npm publish" unchecked. Staging is permitted by default, which is
all the workflow needs, and direct publishing is the thing worth not allowing.

## When it fails

npm reports a trusted-publishing mismatch as **`ENEEDAUTH`** or **404**, which
read as "you are not logged in" and send you looking for a credential that is
not supposed to exist. This is [npm/cli#9088]. Getting that error with no
token configured almost always means the trusted publisher configuration does
not match the run — check the four fields above, case included, before
anything else.

The `what the publish will see` step exists for this. It prints the npm and
node versions, the registry, `NPM_CONFIG_USERCONFIG`, whether an id-token is
obtainable, whether `NODE_AUTH_TOKEN` leaked in, and every `.npmrc` that might
be read. When all of that is clean and the publish still fails, the problem is
on npm's side, not the runner's.

Two runner-side causes it does catch:

- **`registry-url` on `actions/setup-node`** writes an `.npmrc` containing
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`. With no token that
  expands to empty, npm treats authentication as configured, and never
  attempts OIDC. The workflow deliberately omits `registry-url`.
- **npm older than 11.15** has no `npm stage`. Node 24 ships 11.4, so the
  workflow upgrades npm before using it.

A warning that reads `"bin[iplook]" script name dist/cli.js was invalid and
removed` during staging is cosmetic — npm is normalising `./dist/cli.js`, and
the field survives. `npm view iplook bin` after publishing confirms it.

## Versioning

`0.x` while the API is still meeting its first users. `LoadOptions.index` and
the shape of the value dictionary are the parts most likely to move.

[npm/cli#9088]: https://github.com/npm/cli/issues/9088
