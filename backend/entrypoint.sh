#!/bin/sh
# Fix ownership of mounted volumes so the vividtex user can write to them
chown -R vividtex:vividtex /app/workspace /app/backend/logs /tmp/vividtex-uploads 2>/dev/null || true

# Auto-generate admin key if not set
ENV_FILE="/app/.env"
if ! grep -q 'VIVIDTEX_ADMIN_KEY=' "$ENV_FILE" 2>/dev/null && [ -z "$VIVIDTEX_ADMIN_KEY" ] && [ -z "$VIVIDTEX_PASSWORD" ]; then
    KEY=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "" >> "$ENV_FILE"
    echo "# Auto-generated admin key" >> "$ENV_FILE"
    echo "VIVIDTEX_ADMIN_KEY=$KEY" >> "$ENV_FILE"
    export VIVIDTEX_ADMIN_KEY="$KEY"
    echo "[entrypoint] Generated admin key and saved to .env: $KEY"
fi

# Drop privileges and run the server
exec su -s /bin/sh vividtex -c "cd /app/backend && node server.js"
