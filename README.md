# GitHub Daily Activity Bot

A configurable GitHub Actions bot for small, honest developer maintenance logs across private repos. It creates realistic planning, review, documentation, testing, and repo-health notes without claiming fake feature work.

The controller repo owns the full daily plan. Target repos only receive and apply planned commits.

## How It Works

```text
[Controller Repo]
  daily-controller.yml runs several short slot jobs
        |
        └── generate-plan.js
              - loads bot.config.json and repos.json
              - builds the same deterministic daily plan in every slot
              - chooses day type, commit count, repos, times, categories, messages, workflow mode
              - dispatches only commits assigned to the current slot

[Target Repo]
  receive-commits.yml receives the controller payload
        |
        └── write-commits.js
              - checks planned IDs for duplicates
              - waits only until the planned commit time
              - writes a useful log entry
              - commits with the planned message
              - either pushes directly or opens a pull request
```

The global daily commit count is controlled only by the controller. The hard cap is still `10`, but realistic defaults allow zero-commit days.

## Files

Controller repo:

```text
controller-repo/
├── bot.config.json
├── repos.json
└── .github/
    ├── workflows/daily-controller.yml
    └── scripts/generate-plan.js
```

Target repo template:

```text
target-repo-template/
└── .github/
    ├── workflows/receive-commits.yml
    └── scripts/write-commits.js
```

`dispatch-commits.js` is deprecated reference code. Runtime dispatch now happens inside `generate-plan.js`.

## Configuration

Most behavior lives in `controller-repo/bot.config.json`:

| Area | Configurable values |
| --- | --- |
| Time | timezone, workday start/end, quiet lunch periods |
| Volume | min/max commits, hard cap, day type weights, daily activity probability |
| GitHub flow | direct push vs branch + pull request weights |
| Slots | dispatch start, slot window start/end |
| Repos | repo list path, repo weights, repo types, quiet probability |
| Content | categories, commit messages, log headers, log entry text |
| Realism | timing patterns, round-minute avoidance, same-repo spacing, burst gaps |
| Weekly behavior | weekday/weekend activity multipliers and category boosts |
| Safety | target log files, hidden idempotency markers, late-start policy, seed salt behavior |
| Dry run | report detail and local duplicate checking settings |

Defaults use `Asia/Karachi`, a `09:00-17:00` workday, a quieter lunch window, and four short slots that start slightly before their commit windows.

## Repo List

Simple format still works:

```json
[
  "your-username/repo-one",
  "your-username/repo-two"
]
```

Richer metadata is also supported:

```json
[
  {
    "repo": "your-username/frontend-app",
    "type": "frontend",
    "weight": 1.4,
    "quietProbability": 0.2,
    "preferredCategories": ["ui-cleanup", "accessibility", "documentation"]
  },
  {
    "repo": "your-username/api-service",
    "type": "backend",
    "weight": 1.1,
    "preferredCategories": ["api-notes", "validation-review", "testing"]
  }
]
```

Supported default repo types include `frontend`, `backend`, `smart-contract`, `docs`, `experiments`, `learning`, `tooling`, and `general`.

## Human-Like Planning

The controller chooses a day type:

| Day type | Default behavior |
| --- | --- |
| off | 0 commits |
| reading | 0 commits, research/reading day |
| debugging | 0-1 commits |
| busy | 0 commits, work happened outside this repo set |
| sick | 0 commits, unavailable day |
| quiet | 0-1 commits |
| light | 1-2 commits, most common |
| normal | 3-5 commits |
| focused | 4-7 commits, often concentrated in fewer repos |
| heavy | 6-10 commits, rare |

Timing is weighted instead of flat random. The planner avoids exact round minutes, quiets lunch, sometimes starts late or ends early, sometimes creates a burst, and spreads repeated commits in the same repo where possible.

Weekly defaults favor planning on Monday, normal work notes Tuesday through Thursday, cleanup/docs on Friday, and lower activity on weekends. Because `allowZeroCommitDays` is enabled by default, some days intentionally produce no commits.

## GitHub Workflow Modes

The target writer supports realistic development flows:

- `direct`: pull latest changes, commit on the checked-out branch, push with retry.
- `pull_request`: create a planned branch, commit there, push the branch, and open a PR.
- `draft_pull_request`: same as PR mode, but opens a draft PR for manual review.

The controller chooses the mode with weights from `workflowMode`. PR mode is the default majority path. Direct push remains available as a configurable fallback-style mode.

