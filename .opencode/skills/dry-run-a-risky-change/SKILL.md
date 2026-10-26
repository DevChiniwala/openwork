---
name: dry-run-a-risky-change
description: Billing, plans, seats, permissions, access rules, auth, flag removals or data migrations that could lock real organizations out or change what they pay. Use before merging or deploying such a change to see exactly which production organizations it affects, prove the UI on production-shaped data, and only with explicit approval test against a PlanetScale copy of real data.
---

# Dry-run a risky change

Tests prove the rule you wrote. They do not tell you which real organizations
the rule changes. Before a risky change ships, answer three questions in order
and stop at the first level that answers them:

1. **Who changes?** Every production organization whose outcome differs
   before vs after (blocked, unblocked, billed differently, loses access).
2. **Does it look right to them?** The real screens on organizations shaped
   like the affected ones.
3. **Does it behave right on real data?** Only when 1 and 2 cannot answer it.

Confidentiality (AGENTS.md, hard rule): production names, ids, emails and
counts stay in chat. Never put them in a branch, commit, fixture, screenshot,
PR or issue. Describe affected organizations generically ("one grandfathered
org with ~30 SSO users").

## Level 1: read-only production dry run (always)

Run the new rule against production inputs without writing anything.

1. Write the new rule's inputs as the smallest set of columns (plan metadata,
   member counts, subscription status, feature overrides). Express the rule
   either as SQL or by feeding query results into the PR's pure function.
2. Read them with the platform admin MCP `den_query` (read-only SQL against
   the Den database). Never use admin write tools (`den_update_org_plan`,
   `den_set_org_capability`, `den_set_feature_rollout`) during a dry run.
3. Compute **before** (current `dev` rule) and **after** (the PR) for every
   organization the rule can touch, and report only the ones that differ, plus
   anyone at or near a new limit.
4. Put the query (no results) in the PR as the pre-deploy check, and list the
   ops steps it implies (for example "give one org enough seats first").

`den_query` traps that produced wrong answers before:

- JSON values compare as **text**: `GREATEST(5, JSON_EXTRACT(m,'$.limits.members'))`
  says `'40' < '5'`. Always `CAST(JSON_UNQUOTE(JSON_EXTRACT(...)) AS UNSIGNED)`.
- It refuses credential tables (`invitation`, `session`, `account`, keys and
  tokens) and any statement containing a write keyword as a word, including
  inside string literals (`'%grant%'`, `'invitation.create.attempted'`). Use
  `LIKE 'invitation.%.attempted'`, or count placeholder `member` rows
  (`joined_at IS NULL`) instead of reading invitations.
- It stops at 14 seconds. Filter `audit_event` by `org_id` and a `created_at`
  range; never scan it whole.
- Feature state lives in `feature_rollout` and `organization_feature`, not
  `organization.metadata.capabilities` (a legacy copy).

## Level 2: production-shaped preview (UI changes)

Reproduce each affected shape with generic data and drive the real screens.

1. From Level 1, list the distinct shapes (for example: Enterprise trial with
   an end date, full admin-set plan, paid in Stripe, old grant over its limit,
   Free at its limit).
2. Seed them in an evals world (`evals/worlds/*.ts`, generic names such as
   "Acme") and prove the journeys in a proof (`write-a-spec`). Use the fake
   Stripe lab (`evals/worlds/fake-stripe.ts`) when billing must be configured,
   or limits that depend on Stripe being set up switch off.
3. Run headless: `pnpm evals:e2e <name> --local`, or boot a preview with
   `preview-my-work` (`preview-den` / `preview-full`, locally or on Daytona)
   and click through by hand. Attach screenshots to the PR (`upload-photo`).

## Level 3: PlanetScale copy of real data (exceptional, needs approval)

Use only when Levels 1 and 2 cannot answer the question (data-dependent
migrations, performance on real volume). Ask the person first and name the
cost and the data involved.

Requirements, all writes to PlanetScale's control plane (never to production
data): `create_branch` on the database; for real data, `restore_backup` (or
production backup restore) access and Data Branching enabled on the
organization; a branch password to connect. The read-only PlanetScale MCP
cannot do any of this; use `pscale` signed in by the person
(`pscale auth login`, hand off for sign-in) or a scoped service token from
Infisical (`get-env-var`). A restored branch costs as much as the production
branch while it exists.

Guards, all required:

- `pscale branch create <db> <short-lived-name> --restore <backup-id> --wait`,
  and delete it when done (`pscale branch delete`); never promote it.
- Run Den against it in a sandbox (Daytona), never against production
  services: email delivery off, Stripe **test** keys or the fake Stripe lab,
  no Slack, connector or webhook credentials, separate Redis.
- The copy holds every member's email and encrypted credentials: do not
  export, screenshot or paste its rows anywhere. Evidence from it is a yes/no
  and counts in chat only.

## Before merge and deploy

- The PR states the rule, the Level 1 query, the ops steps that must happen
  first, and the deploy order when more than one service changes.
- Do the ops steps with the person's numbers, re-run the Level 1 query, and
  confirm nobody is newly blocked before deploying.
- Know the rollback: revert the PR, or, if the change is behind a feature,
  the kill switch in `/admin` (`add-a-feature`).
