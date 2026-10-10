# Stage 1: Build — compile TypeScript backend + Vite frontend
FROM node:22-bookworm AS build
WORKDIR /app

# Install build tools for native modules (node-pty)
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y ca-certificates python3 make g++ \
    && sed -i 's|http://mirrors.tuna.tsinghua.edu.cn/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests for dependency installation
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/clario/package.json apps/clario/tsconfig.json apps/clario/
COPY apps/clario/web/package.json apps/clario/web/tsconfig.json apps/clario/web/
# Vendored xlsx tarball — both package.json files pull it in via a `file:` dependency,
# so it must exist before npm ci runs.
COPY vendor/ vendor/

RUN npm config set registry https://registry.npmmirror.com && npm ci

# Copy source code
COPY apps/clario/src apps/clario/src/
COPY apps/clario/scripts apps/clario/scripts/
COPY apps/clario/web/src apps/clario/web/src/
COPY apps/clario/web/vite.config.ts apps/clario/web/index.html apps/clario/web/

RUN npm run build

# Stage 2: Production runtime — web UI mode
FROM node:22-bookworm AS runtime
WORKDIR /app

# python3 is required at runtime for the pptx→svg preview converter
# (apps/clario/scripts/pptx_to_svg). Stdlib-only, no pip packages.
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y ca-certificates python3 \
    && sed -i 's|http://mirrors.tuna.tsinghua.edu.cn/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    INNO_HOME=/var/lib/clario \
    INNO_CONFIG_DIR=/etc/clario \
    INNO_DATA_DIR=/var/lib/clario/data \
    INNO_SKILLS_DIR=/var/lib/clario/skills \
    INNO_WORKSPACE_DIR=/srv/clario-workspace \
    INNO_PORT=3000

# Copy the FULL node_modules from build stage (no pruning).
# npm prune --production is unreliable with workspaces: it can drop
# packages like @earendil-works/pi-ai that are depended on by workspace
# packages but nested due to version conflicts with pi-web-ui.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/clario/node_modules ./apps/clario/node_modules

# Copy compiled artifacts from build stage
COPY --from=build /app/apps/clario/dist ./apps/clario/dist
COPY --from=build /app/apps/clario/web/dist ./apps/clario/web/dist
# Vendored Python pptx→svg converter (not compiled by tsc, copied verbatim)
COPY --from=build /app/apps/clario/scripts ./apps/clario/scripts

#COPY config.example.json /etc/clario/config.json
#RUN mkdir -p /var/lib/clario/data /var/lib/clario/skills /srv/clario-workspace

EXPOSE 3000

CMD ["node", "apps/clario/dist/server.js"]
