FROM oven/bun:1.4.2-alpine

RUN apk add --no-cache openssh-client \
  && addgroup -S wagglebot \
  && adduser -S -G wagglebot wagglebot

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages/contracts ./packages/contracts
COPY packages/d26-auth ./packages/d26-auth
COPY services/auth ./services/auth
RUN bun install --filter @wagglebot/auth --frozen-lockfile --production

USER wagglebot
CMD ["bun", "services/auth/src/index.ts"]
