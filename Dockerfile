# Imagen de Sofía para un VPS propio: una imagen para todos los negocios y un contenedor por negocio.
# Cada contenedor monta su configuración en /config y sus datos en /data (ver docs/vps-propio.md).
#
#   docker build -t sofia:$(git rev-parse --short HEAD) .
#   docker run --rm sofia:<tag> npm test
#
# Con --build-arg NAVEGADOR=1 se instala Chromium para las altas por navegador de AimHarder (la imagen pasa de 1 GB a unos 2,3 GB).

FROM node:22-bookworm-slim AS dependencias
WORKDIR /app
# Herramientas de compilación solo por si better-sqlite3 no encuentra binario precompilado; no pasan a la imagen final
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --no-audit --no-fund

FROM node:22-bookworm-slim
ARG NAVEGADOR=0
# ffmpeg: notas de voz e imágenes grandes o en HEIC. tini: reenvía SIGTERM para que el apagado ordenado funcione.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencias /app/node_modules ./node_modules
COPY . .
RUN if [ "$NAVEGADOR" = "1" ]; then \
      npm install --no-save --no-audit --no-fund playwright@"$(node -p "require('./package.json').optionalDependencies.playwright")" \
      && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install --with-deps chromium \
      && rm -rf /var/lib/apt/lists/*; \
    fi \
  && mkdir -p /data /config && chown node:node /data /config
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3200 \
    DB_PATH=/data/setter.db \
    CONFIG_DIR=/config \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER node
EXPOSE 3200
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
