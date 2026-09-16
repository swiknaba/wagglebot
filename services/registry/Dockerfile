FROM oven/bun:1.4.2-alpine
RUN apk add --no-cache openssh-client \
  && addgroup -S wagglebot \
  && adduser -S -G wagglebot wagglebot
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/d26-auth/package.json packages/d26-auth/package.json
COPY packages/company-config/package.json packages/company-config/package.json
COPY services/registry/package.json services/registry/package.json
RUN bun install --production --frozen-lockfile
COPY packages/contracts packages/contracts
COPY packages/d26-auth packages/d26-auth
COPY packages/company-config packages/company-config
COPY services/registry services/registry
RUN chown -R wagglebot:wagglebot /app
USER wagglebot
EXPOSE 3040
CMD ["bun", "services/registry/src/index.ts"]
