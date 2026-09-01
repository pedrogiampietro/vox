# Duas etapas. A imagem final leva o servidor em um arquivo .mjs, o cliente web
# ja buildado e apenas as dependencias de producao.
#
# Base Debian trixie (slim), nao Alpine e nao bookworm: o addon nativo do
# WebTransport distribui prebuild contra glibc 2.38+. Alpine (musl) nao tem
# binario e o bookworm so tem glibc 2.36; nos dois o QUIC cai fora e a voz
# volta para TCP - justamente o que este trabalho veio resolver.

FROM node:22-trixie-slim AS build
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
RUN npm run build && npm prune --omit=dev

FROM node:22-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# O addon nativo nao pode ser embutido pelo esbuild, entao vem por node_modules.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./dist/server.mjs
COPY --from=build /app/packages/web/dist ./packages/web/dist
EXPOSE 9987/tcp 9987/udp
USER node
CMD ["node", "dist/server.mjs"]
