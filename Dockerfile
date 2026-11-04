# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 网鉴 VeriPage · 自托管部署镜像（完整版：含 Playwright chromium 沙箱代访）
#
# 为什么必须自带浏览器：闸门②沙箱代访（lib/tools/fetch-page.ts）用 Playwright
# 无头浏览器打开目标页取证，镜像里必须同时装齐 chromium 二进制与系统依赖，
# 缺任何一个库，chromium.launch() 都会在容器里直接失败。
#
# 隔离基线（审计 F03）：运行阶段以专用非 root 用户 veripage（uid/gid=10001）
# 运行，Chromium 保留 OS 级沙箱（fetch-page.ts 默认 chromiumSandbox=true）。
# 隔离边界的完整「已建立 / 未建立」清单见 README「安全边界」一节。
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

# Playwright chromium 的系统依赖清单（Debian slim 基线，缺一个 launch 即失败）。
# fonts-noto-cjk（审计 F17）：服务端取证截图需要中文字形——缺 CJK 字库时中文页面
# 的整页截图全是 .notdef 方框，视觉模型拿不到有效证据（这不是用户桌面字体问题）。
# Noto CJK 采用 SIL OFL 1.1 许可，允许随镜像再分发。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      fonts-noto-cjk \
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

# ---- 非 root 专用用户（审计 F03）--------------------------------------------
# 服务进程与 Chromium 取证浏览器都不再以 root 运行；固定 uid/gid=10001 便于
# 宿主挂载卷时对齐权限。node:22-slim（Debian）自带 groupadd/useradd（passwd 包）。
# 独立 home 目录给 Chromium 运行期写临时文件；--shell nologin 禁止交互登录。
RUN groupadd --gid 10001 veripage \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin veripage

# 构建产物 + node_modules + knowledge/ 数据文件（next start 运行所需全集）
# --chown：next start 运行期要写 .next/cache，低权用户必须拥有 /app
COPY --from=builder --chown=10001:10001 /app ./
# 浏览器二进制（构建期下载到 /ms-playwright，与上面 ENV 一致）。截图等短期
# 证据产物写 os.tmpdir()（/tmp，容器内 1777），非 root 可写，无需额外授权。
COPY --from=builder --chown=10001:10001 /ms-playwright /ms-playwright

# 切非 root：此后仅剩 EXPOSE/CMD，容器主进程 UID=10001。非 root 下 Chromium 的
# user namespace 沙箱可用——不要在镜像或 compose 里设置 VERIPAGE_BROWSER_NO_SANDBOX
# 逃生阀（该变量仅留给个别内核未开 user namespace 的特殊环境，见
# lib/tools/fetch-page.ts 的风险说明）。
USER veripage

EXPOSE 3000
# 直接用 node 起 next start：不在运行期依赖 corepack/pnpm（避免容器启动时联网找 pnpm）
CMD ["node", "node_modules/next/dist/bin/next", "start"]
