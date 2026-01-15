# Claude Code Worker Docker Image
# Runs as ECS Fargate task to process coding tasks

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN useradd -m -s /bin/bash claude

# Set up working directories
WORKDIR /home/claude/app

# Copy package files for dependency installation  
COPY package.json ./

# Install dependencies (production only) - includes @anthropic-ai/claude-code
RUN npm install --omit=dev

# Copy compiled code
COPY dist/ ./dist/

# Create workspace directory
RUN mkdir -p /home/claude/workspace && \
    chown -R claude:claude /home/claude

# Switch to non-root user
USER claude

# Set environment
ENV NODE_ENV=production

# Health check - use longer start period for initialization
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD pgrep -f "node.*index.js" || exit 1

# Run the worker
CMD ["node", "dist/index.js"]
