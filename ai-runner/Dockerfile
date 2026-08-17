# ai-runner container image
# Base: Node 20 slim.
# Ships: git, gh CLI, Claude Code CLI.
FROM node:20-slim

# System deps: git for cloning, gh for PRs, ca-certs, curl, tini
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (non-interactive `claude -p` mode is what we use)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# App deps first (better layer cache)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY server.js ./
COPY tests ./tests

# Repo workspace lives on a persistent volume in production; the runner will
# clone on first request if empty.
RUN mkdir -p /workspace/repo && chown -R node:node /app /workspace

USER node
ENV NODE_ENV=production \
    REPO_DIR=/workspace/repo \
    PORT=3000

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server.js"]
