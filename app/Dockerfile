FROM node:24.13.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.13.1-bookworm-slim
ENV NODE_ENV=production TZ=UTC NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/scripts ./scripts
USER node
CMD ["node", "build"]
