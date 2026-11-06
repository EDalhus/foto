FROM node:24.13.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.13.1-bookworm-slim
ENV NODE_ENV=production TZ=UTC NODE_NO_WARNINGS=1
# Skrift til vannmerket (sharp tegner teksten med systemets skrifter), og ffmpeg til video
# (stillbilde, lengde og avspillingsversjon).
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/scripts ./scripts
USER node
CMD ["node", "build"]
