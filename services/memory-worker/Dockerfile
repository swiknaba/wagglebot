FROM oven/bun:1.4.2

ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tar \
  && rm -rf /var/lib/apt/lists/* \
  && case "$TARGETARCH" in \
    amd64) gitleaks_arch=x64; gitleaks_sha256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
    arm64) gitleaks_arch=arm64; gitleaks_sha256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
    *) echo "unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl --fail --location --silent --show-error "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${gitleaks_arch}.tar.gz" -o /tmp/gitleaks.tar.gz \
  && echo "$gitleaks_sha256  /tmp/gitleaks.tar.gz" | sha256sum --check --status \
  && tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks \
  && chmod 0755 /usr/local/bin/gitleaks \
  && sha256sum /usr/local/bin/gitleaks | cut -d ' ' -f 1 > /usr/local/share/gitleaks.sha256 \
  && rm /tmp/gitleaks.tar.gz \
  && git config --system --add safe.directory /config/company \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin wagglebot \
  && mkdir -p /var/cache/wagglebot-memory \
  && chown -R wagglebot:wagglebot /var/cache/wagglebot-memory

WORKDIR /app
COPY package.json bun.lock ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/auth-protocol/package.json packages/auth-protocol/package.json
COPY packages/company-config/package.json packages/company-config/package.json
COPY packages/knowledge/package.json packages/knowledge/package.json
COPY packages/memory-storage/package.json packages/memory-storage/package.json
COPY packages/secret-scanner/package.json packages/secret-scanner/package.json
COPY services/memory-worker/package.json services/memory-worker/package.json
RUN bun install --filter @wagglebot/memory-worker --production --frozen-lockfile

COPY packages/contracts packages/contracts
COPY packages/auth-protocol packages/auth-protocol
COPY packages/company-config packages/company-config
COPY packages/knowledge packages/knowledge
COPY packages/memory-storage packages/memory-storage
COPY packages/secret-scanner packages/secret-scanner
COPY services/database/migration-version.json services/database/migration-version.json
COPY services/memory-worker services/memory-worker
RUN chown -R wagglebot:wagglebot /app

COPY --chmod=0755 services/memory-worker/docker-entrypoint.sh /usr/local/bin/wagglebot-memory-entrypoint
USER wagglebot
EXPOSE 3050
ENTRYPOINT ["/usr/local/bin/wagglebot-memory-entrypoint"]
