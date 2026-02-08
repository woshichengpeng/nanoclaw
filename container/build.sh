#!/bin/bash
# Build the NanoClaw agent container images

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="all"
TAG="latest"

if [[ -n "${1:-}" ]]; then
  if [[ "$1" == "claude" || "$1" == "codex" || "$1" == "all" ]]; then
    TARGET="$1"
    shift
  fi
fi

if [[ -n "${1:-}" ]]; then
  TAG="$1"
fi

build_image() {
  local name="$1"
  local dockerfile="$2"

  echo "Building NanoClaw image..."
  echo "Image: ${name}:${TAG}"
  echo "Dockerfile: ${dockerfile}"

  container build -t "${name}:${TAG}" -f "${dockerfile}" .

  echo ""
  echo "Build complete!"
  echo "Image: ${name}:${TAG}"
  echo ""
}

if [[ "$TARGET" == "claude" || "$TARGET" == "all" ]]; then
  build_image "nanoclaw-agent" "Dockerfile"
fi

if [[ "$TARGET" == "codex" || "$TARGET" == "all" ]]; then
  build_image "nanoclaw-codex" "Dockerfile.codex"
fi

echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | container run -i nanoclaw-agent:${TAG}"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false,\"agent\":\"codex\"}' | container run -i nanoclaw-codex:${TAG}"
