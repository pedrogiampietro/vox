# Duas etapas: a imagem final leva um arquivo .mjs e o cliente web ja buildado.
# Sem node_modules, sem TypeScript, sem tsx em producao.

FROM node:22-alpine AS build
WORKDIR /app

# Manifests primeiro: a camada de dependencias so refaz quando eles mudam.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/

# A casca desktop fica de fora: o Rust nao entra na imagem do servidor.
RUN npm ci \
      --include-workspace-root \
      --workspace=@vox/protocol \
      --workspace=@vox/server \
      --workspace=@vox/web

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist/server.mjs ./dist/server.mjs
COPY --from=build /app/packages/web/dist ./packages/web/dist
EXPOSE 9987
USER node
CMD ["node", "dist/server.mjs"]
