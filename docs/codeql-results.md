# Missing CodeQL results despite successful jobs

OpenWork uses GitHub's CodeQL **default setup**, not a checked-in analysis workflow.
GitHub can add a language automatically when repository contents change. Existing
PRs may have successful scans from before that change and still lack the newly
required result. The code-scanning merge rule checks uploaded analyses, not just
whether an Actions job is green.

On September 5, 2026, PR #4517 had Actions and JavaScript/TypeScript results for
3427828, but Python was added to default setup after that scan. GitHub consequently
reported one missing result for the PR head or its merge commit e322949.

## Exclude evals and tests from analysis

`.github/codeql/codeql-config.yml` excludes all `evals/` trees (including their
shared packages), test-suite/support directories, and extension-independent test
filenames such as `*.test.*`, `*.spec.*`, `*.e2e.*`, `test_*`, `*_test.*`,
`test-*`, `*Test.*`, and `*Tests.*`. Compound names such as `*.api.test.ts`,
`*.live.test.ts`, and `*.proof.test.ts` are covered too. Singular `test/`
directories are scoped to workspace package roots and `src/test/`: a blanket
`**/test/**` would also exclude the production SSO routes in
`ee/apps/den-web/app/sso/test/`. Production files that merely contain "test" in
their names (for example `latest-assistant-tool-parts.ts` and `model-test.ts`)
remain scanned.

**Committing the file alone does not activate it.** Keep default setup and enable
its supported custom-configuration repository property:

1. In the organization settings, create the **Text** custom repository property
   `github-codeql-config-file` if it does not exist. Do not set an organization-wide
   default: these exclusions are specific to this repository.
2. After the configuration is available on the default branch, set that property
   for `different-ai/openwork` to `.github/codeql/codeql-config.yml`.
3. Trigger a fresh scan with a normal push. Inspect the CodeQL run to confirm it
   loads this configuration, excludes eval/test sources, and still analyzes
   production sources. Local pattern checks are not proof of live activation.
4. Run `node scripts/ci/check-codeql-results.mjs` after scanning completes to
   verify uploaded language coverage for open PRs.

These are **analysis** exclusions, not workflow trigger filters; scans still run
for test-only PRs and upload the required language results. They apply to
JavaScript/TypeScript, Python, and other supported no-build analyses. Compiled
languages analyzed through a build require build-level exclusions instead.
Languages, security queries, alert thresholds, and the coverage monitor are
unchanged. Repository settings are a separate activation step, not changed by
this file.

See [custom configuration with default setup](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/edit-default-setup#customizing-default-setup-with-a-configuration-file)
and [CodeQL path patterns](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options#specifying-directories-to-scan).

## Detect

The daily `CodeQL Result Coverage` workflow checks open same-repository PRs targeting the default branch
against successful language uploads at the newest scanned default-branch commit. It reports missing successful uploads
at the current head or merge commit and fails with a PR-specific summary. It does
not execute PR code, change settings, close PRs, or bypass scanning. Active scans
are reported as pending. Forks are excluded because default setup does not scan them.

Run the same read-only audit locally with an authenticated GitHub CLI:

```sh
node scripts/ci/check-codeql-results.mjs 4517
node scripts/ci/check-codeql-results.mjs
```

API failures and missing baselines fail the audit; they are not interpreted as zero required results.
GitHub has used both `dynamic/github-code-scanning/codeql:upload` and
`dynamic/github-code-scanning/codeql:analyze` for default setup. The monitor
recognizes those exact keys, keeps the baseline to one commit and run key, and
fails on an unsupported latest default-setup key rather than silently using an
older baseline. Custom-workflow uploads do not stand in for default setup.
`node --test scripts/ci/check-codeql-results.test.mjs` covers this accounting
without requesting scans or changing security settings.

The monitor uses baseline uploads because reading default-setup settings requires
Administration permission, which the workflow token does not have. Newly enabled
languages become expected once their baseline uploads succeed. Results are read
from the latest 100 baseline analyses; old PR history is paginated in full.
This verifies coverage, not absence of vulnerabilities. The existing CodeQL rule
continues to enforce alert thresholds. If switching to advanced setup, update this
audit to use that workflow's categories; it expects the default-setup analysis key.

## Recover

Inspect the failed scan first if one exists. For an old successful default-setup
scan missing a newly enabled language, generate a new push event on the PR branch:

```sh
git status --short
git commit --allow-empty -m 'ci: refresh CodeQL after configuration change'
git push
```

Verify you are on the intended PR branch before committing. This changes the head
SHA, so refresh any evidence that requires the exact head. Re-run the audit once
CodeQL finishes and confirm every configured language has an uploaded result.
A normal upcoming commit also triggers a fresh scan.

GitHub rejected re-running the old generated workflow and manual dispatch for this
incident; closing/reopening the PR did not generate a new CodeQL run. Do not use
those as the recovery procedure, remove a language, or weaken the merge rule.
After changing default setup, run the repository-wide audit to find older PRs
that also need a fresh scan.

References: [Default setup behavior](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types)
and [editing default setup](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/edit-default-setup).
