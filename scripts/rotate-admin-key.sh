#!/usr/bin/env bash

# Nimbus admin key ops utility.
#
# Modes:
#   --bootstrap  First-time or recovery path when no working admin key exists.
#                Generates a new admin key locally and inserts it directly into D1.
#   --rotate     Normal admin key rotation when you already have a working admin key.
#                Uses the current key to mint a new admin key, then revokes the old key.
#
# Use this script when:
#   - You need to recover admin access (bootstrap)
#   - You want regular key rotation or suspect key exposure (rotate)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WRANGLER_TOML="${REPO_ROOT}/packages/worker/wrangler.toml"

DEFAULT_WORKER_URL="https://nimbus-worker.ndejesus1227.workers.dev"
WORKER_URL="${DEFAULT_WORKER_URL}"
DB_NAME=""
MODE=""
DRY_RUN=0

CREATED_KEY=""
CREATED_LABEL=""
CREATED_ACCOUNT_ID=""
REVOKED_OLD_KEY_HASH=""
VERIFY_NEW_STATUS="not-run"
VERIFY_OLD_STATUS="not-run"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/rotate-admin-key.sh --bootstrap [--dry-run] [--worker-url <url>] [--db-name <name>]
  ./scripts/rotate-admin-key.sh --rotate    [--dry-run] [--worker-url <url>] [--db-name <name>]

Options:
  --bootstrap         Bootstrap a new admin key directly in D1.
  --rotate            Rotate from an existing admin key.
  --dry-run           Print operations without executing.
  --worker-url <url>  Override worker URL.
  --db-name <name>    Override D1 database name.
  -h, --help          Show this help.
EOF
}

info() { printf '[info] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
fail() { printf '[error] %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

escape_sql() {
  local value="$1"
  printf "%s" "${value//\'/''}"
}

resolve_default_db_name() {
  [[ -f "${WRANGLER_TOML}" ]] || fail "wrangler.toml not found at ${WRANGLER_TOML}"
  local parsed
  parsed="$(awk -F'=' '/^[[:space:]]*(database_name|db_name)[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); gsub(/"/, "", $2); print $2; exit}' "${WRANGLER_TOML}")"
  [[ -n "${parsed}" ]] || fail "Could not read database_name from ${WRANGLER_TOML}; use --db-name"
  printf '%s' "${parsed}"
}

run_wrangler_d1_sql() {
  local sql="$1"
  local cmd=(wrangler d1 execute "${DB_NAME}" --remote --command "${sql}")
  if [[ ${DRY_RUN} -eq 1 ]]; then
    printf '[dry-run] '
    printf '%q ' "${cmd[@]}"
    printf '\n'
    return 0
  fi
  "${cmd[@]}"
}

http_call() {
  local method="$1"
  local url="$2"
  local api_key="$3"
  local json_body="$4"

  local tmp_body
  tmp_body="$(mktemp)"

  if [[ ${DRY_RUN} -eq 1 ]]; then
    printf '[dry-run] curl -sS -X %q %q -H %q -H %q' "${method}" "${url}" "Content-Type: application/json" "X-Nimbus-Api-Key: <redacted>"
    if [[ -n "${json_body}" ]]; then
      printf ' --data %q' "${json_body}"
    fi
    printf '\n'
    HTTP_STATUS="000"
    HTTP_BODY=""
    rm -f "${tmp_body}"
    return 0
  fi

  local status
  if [[ -n "${json_body}" ]]; then
    status="$(curl -sS -o "${tmp_body}" -w "%{http_code}" -X "${method}" "${url}" \
      -H "Content-Type: application/json" \
      -H "X-Nimbus-Api-Key: ${api_key}" \
      --data "${json_body}")"
  else
    status="$(curl -sS -o "${tmp_body}" -w "%{http_code}" -X "${method}" "${url}" \
      -H "Content-Type: application/json" \
      -H "X-Nimbus-Api-Key: ${api_key}")"
  fi

  HTTP_STATUS="${status}"
  HTTP_BODY="$(cat "${tmp_body}")"
  rm -f "${tmp_body}"
}

