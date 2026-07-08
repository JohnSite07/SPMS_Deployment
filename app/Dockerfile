# Build stage: install production dependencies only.
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Runtime stage: minimal image, non-root user.
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
