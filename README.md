# VividTex 🚀
A modern, real-time collaborative LaTeX editor. Write, compile, and sync your academic papers seamlessly across multiple devices and users.

## Features
- **Real-Time Collaboration**: Work on `.tex` files together, just like Google Docs.
- **Bi-directional SyncTeX**: Click in the PDF to jump to the code, or jump from the code to the PDF.
- **Built-in Compiler**: Live PDF generation.
- **Git Integration**: Built-in 1-click commit & push.
- **Secure Self-Hosting**: Password-protected sessions, directory-traversal safe.

## Quick Start (Manual)
To get started locally or on your own server, clone the repository and start the services:

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/VividTex.git
cd VividTex

# 2. Install dependencies & build frontend
cd frontend
npm install
npm run build
cd ..

# 3. Install backend dependencies
cd backend
npm install

# 4. Configure your instance (Optional)
# Copy the example environment file and edit it to set your password and workspace path
cp .env.example .env
nano .env

# 5. Start the service
./backend/start.sh
```
The application will be accessible at `http://localhost:3001`.

## Docker Installation 🐳
VividTex fully supports Docker. Just set up your `.env` file first:
```bash
cp .env.example .env
nano .env

docker-compose up -d --build
```
Your instance will be securely available at `http://localhost:3001`.

### Security Note 🔒
When running on an untrusted network (like a school network), you should:
1. Always define `VIVIDTEX_PASSWORD` to prevent unauthorized users from viewing or modifying files.
2. Put VividTex behind a reverse proxy (like Nginx) and enable HTTPS.
