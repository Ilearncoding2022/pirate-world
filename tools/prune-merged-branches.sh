#!/usr/bin/env bash
#
# Delete remote branches whose commits are already contained in the base branch.
#
# A branch qualifies only when its tip is an ancestor of the base branch, so
# every commit on it is still reachable from the base after deletion. Anything
# with commits of its own is reported and left alone.
#
# Usage:
#   tools/prune-merged-branches.sh              # dry run, lists what would go
#   tools/prune-merged-branches.sh --delete     # actually delete them
#   tools/prune-merged-branches.sh --base dev --delete
#
set -euo pipefail

BASE=main
REMOTE=origin
DELETE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --delete)     DELETE=1 ;;
    --dry-run)    DELETE=0 ;;
    --base)       BASE="${2:?--base needs a branch name}"; shift ;;
    --remote)     REMOTE="${2:?--remote needs a remote name}"; shift ;;
    -h|--help)
      sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2 ;;
  esac
  shift
done

# Protected forever, whatever the merge status says.
is_protected() {
  case "$1" in
    "$BASE"|main|master|develop|release/*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "Fetching $REMOTE ..."
git fetch --prune "$REMOTE"

if ! git rev-parse --verify --quiet "$REMOTE/$BASE" >/dev/null; then
  echo "error: $REMOTE/$BASE does not exist" >&2
  exit 1
fi

# The currently checked-out branch is never a candidate, so a cleanup run
# cannot delete the branch it is running from.
current=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

merged=()
kept=()

while read -r branch; do
  [ -n "$branch" ] || continue
  if is_protected "$branch" || [ "$branch" = "$current" ]; then
    continue
  fi
  ref="$REMOTE/$branch"
  git rev-parse --verify --quiet "$ref" >/dev/null || continue
  if git merge-base --is-ancestor "$ref" "$REMOTE/$BASE"; then
    behind=$(git rev-list --count "$ref".."$REMOTE/$BASE")
    merged+=("$branch")
    printf '  merged   %-52s (%s behind %s)\n' "$branch" "$behind" "$BASE"
  else
    ahead=$(git rev-list --count "$REMOTE/$BASE".."$ref")
    kept+=("$branch")
    printf '  KEEP     %-52s (%s commit(s) not in %s)\n' "$branch" "$ahead" "$BASE"
  fi
done < <(git ls-remote --heads "$REMOTE" | awk '{print $2}' | sed 's|refs/heads/||' | sort)

echo
echo "${#merged[@]} branch(es) fully merged into $BASE, ${#kept[@]} with unmerged work."

if [ "${#merged[@]}" -eq 0 ]; then
  echo "Nothing to prune."
  exit 0
fi

if [ "$DELETE" -ne 1 ]; then
  echo "Dry run. Re-run with --delete to remove the merged branches."
  exit 0
fi

echo "Deleting ${#merged[@]} merged branch(es) from $REMOTE ..."
# Batched so the whole set goes in one push instead of one round trip each.
git push "$REMOTE" --delete "${merged[@]}"
git fetch --prune "$REMOTE"
echo "Done."
