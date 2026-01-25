#!/bin/bash
#
# Download Agent-Reported Issues
#
# Downloads issues reported by agents via report_issue tool,
# and feedback reported via report_user_feedback,
# includes surrounding logs for context, and tracks which
# issues have been downloaded.
#
# Usage:
#   ./scripts/download-issues.sh [staging|prod] [--all] [--all-context]
#
# Options:
#   staging|prod  Environment to query (default: staging)
#   --all         Download all issues, not just new ones
#   --all-context  Include context from all log groups (slower)
#

set -e

ENV="${1:-staging}"
DOWNLOAD_ALL=""
ALL_CONTEXT=""

shift 0 || true

if [[ "${1:-}" == "staging" || "${1:-}" == "prod" ]]; then
  ENV="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) DOWNLOAD_ALL="--all" ;;
    --all-context) ALL_CONTEXT="--all-context" ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: ./scripts/download-issues.sh [staging|prod] [--all] [--all-context]" >&2
      exit 2
      ;;
  esac
  shift
done

# Configuration
REGION="us-east-1"
STATE_FILE=".issues-downloaded-${ENV}.json"
OUTPUT_DIR="issues/${ENV}"
CONTEXT_MINUTES=2  # Minutes of logs to include before/after each issue

# Parallelism controls (keep these modest to avoid CloudWatch throttling).
MAX_PARALLEL_SEARCH="${MAX_PARALLEL_SEARCH:-6}"
MAX_PARALLEL_CONTEXT="${MAX_PARALLEL_CONTEXT:-4}"
MAX_PARALLEL_EVENTS="${MAX_PARALLEL_EVENTS:-4}"

# Context scope:
# - default: only fetch context from the log group that emitted the issue/feedback event
# - --all-context: fetch context from all discovered log groups (previous behavior; slower)
CONTEXT_SCOPE="log-group"
if [[ -n "${ALL_CONTEXT}" ]]; then
  CONTEXT_SCOPE="all"
fi

# Log groups to search
# NOTE: Lambda log group names include generated suffixes, so we discover them by prefix.
# Defaults are intentionally broad to catch diagnostics emitted from any handler.
LOG_GROUP_PREFIXES=(
  "/aws/lambda/SwarmStack-${ENV}-AdminApi"
  "/aws/lambda/SwarmStack-${ENV}-Shared"
  "/aws/lambda/SwarmStack-${ENV}-"
)

LOG_GROUPS=()
for PREFIX in "${LOG_GROUP_PREFIXES[@]}"; do
  # shellcheck disable=SC2207
  FOUND=( $(aws logs describe-log-groups \
    --log-group-name-prefix "${PREFIX}" \
    --region "${REGION}" \
    --query 'logGroups[].logGroupName' \
    --output text 2>/dev/null || true) )
  for G in "${FOUND[@]}"; do
    LOG_GROUPS+=("${G}")
  done
done

# Dedupe log groups
# shellcheck disable=SC2207
LOG_GROUPS=( $(printf '%s\n' "${LOG_GROUPS[@]}" | sort -u) )

if [[ "${#LOG_GROUPS[@]}" -eq 0 ]]; then
  echo -e "${YELLOW}No matching CloudWatch log groups found for ${ENV}.${NC}"
  echo "Tried prefixes:"; printf '  - %s\n' "${LOG_GROUP_PREFIXES[@]}"
  exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Agent Issue Downloader ===${NC}"
echo "Environment: ${ENV}"

# Create output directory
mkdir -p "${OUTPUT_DIR}"

# Get last download timestamp
LAST_DOWNLOAD=0
if [[ -f "${STATE_FILE}" && -z "${DOWNLOAD_ALL}" ]]; then
  LAST_DOWNLOAD=$(jq -r '.lastDownload // 0' "${STATE_FILE}" 2>/dev/null || echo "0")
  echo "Last download: $(date -r $((LAST_DOWNLOAD / 1000)) 2>/dev/null || echo 'never')"
else
  echo "Downloading all issues..."
fi

# Current timestamp
NOW=$(($(date +%s) * 1000))

# Temporary directory for collecting issues
ISSUES_DIR=$(mktemp -d)
MAIN_PID=$BASHPID

