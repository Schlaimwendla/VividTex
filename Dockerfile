FROM node:20-alpine

# Install system dependencies for LaTeX and Git
RUN apk add --no-cache \
    texlive-full \
    git \
    bash \
    perl

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

# Expose ports for the backend API and Hocuspocus WebSockets
EXPOSE 3001 1234

# Create a default workspace directory
RUN mkdir -p /app/workspace

# Set default environment variables
ENV VIVIDTEX_WORKDIR=/app/workspace
ENV VIVIDTEX_PASSWORD=

# Start the backend server
CMD ["node", "server.js"]
