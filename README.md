# VividTex 🚀
A modern, real-time collaborative LaTeX editor. Write, compile, and sync your academic papers seamlessly across multiple devices and users.

> **Note**: This project was developed with AI assistance (GitHub Copilot / Claude).

## Features
- **Real-Time Collaboration**: Work on `.tex` files together, just like Google Docs.
- **Bi-directional SyncTeX**: Click in the PDF to jump to the code, or jump from the code to the PDF.
- **Built-in Compiler**: Live PDF generation with `latexmk` (no shell escape).
- **Git Integration**: Clone repos, create branches, commit, pull & push — all from the browser.
- **Per-Student Git Credentials**: Each student stores their own PAT in the browser; credentials are never shared.
- **Branch Visualization**: Color-coded `git log --graph` tree in the History tab.
- **Multi-Project Support**: Manage multiple LaTeX projects from a single instance.
- **Group-Based Access Control**: Per-group access keys with project-level permissions.
- **Zip Import/Export**: Upload or download projects as ZIP archives.
- **Drag & Drop**: Upload files and folders, move items between directories.
- **Secure Self-Hosting**: Rate limiting, LaTeX sandboxing, directory-traversal protection, security headers.

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

## Configuration (.env)

| Variable | Required | Description |
|---|---|---|
| `VIVIDTEX_ADMIN_KEY` | **Yes** | Admin password / master access key |
| `VIVIDTEX_WORKDIR` | No | Host path for project storage (default: `./workspace`) |
| `VIVIDTEX_CORS_ORIGINS` | No | Comma-separated extra allowed browser origins for API access |
| `VIVIDTEX_GIT_USERNAME` | No | Server-side fallback Git username for private HTTPS remotes |
| `VIVIDTEX_GIT_TOKEN` | No | Server-side fallback Git PAT for private HTTPS remotes |

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