verify_key_admin_access() {
  local key="$1"
  local expected_status="$2"
  http_call "POST" "${WORKER_URL}/api/admin/keys" "${key}" '{}'
  if [[ ${DRY_RUN} -eq 1 ]]; then
    return 0
  fi
  [[ "${HTTP_STATUS}" == "${expected_status}" ]] || {
    fail "Verification failed for admin access (expected HTTP ${expected_status}, got ${HTTP_STATUS}). Body: ${HTTP_BODY}"
  }
}

verify_readiness_accepts_key() {
  local key="$1"
  http_call "GET" "${WORKER_URL}/api/system/deploy-readiness" "${key}" ''
  if [[ ${DRY_RUN} -eq 1 ]]; then
    return 0
  fi
  [[ "${HTTP_STATUS}" == "200" ]] || fail "Deploy readiness check failed for new key (HTTP ${HTTP_STATUS}). Body: ${HTTP_BODY}"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --bootstrap)
        [[ -z "${MODE}" ]] || fail "Choose only one mode: --bootstrap or --rotate"
        MODE="bootstrap"
        ;;
      --rotate)
        [[ -z "${MODE}" ]] || fail "Choose only one mode: --bootstrap or --rotate"
        MODE="rotate"
        ;;
      --dry-run)
        DRY_RUN=1
        ;;
      --worker-url)
        shift
        [[ $# -gt 0 ]] || fail "Missing value for --worker-url"
        WORKER_URL="$1"
        ;;
      --db-name)
        shift
        [[ $# -gt 0 ]] || fail "Missing value for --db-name"
        DB_NAME="$1"
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

bootstrap_mode() {
  info "Mode: bootstrap"

  local label
  read -r -p "Label for new admin key [admin-bootstrap]: " label
  label="${label:-admin-bootstrap}"

  local raw_key key_hash account_id
  raw_key="$(node -e "const c=require('crypto');process.stdout.write('nmb_live_'+c.randomBytes(16).toString('hex'))")"
  key_hash="$(node -e "const c=require('crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('hex'))" "${raw_key}")"
  account_id="$(node -e "console.log(require('crypto').randomUUID())")"

  CREATED_KEY="${raw_key}"
  CREATED_LABEL="${label}"
  CREATED_ACCOUNT_ID="${account_id}"

  local label_sql account_sql hash_sql now_sql
  label_sql="$(escape_sql "${label}")"
  account_sql="$(escape_sql "${account_id}")"
  hash_sql="$(escape_sql "${key_hash}")"
  now_sql="datetime('now')"

  local insert_sql
  insert_sql="INSERT INTO nimbus_api_keys (key_hash, account_id, label, is_admin, created_at) VALUES ('${hash_sql}', '${account_sql}', '${label_sql}', 1, ${now_sql});"
  run_wrangler_d1_sql "${insert_sql}"

  printf '\n'
  warn "Store this admin key immediately. It will not be shown again by this script."
  printf 'NEW_ADMIN_KEY=%s\n\n' "${raw_key}"

  verify_readiness_accepts_key "${raw_key}"
  VERIFY_NEW_STATUS="accepted-by-deploy-readiness"

  # Stronger auth verification for admin-only path without creating a new key.
  verify_key_admin_access "${raw_key}" "400"
  VERIFY_NEW_STATUS="accepted-by-admin-endpoint"
}

rotate_mode() {
  info "Mode: rotate"

  local old_key
  if [[ ${DRY_RUN} -eq 1 ]]; then
    old_key="<redacted-old-key>"
    info "Dry-run: skipping secure key prompt; using placeholder old key."
  else
    read -r -s -p "Current admin key: " old_key
    printf '\n'
    [[ -n "${old_key}" ]] || fail "Current admin key is required"
  fi

  local label
  read -r -p "Label for replacement admin key [admin-rotated]: " label
  label="${label:-admin-rotated}"

  local create_payload
  create_payload="$(node -e "const label=process.argv[1];process.stdout.write(JSON.stringify({label,isAdmin:true}));" "${label}")"
  http_call "POST" "${WORKER_URL}/api/admin/keys" "${old_key}" "${create_payload}"

  if [[ ${DRY_RUN} -eq 1 ]]; then
    CREATED_KEY="<redacted-new-key>"
    CREATED_LABEL="${label}"
    CREATED_ACCOUNT_ID="<unknown>"
  else
    [[ "${HTTP_STATUS}" == "201" ]] || fail "Failed to create replacement key (HTTP ${HTTP_STATUS}). Body: ${HTTP_BODY}"

    local parsed
    parsed="$(printf '%s' "${HTTP_BODY}" | node -e "let data='';process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{const j=JSON.parse(data);if(!j.key){process.exit(2);}console.log([j.key,j.label||'',j.accountId||''].join('\t'));});")" || fail "Failed to parse replacement key response"

    IFS=$'\t' read -r CREATED_KEY CREATED_LABEL CREATED_ACCOUNT_ID <<<"${parsed}"
    [[ -n "${CREATED_KEY}" ]] || fail "Replacement key missing in response"
  fi

  printf '\n'
  warn "Store this new admin key immediately. It will not be shown again by this script."
  printf 'NEW_ADMIN_KEY=%s\n\n' "${CREATED_KEY}"

  if [[ ${DRY_RUN} -eq 0 ]]; then
    read -r -p "Store the new key now. Press enter when ready to revoke the old key. " _
  else
    info "Dry-run: skipping revoke confirmation prompt."
  fi

  local old_hash old_hash_sql
  if [[ ${DRY_RUN} -eq 1 ]]; then
    old_hash="<redacted-old-key-hash>"
  else
    old_hash="$(node -e "const c=require('crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('hex'))" "${old_key}")"
  fi
  REVOKED_OLD_KEY_HASH="${old_hash}"
  old_hash_sql="$(escape_sql "${old_hash}")"

  run_wrangler_d1_sql "DELETE FROM nimbus_api_keys WHERE key_hash = '${old_hash_sql}';"

  if [[ ${DRY_RUN} -eq 0 ]]; then
    verify_key_admin_access "${old_key}" "401"
    VERIFY_OLD_STATUS="rejected"
    verify_key_admin_access "${CREATED_KEY}" "400"
    VERIFY_NEW_STATUS="accepted-by-admin-endpoint"
  else
    VERIFY_OLD_STATUS="skipped-dry-run"
    VERIFY_NEW_STATUS="skipped-dry-run"
  fi
}

print_summary() {
  printf '\n=== Summary ===\n'
  printf 'Mode: %s\n' "${MODE}"
  printf 'Dry run: %s\n' "$([[ ${DRY_RUN} -eq 1 ]] && printf yes || printf no)"
  printf 'Worker URL: %s\n' "${WORKER_URL}"
  printf 'D1 DB name: %s\n' "${DB_NAME}"
  printf 'Created key label: %s\n' "${CREATED_LABEL:-n/a}"
  printf 'Created key account_id: %s\n' "${CREATED_ACCOUNT_ID:-n/a}"
  printf 'Old key revoked hash: %s\n' "${REVOKED_OLD_KEY_HASH:-n/a}"
  printf 'Verification (new key): %s\n' "${VERIFY_NEW_STATUS}"
  printf 'Verification (old key): %s\n' "${VERIFY_OLD_STATUS}"
}

main() {
  parse_args "$@"
  [[ -n "${MODE}" ]] || fail "You must provide either --bootstrap or --rotate"

  require_cmd node
  require_cmd wrangler
  require_cmd curl
  require_cmd awk

  if [[ -z "${DB_NAME}" ]]; then
    DB_NAME="$(resolve_default_db_name)"
  fi

  case "${MODE}" in
    bootstrap)
      bootstrap_mode
      ;;
    rotate)
      rotate_mode
      ;;
    *)
      fail "Unsupported mode: ${MODE}"
      ;;
  esac

  print_summary
}

main "$@"
