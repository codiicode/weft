# Weft API. Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 WEFT_DATA_DIR=/data

# Workspace manifests first, so dependency installs cache between deploys.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/strategy/package.json packages/strategy/
COPY packages/venues/package.json packages/venues/
COPY packages/engine/package.json packages/engine/
COPY packages/execution/package.json packages/execution/
RUN npm ci --omit=dev -w @weft/api --include-workspace-root=false --ignore-scripts

COPY packages ./packages
COPY apps/api ./apps/api

EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/src/server.ts"]
