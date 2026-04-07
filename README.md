# VividTex 🚀
A modern, real-time collaborative LaTeX editor. Write, compile, and sync your academic papers seamlessly across multiple devices and users.

> **Note**: This project was developed with AI assistance (GitHub Copilot / Claude).

## Features
- **Real-time collaboration**: Edit `.tex` files together with live cursor presence.
- **Single-port deployment**: API + collaborative WebSocket run on `:3001` (`/ws`).
- **Focused LaTeX editor**: Syntax highlighting, autocomplete, folding, bracket matching, and Overleaf-style shortcuts.
- **Bi-directional SyncTeX**: Jump code → PDF and PDF → code.
- **Built-in compile pipeline**: `latexmk` with safe `--no-shell-escape` defaults.
- **Git workflow in browser**: Clone, branch, commit, pull, push, and visualize history graph.
- **Per-student Git credentials**: Browser-local PAT storage for classroom use.
- **Project management**: Multi-project support, tabs, search, trash restore, ZIP import/export, and drag/drop.
- **Access control**: Admin/group keys with optional LDAP login.
- **Security baseline**: Rate limiting, path traversal protection, and hardened headers.

## Quick Start (Manual)

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/VividTex.git
cd VividTex

# 2. Install dependencies & build frontend
cd frontend && npm install && npm run build && cd ..

# 3. Install backend dependencies
cd backend && npm install && cd ..

# 4. Configure your instance
nano .env   # set VIVIDTEX_ADMIN_KEY at a minimum

# 5. Start the service
./backend/start.sh
```
The application will be accessible at `http://localhost:3001`.

## Docker Installation 🐳

```bash
nano .env   # set VIVIDTEX_ADMIN_KEY

docker compose up -d --build
```
Your instance will be available at `http://localhost:3001`.

### Auto-start On PC Boot

To make VividTex start automatically after reboot:

```bash
# 1) Enable Docker daemon on boot (Linux systemd)
sudo systemctl enable --now docker

# 2) Start VividTex once in detached mode
docker compose up -d --build
```

Because `docker-compose.yml` uses `restart: unless-stopped`, the container will come back up automatically whenever the machine restarts.

## Configuration (.env)

| Variable | Required | Description |
|---|---|---|
| `VIVIDTEX_ADMIN_KEY` | **Yes** | Admin password / master access key |
| `VIVIDTEX_WORKDIR` | No | Host path for project storage (default: `./workspace`) |
| `VIVIDTEX_CORS_ORIGINS` | No | Comma-separated extra allowed browser origins for API access |
| `VIVIDTEX_GIT_USERNAME` | No | Server-side fallback Git username for private HTTPS remotes |
| `VIVIDTEX_GIT_TOKEN` | No | Server-side fallback Git PAT for private HTTPS remotes |
| `VIVIDTEX_LDAP_URL` | No | LDAP/AD server URL (example: `ldap://dc.school.local`) |
| `VIVIDTEX_LDAP_BASE_DN` | No | LDAP base DN for user search (example: `DC=school,DC=local`) |
| `VIVIDTEX_LDAP_USER_FILTER` | No | LDAP user filter, default: `(sAMAccountName={{username}})` |
| `VIVIDTEX_LDAP_BIND_DN` | No | Optional LDAP service account DN used for initial bind/search |
| `VIVIDTEX_LDAP_BIND_PASSWORD` | No | Password for `VIVIDTEX_LDAP_BIND_DN` |
| `VIVIDTEX_LDAP_GROUP` | No | Optional required LDAP group substring for login access |
| `VIVIDTEX_LDAP_ADMIN_GROUP` | No | Optional LDAP group substring that maps users to admin role |

LDAP login is enabled only when both `VIVIDTEX_LDAP_URL` and `VIVIDTEX_LDAP_BASE_DN` are set.

## Security Notes 🔒

1. **Always set `VIVIDTEX_ADMIN_KEY`** — without it, the instance is open to anyone.
2. **Use HTTPS in production** — put VividTex behind a reverse proxy (Nginx, Caddy) with TLS.
3. **Group access keys** — create per-group keys in the admin panel to control who can access which projects.
4. **LaTeX sandboxing** — compilation runs with `--no-shell-escape` to prevent `\write18` attacks.
5. **Path traversal protection** — all file operations go through `safeJoin()`.
6. **Rate limiting** — login is rate-limited; compilation and uploads have process timeouts.

## Git Authentication

**Per-student (recommended):** Students enter their Git username and Personal Access Token in the Git Credentials panel in the browser. Credentials are stored in `localStorage` and sent via request headers — they never touch the server's file system.

- **GitHub classic PAT**: requires the `repo` scope
- **GitHub fine-grained PAT**: requires Contents → Read and write
- **GitLab PAT**: requires `write_repository` scope

**Server-side fallback (optional):** Set `VIVIDTEX_GIT_USERNAME` and `VIVIDTEX_GIT_TOKEN` in `.env` for a shared default. Student-level credentials take priority when present.

## License

See [LICENSE](LICENSE) for terms. Free for educational and internal use with attribution. No redistribution as your own work or resale.
