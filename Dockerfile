# AEL — Agent Economics Layer Dockerfile
# Multi-stage production build

FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production runtime
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/evals ./evals
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/ael_config.yaml ./ael_config.yaml
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Build dist directory for static frontend and ensure data directory exists
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
