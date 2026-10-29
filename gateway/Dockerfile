# Satuwork Gateway。
#
# 构建上下文是**仓库根目录**（compose 里 context: .），但镜像里**不放 bot 源码**：
# Gateway 不构建 Bot，发布包由 CI 传上来。这里只拷 bot/package.json，是为了让 pnpm
# workspace 和 lockfile 对得上。
FROM node:24-bookworm-slim

# 席位部署不再从这个镜像发起——机器上常驻的管家自己做，所以 openssh-client 和
# sshpass 都不需要了。tar 也不装：镜像里不打包，上传上来的包用 Node 自己的 zlib
# 流式校验。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# 先只拷清单，依赖层能被缓存住，改代码不用重装。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY gateway/package.json gateway/
COPY bot/package.json bot/
COPY manager/package.json manager/
RUN pnpm install --frozen-lockfile

COPY gateway/ gateway/
# Gateway 与管家中继共用的内容策略，运行时也会直接导入。
COPY manager/src/content-policy.ts manager/src/

# 数据目录只放 JWT 密钥对和 Bot 发布包，业务数据在 PostgreSQL。
ENV SATUWORK_GATEWAY_HOME=/var/lib/satuwork-gateway
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=3080
# 源码打包只给本地开发用。镜像里本来就没有源码，这里再明写一道。
RUN mkdir -p /var/lib/satuwork-gateway

WORKDIR /app/gateway
EXPOSE 3080

# 容器里不用 pnpm 转一层，信号能直接送到 node。
CMD ["node", "--import", "tsx", "src/index.ts"]
