#!/bin/bash
#
# Tag Release Script
#
# Usage:
#   ./scripts/tag-release.sh [patch|minor|major]
#   ./scripts/tag-release.sh v0.1.5  # explicit version
#
# Automatically increments version, creates tag, and pushes to trigger deploy.
#

set -e

# Fetch latest tags
echo "📦 Fetching latest tags..."
git fetch --tags --quiet

# Get current highest version
current_tag=$(git tag --list 'v*' | sort -V | tail -1)
if [ -z "$current_tag" ]; then
  current_tag="v0.0.0"
fi

current_version="${current_tag#v}"
IFS='.' read -r major minor patch <<< "$current_version"

# Determine new version
if [ -z "$1" ] || [ "$1" = "patch" ]; then
  new_version="v$major.$minor.$((patch + 1))"
elif [ "$1" = "minor" ]; then
  new_version="v$major.$((minor + 1)).0"
elif [ "$1" = "major" ]; then
  new_version="v$((major + 1)).0.0"
elif [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  new_version="$1"
else
  echo "❌ Invalid argument: $1"
  echo "Usage: $0 [patch|minor|major|vX.Y.Z]"
  exit 1
fi

# Validate new version is higher
new_ver_nums="${new_version#v}"
higher=$(echo -e "$current_version\n$new_ver_nums" | sort -V | tail -1)
if [ "$higher" = "$current_version" ] && [ "$current_version" != "$new_ver_nums" ]; then
  echo "❌ Version $new_version is not higher than current $current_tag"
  exit 1
fi

# Show what we're about to do
echo ""
echo "📋 Release Summary:"
echo "   Current version: $current_tag"
echo "   New version:     $new_version"
echo "   Branch:          $(git branch --show-current)"
echo "   Commit:          $(git rev-parse --short HEAD)"
echo ""

# Get recent commits for release notes
echo "📝 Recent changes since $current_tag:"
git log --oneline "$current_tag"..HEAD 2>/dev/null | head -10 || echo "   (first release)"
echo ""

# Confirm
read -p "🚀 Create and push tag $new_version? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Create annotated tag
message="Release $new_version

Changes since $current_tag:
$(git log --oneline "$current_tag"..HEAD 2>/dev/null | head -20 || echo "Initial release")"

git tag -a "$new_version" -m "$message"

# Push tag
echo "📤 Pushing tag..."
git push origin "$new_version"

echo ""
echo "✅ Tagged and pushed $new_version"
echo "🔗 GitHub Actions will now deploy to production"
echo "   Watch: https://github.com/atimics/aws-swarm/actions"
