export const VERSION = '0.1.0';

export function showHelp(): void {
  console.log(`
nimbus - Entire checkpoint deployment CLI

Usage:
  nimbus <command> [options]

Commands:
  doctor             Validate worker deploy readiness and migrations
  deploy checkpoint <checkpoint-id-or-commit-ish>
                      Resolve checkpoint/commit source and queue a deployment job
  workspace create <checkpoint-id-or-commit-ish>
                     Create a persistent sandbox workspace from checkpoint source
  workspace show <workspace-id>
                      Show workspace status and source metadata
  workspace destroy <workspace-id>
                      Destroy sandbox workspace and source bundle
  workspace files <workspace-id> [path]
                      List files in workspace at path (default: .)
  workspace cat <workspace-id> <path>
                      Read file content from workspace
  workspace diff <workspace-id>
                       Show workspace diff summary (use --include-patch for patch)
  workspace deploy <workspace-id>
                       Run deploy preflight, queue deploy, and poll status
  review create --commit [commit-ish]
                        Create workspace+deployment+review and block until review completion
  review create --workspace <id> --deployment <id>
                       Create a report-only review run for an existing deployment
  review preflight [commit-ish]
                       Validate Entire checkpoint/session metadata for review create
  review policy --commit [commit-ish]
                       Generate review policy from Entire prompt history only
  review show <review-id>
                       Show review status and summary
  review events <review-id>
                       Stream review lifecycle events
  review start
                       Start local report UI server at index page
  review open
                       Run one-command policy-first review flow in local UI
  review export <review-id>
                        Export a review as markdown or json
  admin provision-key  Provision a hosted API key (admin only)
  repo register       Register current repository for OIDC exchange
  auth exchange       Exchange GitHub OIDC token for Nimbus JWT (GitHub Actions)
  auth health         Show auth exchange readiness and cache status
  list               List all past jobs
  watch <job-id>     Watch a job's progress

Options:
  --ref <ref>        Resolution hint for checkpoint lookup
  --project-root <path>
                     Deploy project root override for monorepos
  --env-file <path>  Extra env file(s), comma-separated
  --env KEY=VALUE    Explicit env override (repeatable)
  --tests            Run tests during workspace deploy validation (default: off)
  --build            Run build during workspace deploy validation (default: off)
  --no-tests         Legacy alias to disable tests explicitly
  --no-build         Legacy alias to disable build explicitly
  --no-lint          Skip lint in checkpoint deploy metadata
  --no-watch         Disable follow-up watch guidance
  --include-patch    Include unified patch output for workspace diff
  --max-bytes <n>    Max bytes for diff/file output truncation
  --idempotency-key <key>
                     Stable idempotency key for workspace deploy retries
  --poll-interval-ms <n>
                      Poll interval for workspace deploy status checks
  --provider <name>   Deploy provider (simulated|cloudflare_workers_assets)
  --output-dir <path> Static build output directory (required for real provider)
  --summarize-session <mode>
                      Intent context summarization mode (auto|always|never)
  --intent-token-budget <n>
                      Token budget for Entire intent context capture (default: 1200)
  --intent-summary-model <name>
                       Intent summary model override for this run
  --strict-entire-context
                      Require direct Entire checkpoint context (disable branch fallback)
  --workspace <id>    Workspace ID for review create
  --deployment <id>   Deployment ID for review create
  --commit [value]    Commit-ish for one-command review flow (default: HEAD)
  --base <ref>        Diff base ref for review create (uses <base>...<commit>)
  --repo <owner/repo> Repository slug override for repo register
  --dry-run           Validate repo register inputs without API call
  --json              Emit machine-readable JSON output for supported commands
  --output-review-id [path]
                       Write queued review ID to a file (machine-readable)
  --severity-threshold <level>
                      Review finding floor (low|medium|high|critical)
  --max-findings <n>  Maximum findings to include in report
  --model <name>      Review analysis model override for this run
  --label <string>    Label for admin API key provisioning
  --account-id <id>   Account ID for admin API key provisioning
  --admin             Provision an admin-scoped API key
  --no-provenance     Suppress provenance summary in report output
  --no-validation-evidence
                      Suppress validation/deploy evidence in report output
  --format <type>     Review export format (markdown|json)
  --out <path>        Review export output file path
  --port <n>          Port for local report UI server (default: 2000)
  --preflight-only   Run deploy preflight only (do not queue deploy)
  --auto-fix         Allow safe preflight/deploy remediations
  --no-dry-run       Upload source bundle and create checkpoint job
  -h, --help         Show this help message
  -v, --version      Show version

Examples:
  nimbus deploy checkpoint checkpoint:8a513f56ed70
  nimbus workspace create checkpoint:8a513f56ed70 --project-root apps/web
  nimbus workspace show ws_abc12345
  nimbus workspace files ws_abc12345 src
  nimbus workspace diff ws_abc12345 --include-patch --max-bytes 262144
  nimbus workspace deploy ws_abc12345
  nimbus workspace deploy ws_abc12345 --provider cloudflare_workers_assets --output-dir dist
  nimbus workspace deploy ws_abc12345 --idempotency-key deploy-smoke-123 --auto-fix
  nimbus workspace deploy ws_abc12345 --preflight-only
  nimbus workspace deploy ws_abc12345 --tests --build
  nimbus review create --commit HEAD
  nimbus review create --commit main~1
  nimbus review create --commit HEAD --project-root apps/web
  nimbus review create --workspace ws_abc12345 --deployment dep_abcd1234
  nimbus review create --workspace ws_abc12345 --deployment dep_abcd1234 --severity-threshold medium --max-findings 20
  nimbus review create --commit HEAD --model sonnet-4.5
  nimbus review preflight
  nimbus review preflight HEAD~2
  nimbus review policy --commit HEAD
  nimbus review policy --commit HEAD --base origin/main --model anthropic/claude-sonnet-4.5 --json
  nimbus review show rev_abcd1234
   nimbus review events rev_abcd1234
   nimbus review start
   nimbus review start --port 2000
   nimbus review open
   nimbus review open --commit HEAD~1
  nimbus review export rev_abcd1234 --format markdown --out review.md
  nimbus admin provision-key --label "Beta User Key"
  nimbus repo register
  nimbus repo register --repo owner/repo
  nimbus repo register --repo owner/repo --dry-run --json
  nimbus auth exchange
  nimbus auth health
  nimbus doctor
  nimbus deploy checkpoint main~1 --project-root apps/web --env API_URL=https://api.example.com
  nimbus list
  nimbus watch job_abc123

Environment Variables:
  NIMBUS_WORKER_URL  Worker URL (optional) - Defaults to hosted Nimbus worker
  NIMBUS_API_KEY     API key for hosted Nimbus worker access

Self-hosting: https://github.com/dayhaysoos/nimbus#self-hosting-guide
`);
}
