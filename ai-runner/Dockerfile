# ai-runner container image — Node 20 slim + git + gh + Claude Code CLI.
# Runs as root (single-tenant internal tool behind bearer auth); entrypoint
# ensures the /workspace volume is initialised before starting the server.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY tests ./tests
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /workspace

ENV NODE_ENV=production \
    WORKSPACE_ROOT=/workspace \
    PORT=3000

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