cleanup() {
  # Background jobs run in subshells and inherit traps.
  # Guard to ensure only the main shell performs cleanup.
  if [[ "$BASHPID" -ne "$MAIN_PID" ]] || [[ "${BASH_SUBSHELL:-0}" -ne 0 ]]; then
    return
  fi

  # Best-effort: stop any in-flight AWS calls before deleting temp dir.
  kill $(jobs -pr) 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "${ISSUES_DIR}" 2>/dev/null || true
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo -e "${YELLOW}Searching for issues...${NC}"

run_search_for_group() {
  local idx="$1"
  local log_group="$2"

  echo "  Checking ${log_group}..."

  # Use simple text-based filter patterns that work reliably with CloudWatch Logs.
  # NOTE: Diagnostics tool logs use event names:
  # - avatar_reported_issue
  # - avatar_reported_feedback

  aws logs filter-log-events \
    --log-group-name "${log_group}" \
    --start-time "${LAST_DOWNLOAD}" \
    --filter-pattern '"avatar_reported_issue"' \
    --region "${REGION}" \
    --query 'events[*]' \
    --output json 2>/dev/null \
    | jq --arg lg "${log_group}" 'map(. + {logGroupName: $lg})' \
    > "${ISSUES_DIR}/group_${idx}_issues.json" || echo "[]" > "${ISSUES_DIR}/group_${idx}_issues.json"

  aws logs filter-log-events \
    --log-group-name "${log_group}" \
    --start-time "${LAST_DOWNLOAD}" \
    --filter-pattern '"avatar_reported_feedback"' \
    --region "${REGION}" \
    --query 'events[*]' \
    --output json 2>/dev/null \
    | jq --arg lg "${log_group}" 'map(. + {logGroupName: $lg})' \
    > "${ISSUES_DIR}/group_${idx}_feedback.json" || echo "[]" > "${ISSUES_DIR}/group_${idx}_feedback.json"
}

# Search each log group in parallel (bounded; bash 3.x compatible)
GROUP_INDEX=0
for LOG_GROUP in "${LOG_GROUPS[@]}"; do
  while [[ $(jobs -rp | wc -l | tr -d ' ') -ge "${MAX_PARALLEL_SEARCH}" ]]; do
    sleep 0.1
  done
  run_search_for_group "${GROUP_INDEX}" "${LOG_GROUP}" &
  GROUP_INDEX=$((GROUP_INDEX + 1))
done
wait || true

fetch_context_logs_for_groups() {
  local start_time="$1"
  local end_time="$2"
  shift 2
  local groups=("$@")

  local context_dir
  context_dir=$(mktemp -d)

  local idx=0
  for lg in "${groups[@]}"; do
    while [[ $(jobs -rp | wc -l | tr -d ' ') -ge "${MAX_PARALLEL_CONTEXT}" ]]; do
      sleep 0.1
    done
    aws logs filter-log-events \
      --log-group-name "${lg}" \
      --start-time "${start_time}" \
      --end-time "${end_time}" \
      --region "${REGION}" \
      --query 'events[*].{timestamp: timestamp, message: message, logStream: logStreamName}' \
      --output json 2>/dev/null > "${context_dir}/ctx_${idx}.json" || echo "[]" > "${context_dir}/ctx_${idx}.json" &
    idx=$((idx + 1))
  done

  wait || true

  jq -s 'add | sort_by(.timestamp)' "${context_dir}"/*.json 2>/dev/null || echo "[]"
  rm -rf "${context_dir}"
}

# Merge all JSON files into one array
MERGED_ISSUES=$(jq -s 'add // []' "${ISSUES_DIR}"/*.json 2>/dev/null || echo "[]")

ISSUE_COUNT=$(echo "${MERGED_ISSUES}" | jq 'map(select(.message | contains("avatar_reported_issue"))) | length // 0' 2>/dev/null || echo "0")
FEEDBACK_COUNT=$(echo "${MERGED_ISSUES}" | jq 'map(select(.message | contains("avatar_reported_feedback"))) | length // 0' 2>/dev/null || echo "0")

if [[ "${ISSUE_COUNT}" -eq 0 && "${FEEDBACK_COUNT}" -eq 0 ]]; then
  echo -e "${GREEN}No new issues/feedback found.${NC}"
  # Update state file
  echo "{\"lastDownload\": ${NOW}, \"issuesDownloaded\": 0, \"feedbackDownloaded\": 0}" > "${STATE_FILE}"
  exit 0
fi

echo -e "${YELLOW}Found ${ISSUE_COUNT} issue(s) and ${FEEDBACK_COUNT} feedback event(s). Downloading with context...${NC}"

# Process each issue - filter to only actual issue events
ISSUES_DOWNLOADED=0
FEEDBACK_DOWNLOADED=0

process_event() {
  local EVENT="$1"

  # Parse issue details
  local TIMESTAMP
  local MESSAGE
  local LOG_STREAM
  local EVENT_ID
  local EVENT_LOG_GROUP
  TIMESTAMP=$(echo "${EVENT}" | jq -r '.timestamp')
  MESSAGE=$(echo "${EVENT}" | jq -r '.message')
  LOG_STREAM=$(echo "${EVENT}" | jq -r '.logStreamName')
  EVENT_ID=$(echo "${EVENT}" | jq -r '.eventId // ""')
  EVENT_LOG_GROUP=$(echo "${EVENT}" | jq -r '.logGroupName // ""')
  
  # Parse the JSON message
  local DATA
  DATA=$(echo "${MESSAGE}" | grep -o '{.*}' | head -1)
  if [[ -z "${DATA}" ]]; then
    return
  fi

  local EVENT_NAME
  EVENT_NAME=$(echo "${DATA}" | jq -r '.event // ""')

  if [[ "${EVENT_NAME}" == "avatar_reported_issue" ]]; then
    local AGENT_ID SEVERITY CATEGORY TITLE
    AGENT_ID=$(echo "${DATA}" | jq -r '.agentId // .avatarId // "unknown"')
    SEVERITY=$(echo "${DATA}" | jq -r '.issue.severity // "unknown"')
    CATEGORY=$(echo "${DATA}" | jq -r '.issue.category // "unknown"')
    TITLE=$(echo "${DATA}" | jq -r '.issue.title // "No title"')

    local ISSUE_FILE
    ISSUE_FILE="${OUTPUT_DIR}/issue-${TIMESTAMP}-${AGENT_ID}-${EVENT_ID}-${SEVERITY}.json"

    local SEVERITY_UPPER
    SEVERITY_UPPER=$(echo "${SEVERITY}" | tr '[:lower:]' '[:upper:]')
    echo -e "  ${BLUE}[${SEVERITY_UPPER}]${NC} ${TITLE} (${AGENT_ID})"
  
  # Calculate time window for context logs
    local CONTEXT_MS START_TIME END_TIME
    CONTEXT_MS=$((CONTEXT_MINUTES * 60 * 1000))
    START_TIME=$((TIMESTAMP - CONTEXT_MS))
    END_TIME=$((TIMESTAMP + CONTEXT_MS))

    # Fetch + combine context logs (parallel, bounded)
    local CONTEXT
    if [[ "${CONTEXT_SCOPE}" == "all" || -z "${EVENT_LOG_GROUP}" ]]; then
      CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${LOG_GROUPS[@]}")
    else
      CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${EVENT_LOG_GROUP}")
    fi
  
  # Build full issue report
    jq -n \
      --argjson issue "${DATA}" \
      --argjson context "${CONTEXT}" \
      --arg timestamp "$(date -r $((TIMESTAMP / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "${TIMESTAMP}")" \
      --arg logStream "${LOG_STREAM}" \
      --arg logGroup "${EVENT_LOG_GROUP}" \
      --arg eventId "${EVENT_ID}" \
      '{
        downloadedAt: (now | todate),
        originalTimestamp: $timestamp,
        logStream: $logStream,
        logGroup: $logGroup,
        eventId: $eventId,
        issue: $issue,
        contextLogs: $context,
        contextWindow: {
          before: "'${CONTEXT_MINUTES}' minutes",
          after: "'${CONTEXT_MINUTES}' minutes"
        }
      }' > "${ISSUE_FILE}"

    ISSUES_DOWNLOADED=$((ISSUES_DOWNLOADED + 1))
    return
  fi

  if [[ "${EVENT_NAME}" == "avatar_reported_feedback" ]]; then
    local AGENT_ID SENTIMENT FEATURE CONTENT
    AGENT_ID=$(echo "${DATA}" | jq -r '.agentId // .avatarId // "unknown"')
    SENTIMENT=$(echo "${DATA}" | jq -r '.feedback.sentiment // "unknown"')
    FEATURE=$(echo "${DATA}" | jq -r '.feedback.feature // "unknown"')
    CONTENT=$(echo "${DATA}" | jq -r '.feedback.content // ""')

    local FEEDBACK_FILE
    FEEDBACK_FILE="${OUTPUT_DIR}/feedback-${TIMESTAMP}-${AGENT_ID}-${EVENT_ID}-${SENTIMENT}.json"

    local SENTIMENT_UPPER
    SENTIMENT_UPPER=$(echo "${SENTIMENT}" | tr '[:lower:]' '[:upper:]')
    echo -e "  ${BLUE}[FEEDBACK:${SENTIMENT_UPPER}]${NC} ${FEATURE} (${AGENT_ID})"

    local CONTEXT_MS START_TIME END_TIME
    CONTEXT_MS=$((CONTEXT_MINUTES * 60 * 1000))
    START_TIME=$((TIMESTAMP - CONTEXT_MS))
    END_TIME=$((TIMESTAMP + CONTEXT_MS))

    # Fetch + combine context logs (parallel, bounded)
    local CONTEXT
    if [[ "${CONTEXT_SCOPE}" == "all" || -z "${EVENT_LOG_GROUP}" ]]; then
      CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${LOG_GROUPS[@]}")
    else
      CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${EVENT_LOG_GROUP}")
    fi

    jq -n \
      --argjson feedback "${DATA}" \
      --argjson context "${CONTEXT}" \
      --arg timestamp "$(date -r $((TIMESTAMP / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "${TIMESTAMP}")" \
      --arg logStream "${LOG_STREAM}" \
      --arg logGroup "${EVENT_LOG_GROUP}" \
      --arg eventId "${EVENT_ID}" \
      --arg feature "${FEATURE}" \
      --arg content "${CONTENT}" \
      '{
        downloadedAt: (now | todate),
        originalTimestamp: $timestamp,
        logStream: $logStream,
        logGroup: $logGroup,
        eventId: $eventId,
        feedback: $feedback,
        contextLogs: $context,
        contextWindow: {
          before: "'${CONTEXT_MINUTES}' minutes",
          after: "'${CONTEXT_MINUTES}' minutes"
        }
      }' > "${FEEDBACK_FILE}"

    FEEDBACK_DOWNLOADED=$((FEEDBACK_DOWNLOADED + 1))
    return
  fi
}

while read -r EVENT; do
  while [[ $(jobs -rp | wc -l | tr -d ' ') -ge "${MAX_PARALLEL_EVENTS}" ]]; do
    sleep 0.1
  done
  process_event "${EVENT}" &
done < <(echo "${MERGED_ISSUES}" | jq -c 'map(select(.message | (contains("avatar_reported_issue") or contains("avatar_reported_feedback")))) | .[]' 2>/dev/null)

wait || true

# Update state file
echo "{\"lastDownload\": ${NOW}, \"issuesDownloaded\": ${ISSUE_COUNT}, \"feedbackDownloaded\": ${FEEDBACK_COUNT}}" > "${STATE_FILE}"

echo ""
echo -e "${GREEN}Downloaded ${ISSUE_COUNT} issue(s) and ${FEEDBACK_COUNT} feedback event(s) to ${OUTPUT_DIR}/${NC}"
echo ""

# Summary by severity
echo -e "${BLUE}Summary by severity:${NC}"
for SEV in critical high medium low; do
  COUNT=$(ls -1 "${OUTPUT_DIR}"/issue-*-${SEV}.json 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${COUNT}" -gt 0 ]]; then
    case "${SEV}" in
      critical) echo -e "  ${RED}CRITICAL: ${COUNT}${NC}" ;;
      high) echo -e "  ${YELLOW}HIGH: ${COUNT}${NC}" ;;
      medium) echo -e "  ${BLUE}MEDIUM: ${COUNT}${NC}" ;;
      low) echo -e "  ${GREEN}LOW: ${COUNT}${NC}" ;;
    esac
  fi
done

echo ""
echo -e "${BLUE}Summary by feedback sentiment:${NC}"
for S in positive negative neutral unknown; do
  COUNT=$(ls -1 "${OUTPUT_DIR}"/feedback-*-${S}.json 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${COUNT}" -gt 0 ]]; then
    echo "  ${S}: ${COUNT}"
  fi
done

echo ""
echo "Issues saved to: ${OUTPUT_DIR}/"
echo "To view an issue: cat ${OUTPUT_DIR}/issue-*.json | jq"
