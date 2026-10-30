# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 网鉴 VeriPage · 自托管部署镜像（完整版：含 Playwright chromium 沙箱代访）
#
# 为什么必须自带浏览器：闸门②沙箱代访（lib/tools/fetch-page.ts）用 Playwright
# 无头浏览器打开目标页取证，镜像里必须同时装齐 chromium 二进制与系统依赖，
# 缺任何一个库，chromium.launch() 都会在容器里直接失败。
#
# PLAYWRIGHT_BROWSERS_PATH=/ms-playwright：浏览器固定装在镜像层，容器启动
# 不再联网下载；不设置时 Playwright 会去 $HOME/.cache/ms-playwright 找，
# 容器里必然找不到。构建期与运行期必须写同一个值。
# ---------------------------------------------------------------------------

# ---- 阶段 1：安装依赖 --------------------------------------------------------
# pnpm 默认不跑依赖的 postinstall（pnpm-workspace.yaml 未放行 playwright），
# 浏览器不会在 install 时被下载；仍显式跳过，双保险。
FROM node:22-slim AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

# ---- 阶段 2：下载 chromium + 生产构建 ----------------------------------------
FROM deps AS builder
WORKDIR /app
COPY . .
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm exec playwright install chromium
RUN pnpm build

# ---- 阶段 3：运行镜像（系统依赖 + 浏览器 + 构建产物） -------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Playwright chromium 的系统依赖清单（Debian slim 基线，缺一个 launch 即失败）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libapparmor1 \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# 构建产物 + node_modules + knowledge/ 数据文件（next start 运行所需全集）
COPY --from=builder /app ./
# 浏览器二进制（构建期下载到 /ms-playwright，与上面 ENV 一致）
COPY --from=builder /ms-playwright /ms-playwright

EXPOSE 3000
# 直接用 node 起 next start：不在运行期依赖 corepack/pnpm（避免容器启动时联网找 pnpm）
CMD ["node", "node_modules/next/dist/bin/next", "start"]
