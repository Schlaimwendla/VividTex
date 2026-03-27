#!/bin/bash
# Move to the backend directory so npm can find package.json
cd "$(dirname "$0")"

# Load variables from the `.env` file in the root if it exists
if [ -f ../.env ]; then
    set -a
    source ../.env
    set +a
fi

# Determine WORKDIR: Use what's in .env, or fallback to the default workspace
export VIVIDTEX_WORKDIR="$(realpath "${VIVIDTEX_WORKDIR:-"../workspace"}")"
export VIVIDTEX_PASSWORD="${VIVIDTEX_PASSWORD:-""}"

echo "Starting VividTex Server..."
echo "Workspace: $VIVIDTEX_WORKDIR"
if [ -n "$VIVIDTEX_PASSWORD" ]; then
    echo "Password Protection: ENABLED"
else
    echo "Password Protection: DISABLED"
fi

npm start
