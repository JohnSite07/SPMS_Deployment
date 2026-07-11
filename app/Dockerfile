# Build context is the REPO ROOT (see .github/workflows/cd.yml `context: .`),
# so this Dockerfile can see both app/ and client/. Referenced paths are
# therefore repo-root-relative (app/…, client/…), not app-relative.

# Client build stage: compile the React SPA to static files. Vite and the dev
# dependencies live only here and never reach the runtime image.
FROM node:20-slim AS client-build
WORKDIR /client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Dependency stage: install production-only backend dependencies.
FROM node:20-slim AS deps
WORKDIR /app
COPY app/package*.json ./
RUN npm ci --omit=dev

# Runtime stage: minimal image, non-root user.
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY app/package*.json ./
COPY app/src ./src
# The built SPA, served by src/app.js at ../client/dist relative to src.
COPY --from=client-build /client/dist ./client/dist
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
