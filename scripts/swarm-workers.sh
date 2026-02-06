#!/bin/bash
# Manage Codex worker runs in parallel from a manifest.
#
# Manifest format (pipe-delimited):
#   worker|ticket|worktree|prompt_file|enabled
#
# Example:
#   ./scripts/swarm-workers.sh launch \
#     --manifest docs/engineering-report-2026-02-05/SUBAGENT-DISPATCH-WAVE6.manifest \
#     --max-parallel 2
#
#   ./scripts/swarm-workers.sh status --run-dir /tmp/swarm-workers/20260206T000000Z

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_MANIFEST="$REPO_ROOT/docs/engineering-report-2026-02-05/SUBAGENT-DISPATCH-WAVE6.manifest"
DEFAULT_RUN_ROOT="/tmp/swarm-workers"

trim() {
  local v="$1"
  # shellcheck disable=SC2001
  echo "$(echo "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
}

usage() {
  cat <<'EOF'
Usage:
  swarm-workers.sh launch [options]
  swarm-workers.sh status --run-dir <dir>

Commands:
  launch    Launch workers from manifest in parallel.
  status    Show process and completion status for a run directory.

Launch options:
  --manifest <file>       Manifest file path (default: docs/.../SUBAGENT-DISPATCH-WAVE6.manifest)
  --run-root <dir>        Root folder for run artifacts (default: /tmp/swarm-workers)
  --run-dir <dir>         Explicit run directory (default: <run-root>/<timestamp>)
  --max-parallel <n>      Maximum concurrent workers (default: 2)
  --sandbox <mode>        Codex sandbox mode (default: workspace-write)
  --no-full-auto          Omit --full-auto on codex exec
  --detach                Launch and return immediately without waiting

Status options:
  --run-dir <dir>         Run directory to inspect
EOF
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

is_enabled() {
  local v
  v="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  [ "$v" = "1" ] || [ "$v" = "true" ] || [ "$v" = "yes" ] || [ "$v" = "y" ]
}

running_count() {
  local count=0
  local pid
  for pid in "$@"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      count=$((count + 1))
    fi
  done
  echo "$count"
}

launch() {
  require_cmd codex

  local manifest="$DEFAULT_MANIFEST"
  local run_root="$DEFAULT_RUN_ROOT"
  local run_dir=""
  local max_parallel=2
  local sandbox_mode="workspace-write"
  local full_auto="true"
  local detach="false"

  while [ $# -gt 0 ]; do
    case "$1" in
      --manifest)
        manifest="${2:-}"
        shift 2
        ;;
      --run-root)
        run_root="${2:-}"
        shift 2
        ;;
      --run-dir)
        run_dir="${2:-}"
        shift 2
        ;;
      --max-parallel)
        max_parallel="${2:-}"
        shift 2
        ;;
      --sandbox)
        sandbox_mode="${2:-}"
        shift 2
        ;;
      --no-full-auto)
        full_auto="false"
        shift
        ;;
      --detach)
        detach="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        exit 2
        ;;
    esac
  done

  if [ ! -f "$manifest" ]; then
    echo "Manifest not found: $manifest" >&2
    exit 1
  fi

  if ! [[ "$max_parallel" =~ ^[0-9]+$ ]] || [ "$max_parallel" -lt 1 ]; then
    echo "--max-parallel must be a positive integer" >&2
    exit 2
  fi

  if [ -z "$run_dir" ]; then
    run_dir="$run_root/$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  mkdir -p "$run_dir/logs"

  local processes_file="$run_dir/processes.tsv"
  local summary_file="$run_dir/summary.tsv"
  local metadata_file="$run_dir/metadata.txt"

  {
    echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "manifest=$manifest"
    echo "max_parallel=$max_parallel"
    echo "sandbox_mode=$sandbox_mode"
    echo "full_auto=$full_auto"
    echo "detach=$detach"
  } > "$metadata_file"

  echo "worker|ticket|pid|worktree|prompt_file|log_file|started_at" > "$processes_file"
  echo "worker|ticket|pid|exit_code|finished_at|log_file" > "$summary_file"

  local -a pids=()
  local -a workers=()
  local -a tickets=()
  local -a logs=()

  local line
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    if [ -z "$line" ] || [[ "$line" == \#* ]]; then
      continue
    fi

    local worker ticket worktree prompt_file enabled
    IFS='|' read -r worker ticket worktree prompt_file enabled <<EOF
$line
EOF
    worker="$(trim "$worker")"
    ticket="$(trim "$ticket")"
    worktree="$(trim "$worktree")"
    prompt_file="$(trim "$prompt_file")"
    enabled="$(trim "$enabled")"

    if ! is_enabled "$enabled"; then
      continue
    fi

    if [ -z "$worker" ] || [ -z "$ticket" ] || [ -z "$worktree" ] || [ -z "$prompt_file" ]; then
      echo "Skipping malformed manifest line: $line" >&2
      continue
    fi

    if [ ! -d "$worktree" ]; then
      echo "Skipping $worker: missing worktree $worktree" >&2
      continue
    fi

    if [ ! -f "$prompt_file" ]; then
      echo "Skipping $worker: missing prompt file $prompt_file" >&2
      continue
    fi

    while true; do
      local current
      current="$(running_count "${pids[@]:-}")"
      if [ "$current" -lt "$max_parallel" ]; then
        break
      fi
      sleep 1
    done

    local log_file="$run_dir/logs/${worker}.log"
    local started_at
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    if [ "$full_auto" = "true" ]; then
      codex exec --cd "$worktree" --sandbox "$sandbox_mode" --full-auto - < "$prompt_file" > "$log_file" 2>&1 &
    else
      codex exec --cd "$worktree" --sandbox "$sandbox_mode" - < "$prompt_file" > "$log_file" 2>&1 &
    fi
    local pid=$!

    echo "$worker|$ticket|$pid|$worktree|$prompt_file|$log_file|$started_at" >> "$processes_file"

    pids+=("$pid")
    workers+=("$worker")
    tickets+=("$ticket")
    logs+=("$log_file")

    echo "Launched $worker ($ticket) pid=$pid log=$log_file"
  done < "$manifest"

  echo "run_dir=$run_dir"

  if [ "$detach" = "true" ]; then
    echo "Detached mode enabled; workers continue in background."
    return 0
  fi

  if [ "${#pids[@]}" -eq 0 ]; then
    echo "No workers launched."
    return 0
  fi

  local idx
  for idx in "${!pids[@]}"; do
    local pid="${pids[$idx]}"
    local worker="${workers[$idx]}"
    local ticket="${tickets[$idx]}"
    local log_file="${logs[$idx]}"

    set +e
    wait "$pid"
    local exit_code=$?
    set -e

    local finished_at
    finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "$worker|$ticket|$pid|$exit_code|$finished_at|$log_file" >> "$summary_file"
    echo "Completed $worker ($ticket) pid=$pid exit=$exit_code"
  done

  echo "Summary written to: $summary_file"
}

status() {
  local run_dir=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --run-dir)
        run_dir="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        exit 2
        ;;
    esac
  done

  if [ -z "$run_dir" ]; then
    echo "--run-dir is required for status" >&2
    exit 2
  fi

  local processes_file="$run_dir/processes.tsv"
  local summary_file="$run_dir/summary.tsv"

  if [ ! -f "$processes_file" ]; then
    echo "No processes file found: $processes_file" >&2
    exit 1
  fi

  echo "Run dir: $run_dir"
  echo "Processes:"
  awk -F'|' 'NR==1{next} {printf "  %s (%s) pid=%s log=%s\n", $1, $2, $3, $6}' "$processes_file"

  if [ -f "$summary_file" ]; then
    echo "Completed:"
    awk -F'|' 'NR==1{next} {printf "  %s (%s) pid=%s exit=%s finished=%s\n", $1, $2, $3, $4, $5}' "$summary_file"
  else
    echo "Completed: (no summary yet)"
  fi
}

main() {
  if [ $# -lt 1 ]; then
    usage
    exit 2
  fi

  local cmd="$1"
  shift

  case "$cmd" in
    launch)
      launch "$@"
      ;;
    status)
      status "$@"
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage
      exit 2
      ;;
  esac
}

main "$@"