Before pushing, the target writer runs `git pull --rebase`. If rebase conflicts occur, it aborts and exits safely so the workflow can be retried after manual cleanup. Pushes are retried with another pull/rebase between attempts.

## Idempotency

Every planned commit has a stable ID based on:

```text
date + repo + slot + local time + commit index + seed salt
```

The target writer records the planned ID as a hidden HTML comment in the log. If the same slot is retried, manually re-run, or delayed, the target checks the log before writing and skips IDs that already exist.

An optional state file can also be enabled in `targetRuntime.stateFile`, but the default hidden-marker log check is enough for normal use.

## Repo-Aware Notes

The target writer can inspect the checked-out repo before writing. It looks for common project signals such as `README.md`, `package.json`, `src`, `src/components`, `docs`, `contracts`, tests, and GitHub workflow files. Log templates can use placeholders like `{area}`, `{artifact}`, `{workflow}`, and `{moduleKind}`; the target fills those with repo-specific context so notes read less generic while staying honest.

The controller can also spread notes across weighted files with `targetLogFiles`, for example `DEV_LOG.md`, `NOTES.md`, or `docs/maintenance.md`.

## Secrets

Controller repo secrets:

| Secret | Required | Purpose |
| --- | --- | --- |
| `GH_PAT` | yes for real runs | Dispatch target workflows |
| `PLAN_SEED_SALT` | recommended | Makes deterministic plans less predictable |

Target repo secrets:

| Secret | Required | Purpose |
| --- | --- | --- |
| `GH_PAT` | yes | Checkout and push with repo access |
| `GIT_USER_NAME` | yes | Commit author name |
| `GIT_USER_EMAIL` | yes | Commit author email |

The PAT needs `Contents: Read and Write`, `Actions: Read and Write`, and `Pull requests: Read and Write` for the controller and all target repos when PR mode is enabled.

## Dry Run And Testing

Run the controller workflow manually with `dry_run=true`. The report shows:

- selected local date and timezone
- day type and global commit total
- active and inactive repos
- complete schedule
- slot assignment
- category and message per commit
- planned commit IDs
- working-window warnings
- duplicate handling note

Manual test flow:

1. Run `Daily Commit Controller` with `dry_run=true` and `force_slot=ALL`.
2. Check that the global total is between `0` and `10`.
3. Check that all planned local times are inside the configured workday.
4. Run dry-runs for `A`, `B`, `C`, and `D` to confirm the same full plan appears and each slot only dispatches its own commits.
5. Run one real forced slot after target repos have the updated template files.
6. Re-run the same forced slot to confirm duplicate planned IDs are skipped.

Local syntax checks:

```bash
node --check controller-repo/.github/scripts/generate-plan.js
node --check target-repo-template/.github/scripts/write-commits.js
```

Local controller dry-run:

```bash
DRY_RUN=true FORCE_SLOT=ALL node controller-repo/.github/scripts/generate-plan.js
```

## Changing Activity Level

To reduce activity, lower `dailyActivityProbability`, increase `off`/`reading`/`busy`/`sick` day weights, lower `commitLimits.max`, reduce heavy/focused day weights, increase repo `quietProbability`, or reduce weekend `activityMultiplier`.

To increase activity, raise normal/focused/heavy day weights or repo weights. The default hard cap still prevents more than `10` commits per day unless `allowExceedHardCap` is intentionally set.

To disable weekend activity, keep `allowZeroCommitDays` as `true`, set Sunday/Saturday activity lower, and give `off`, `reading`, or `quiet` more weight for those days.

## Changing Timezone Or Working Hours

Edit `timezone`, `workday.start`, `workday.end`, and `slots` in `bot.config.json`.

If you change slot windows significantly, update `daily-controller.yml` cron times too. GitHub cron is UTC, and the cron should start a few minutes before each configured slot window.

## Adding Or Removing Repos

Edit `controller-repo/repos.json`, then make sure every target repo has:

- `.github/workflows/receive-commits.yml`
- `.github/scripts/write-commits.js`
- target secrets `GH_PAT`, `GIT_USER_NAME`, and `GIT_USER_EMAIL`
- PAT access granted for that repo

The controller will include new repos in the next deterministic daily plan.

## Fixed Safety Rules

- Target repos never decide the daily count.
- Default total daily commits are clamped to `0..10`.
- No database, external server, local PC, or long 8-hour job is required.
- Content stays limited to notes, reviews, maintenance observations, reminders, and logs.
- The bot avoids feature/fix claims unless the code actually changes those files.
