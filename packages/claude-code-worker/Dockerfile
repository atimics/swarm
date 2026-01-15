# Claude Code Worker Docker Image
# Runs as ECS Fargate task to process coding tasks

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user for security
RUN useradd -m -s /bin/bash claude

# Set up working directories
WORKDIR /home/claude/app

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml* ./

# Install dependencies (production only)
RUN npm install --omit=dev || npm install

# Copy compiled code
COPY dist/ ./dist/

# Create workspace directory
RUN mkdir -p /home/claude/workspace && \
    chown -R claude:claude /home/claude

# Switch to non-root user
USER claude

# Set environment
ENV NODE_ENV=production

# Health check - worker stays alive, check process exists
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD pgrep -f "node dist/index.js" || exit 1

# Run the worker
CMD ["node", "dist/index.js"]
