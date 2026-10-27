#!/bin/bash
# Run by branch-cleanup.yaml, which sets CUTOFF_DAYS, DRY_RUN and GH_TOKEN.
set -euo pipefail

# A rebase gives each commit a new committer date. So a stack kept in sync with main
# stays younger than the cutoff.
CUTOFF="$(date --utc --date "${CUTOFF_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
export CUTOFF

# Each open pull request keeps its head and its base. A branch low in a stack is the
# base of the pull request above it, and GitHub closes that pull request if its base
# is deleted. A pull request from a fork has its head branch only in the fork.
gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls?state=open&per_page=100" \
  --jq '.[] | (select(.head.repo.full_name == env.GITHUB_REPOSITORY) | .head.ref), .base.ref' \
  > "${RUNNER_TEMP}/skip"
# GitHub lists a branch as protected by branch protection or by a ruleset
gh api --paginate "repos/${GITHUB_REPOSITORY}/branches?protected=true&per_page=100" \
  --jq '.[].name' \
  >> "${RUNNER_TEMP}/skip"
# GitHub Pages can publish from a branch that no pull request touches, such as gh-pages
has_pages="$(gh api "repos/${GITHUB_REPOSITORY}" --jq .has_pages)"
if [ "${has_pages}" = true ]; then
  gh api "repos/${GITHUB_REPOSITORY}/pages" --jq '.source.branch // empty' \
    >> "${RUNNER_TEMP}/skip"
fi
declare -A skip
while read -r branch; do
  skip["${branch}"]=1
done < "${RUNNER_TEMP}/skip"

# Reads a list of a branch's pull requests, and prints the time, number and head of
# the one that closed last, separated by tabs. As above, a pull request from a fork
# doesn't count.
latest_closed='map(select(.closedAt != null and .headRepository.nameWithOwner == env.GITHUB_REPOSITORY))
  | max_by(.closedAt) // {} | [.closedAt, .number, .headRefOid]'

# Prints each old branch, its name as a URL path, its head, whether it has more pull
# requests than the query read, and the latest_closed fields, separated by tabs.
#
# Git allows # and % in a branch name, which the URL path must encode. The refs
# endpoint reads each / as part of the name, so those stay.
#
# GitHub writes committedDate and closedAt in UTC with a Z suffix, as CUTOFF is
# written. So comparing the strings compares the times.
# shellcheck disable=SC2016 # $owner and $repository are GraphQL and jq variables
gh api graphql --paginate \
  --raw-field owner="${GITHUB_REPOSITORY%/*}" \
  --raw-field repo="${GITHUB_REPOSITORY#*/}" \
  --raw-field query='
    query($owner: String!, $repo: String!, $endCursor: String) {
      repository(owner: $owner, name: $repo) {
        defaultBranchRef { name }
        refs(refPrefix: "refs/heads/", first: 100, after: $endCursor) {
          nodes {
            name
            target { oid ... on Commit { committedDate } }
            associatedPullRequests(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
              totalCount
              nodes { number closedAt headRefOid headRepository { nameWithOwner } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }' \
  --jq '.data.repository as $repository
    | $repository.refs.nodes[]
    | select(.name != $repository.defaultBranchRef.name and .target.committedDate < env.CUTOFF)
    | [.name, (.name | @uri | gsub("%2F"; "/")), .target.oid, (.associatedPullRequests | .totalCount > (.nodes | length))]
      + (.associatedPullRequests.nodes | '"${latest_closed}"')
    | @tsv' \
  > "${RUNNER_TEMP}/old"

# Prints the latest_closed fields for a branch with more pull requests than the query
# above reads. Each page prints its latest, and sort picks the latest of those.
read_latest_closed() {
  # shellcheck disable=SC2016 # $owner and the other names are GraphQL variables
  gh api graphql --paginate \
    --raw-field owner="${GITHUB_REPOSITORY%/*}" \
    --raw-field repo="${GITHUB_REPOSITORY#*/}" \
    --raw-field ref="refs/heads/$1" \
    --raw-field query='
      query($owner: String!, $repo: String!, $ref: String!, $endCursor: String) {
        repository(owner: $owner, name: $repo) {
          ref(qualifiedName: $ref) {
            associatedPullRequests(first: 100, after: $endCursor) {
              nodes { number closedAt headRefOid headRepository { nameWithOwner } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }' \
    --jq '.data.repository.ref.associatedPullRequests.nodes | '"${latest_closed}"' | @tsv' \
    | sort --reverse | sed -n 1p
}

# GitHub stops updating a pull request's head once it closes. So a branch whose head
# differs from the head of its latest closed pull request may hold work that pull
# request lacks. It's kept until CUTOFF_DAYS after that pull request closed.
# Each stale entry is the branch, its URL path and its head, separated by tabs.
stale=()
kept=()
while IFS=$'\t' read -r branch path head more closed pull pull_head; do
  if [ -n "${skip["${branch}"]:-}" ]; then
    continue
  fi
  if [ "${more}" = true ]; then
    latest="$(read_latest_closed "${branch}")"
    IFS=$'\t' read -r closed pull pull_head <<<"${latest}"
  fi
  if [ -n "${closed}" ] && [[ ! "${closed}" < "${CUTOFF}" ]] && [ "${pull_head}" != "${head}" ]; then
    kept+=("\`${branch}\`, after [#${pull}](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/pull/${pull})")
  else
    stale+=("${branch}"$'\t'"${path}"$'\t'"${head}")
  fi
done < <(sort "${RUNNER_TEMP}/old")

if [ "${DRY_RUN}" = true ]; then
  verb="Would delete"
else
  verb="Deleted"
fi
stale_line="${#stale[@]} branches are stale, with no commit since ${CUTOFF}."
kept_heading="Kept until ${CUTOFF_DAYS} days after their latest pull request closed, as they may hold work it lacks"
echo "${stale_line} ${#kept[@]} more are ${kept_heading,}."

# Each deleted branch is listed with its head, which recreates it
deleted=()
pushed=()
failed=()
echo "::group::Branches to delete: ${#stale[@]}"
for entry in "${stale[@]}"; do
  IFS=$'\t' read -r branch path head <<<"${entry}"
  echo "${branch} ${head}"
  if [ "${DRY_RUN}" = false ]; then
    # A branch pushed to since the listing isn't stale
    if ! current="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/${path}" --jq .object.sha)"; then
      failed+=("${branch}")
      continue
    fi
    if [ "${current}" != "${head}" ]; then
      pushed+=("\`${branch}\`")
      continue
    fi
    if ! gh api --method DELETE "repos/${GITHUB_REPOSITORY}/git/refs/heads/${path}"; then
      failed+=("${branch}")
      continue
    fi
  fi
  deleted+=("\`${branch}\` at \`${head}\`")
done
echo "::endgroup::"

# Writes a heading with the list's length, and the list folded away under it
list() {
  local heading="$1"
  shift
  if [ "$#" -gt 0 ]; then
    printf '\n### %s: %s\n\n<details><summary>Show them</summary>\n\n' "${heading}" "$#"
    printf -- '- %s\n' "$@"
    printf '\n</details>\n'
  fi
}
{
  echo "${stale_line}"
  list "${verb}" "${deleted[@]}"
  list "${kept_heading}" "${kept[@]}"
  list "Kept, as they were pushed to during the run" "${pushed[@]}"
  failed_code=("${failed[@]/#/\`}")
  list "Failed to delete" "${failed_code[@]/%/\`}"
} >>"${GITHUB_STEP_SUMMARY}"

if [ "${#failed[@]}" -gt 0 ]; then
  printf '::error::Failed to delete %s\n' "${failed[@]}"
  exit 1
fi
