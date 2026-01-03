# Build webui
FROM node:20-bullseye AS build
WORKDIR /app/webui
COPY webui/package.json webui/package-lock.json ./
RUN npm ci
COPY webui/ ./
RUN npm run build

# Runtime
FROM node:20-bullseye-slim
WORKDIR /app
COPY --from=build /app/public /app/public
COPY webui-proxy/package.json webui-proxy/package-lock.json* ./
RUN npm install --omit=dev
COPY webui-proxy/server.js ./server.js
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
