#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAG="${1:-latest}"

# Install deps and compile agent-runner TypeScript so dist/ is fresh before Docker COPY
echo "Installing agent-runner dependencies..."
(cd "$SCRIPT_DIR/agent-runner" && npm install --prefer-offline)
echo "Compiling agent-runner TypeScript..."
(cd "$SCRIPT_DIR/agent-runner" && npm run build)
echo ""

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

build_image "nanoclaw-agent" "Dockerfile"

echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | container run -i nanoclaw-agent:${TAG}"
