FROM node:20-alpine

# Install system dependencies for LaTeX and Git
RUN apk add --no-cache \
    texlive-full \
    git \
    bash \
    perl \
    unzip

WORKDIR /app

# Copy the entire project
COPY . .

# Install frontend dependencies and build
WORKDIR /app/frontend
RUN npm install
RUN npm run build

# Install backend dependencies
WORKDIR /app/backend
RUN npm install

# Expose port for the backend API + WebSocket
EXPOSE 3001

# Create non-root user
RUN addgroup -S vividtex && adduser -S vividtex -G vividtex

# Create a default workspace directory with proper permissions
RUN mkdir -p /app/workspace && chown vividtex:vividtex /app/workspace && chmod 755 /app/workspace
RUN mkdir -p /tmp/vividtex-uploads && chown vividtex:vividtex /tmp/vividtex-uploads
RUN mkdir -p /app/backend/logs && chown vividtex:vividtex /app/backend/logs

# Set default environment variables
ENV VIVIDTEX_WORKDIR=/app/workspace
ENV VIVIDTEX_PASSWORD=

# Make entrypoint executable
RUN chmod +x /app/backend/entrypoint.sh

# Start as root so entrypoint can fix volume ownership, then drop to vividtex
CMD ["/app/backend/entrypoint.sh"]
