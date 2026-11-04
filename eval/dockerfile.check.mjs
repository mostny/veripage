/**
 * F03 / F17 静态验收：Dockerfile 与 docker-compose.yml 的隔离/字体配置断言。
 *
 * 运行：node eval/dockerfile.check.mjs（零网络、零构建、只读仓库文件）
 *
 * 背景：本机（Windows）没有 Docker，审计的 docker build 检查是在 Linux 上做的。
 * 本脚本做文件级验证替代：非 root USER 位置、目录属主、逃生阀不进镜像、
 * CJK 字体包、compose 的 user/no-new-privileges 一致性。
 * launch 参数的行为断言（默认含沙箱）见 eval/deploy-config.smoke.ts。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfile = await readFile(path.join(ROOT, "Dockerfile"), "utf8");
const compose = await readFile(path.join(ROOT, "docker-compose.yml"), "utf8");
const fetchPageSource = await readFile(path.join(ROOT, "lib", "tools", "fetch-page.ts"), "utf8");

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

/** 取最后一个匹配指令的位置（-1 表示不存在）；逐行匹配，忽略续行 */
const lastIndex = (source, instruction) => {
  let index = -1;
  for (const match of source.matchAll(new RegExp(`^${instruction}\\b`, "gm"))) index = match.index;
  return index;
};

// --- F17：取证浏览器中文字体 ---------------------------------------------------
assert.match(
  dockerfile,
  /^\s+fonts-noto-cjk\s*\\?\s*$/m,
  "Dockerfile 的 apt 安装清单必须包含 fonts-noto-cjk（Debian 系包名；Noto CJK，SIL OFL 1.1 许可）",
);
ok("F17 Dockerfile 安装 fonts-noto-cjk（容器 fc-list :lang=zh 不再为空）");

// --- F03：Dockerfile 非 root 用户 ---------------------------------------------
const uid = dockerfile.match(/useradd\s+--uid\s+(\d+)/)?.[1];
assert.ok(uid, "Dockerfile 必须用 useradd 创建专用非 root 用户");
assert.match(dockerfile, new RegExp(`groupadd\\s+--gid\\s+${uid}\\s+veripage`), "groupadd 的 gid 必须与 useradd 的 uid 一致");
assert.match(dockerfile, /useradd[^\\\n]*--create-home/, "专用用户必须有独立 home（Chromium 运行期临时文件）");

const userDirectives = [...dockerfile.matchAll(/^USER\s+(\S+)\s*$/gm)];
assert.ok(userDirectives.length > 0, "Dockerfile 必须有 USER 指令切换非 root");
const lastUser = userDirectives[userDirectives.length - 1];
assert.equal(lastUser[1], "veripage", `最后的 USER 必须是专用用户 veripage（实际 ${lastUser[1]}）`);
assert.ok(lastIndex(dockerfile, "RUN") < lastUser.index, "USER 必须位于最后一条 RUN 之后（此前指令以 root 执行完装配）");
assert.ok(lastIndex(dockerfile, "COPY") < lastUser.index, "USER 必须位于最后一条 COPY 之后");
const afterUser = dockerfile.slice(lastUser.index + lastUser[0].length);
assert.doesNotMatch(
  afterUser,
  /^(RUN|COPY|ADD|ENV|ENTRYPOINT|USER|WORKDIR)\b/m,
  "USER 之后不得再出现会以 root 执行的构建指令（保证容器主进程 UID 非 0）",
);
ok(`F03 Dockerfile 非 root：useradd veripage(uid=${uid})，USER 在所有 RUN/COPY 之后、仅剩 EXPOSE/CMD`);

// --- F03：低权用户的写权限（.next/cache、截图产物） ----------------------------
assert.match(
  dockerfile,
  new RegExp(`COPY\\s+--from=builder\\s+--chown=${uid}:${uid}\\s+/app\\s+\\./`),
  "/app 必须 chown 给非 root 用户（next start 运行期要写 .next/cache）",
);
assert.match(
  dockerfile,
  new RegExp(`COPY\\s+--from=builder\\s+--chown=${uid}:${uid}\\s+/ms-playwright`),
  "/ms-playwright 必须 chown 给非 root 用户（Chromium 自更新/崩溃转储等写入）",
);
ok(`F03 Dockerfile 写权限：/app 与 /ms-playwright 以 --chown=${uid}:${uid} 复制`);

// --- F03：逃生阀不得进镜像/compose --------------------------------------------
for (const [name, text] of [["Dockerfile", dockerfile], ["docker-compose.yml", compose]]) {
  assert.doesNotMatch(
    text,
    /VERIPAGE_BROWSER_NO_SANDBOX\s*[=:]\s*["']?1/,
    `${name} 不得设置 VERIPAGE_BROWSER_NO_SANDBOX（非 root 下 Chromium 沙箱可用；注释里提及该变量属说明文字）`,
  );
}
ok("F03 逃生阀未配置进 Dockerfile / docker-compose.yml（默认保留浏览器沙箱）");

// --- F03：源码级双保险（行为断言在 deploy-config.smoke.ts） ---------------------
const launchCalls = [...fetchPageSource.matchAll(/chromium\.launch\(\s*([^)\n]{1,120})/g)];
assert.ok(launchCalls.length > 0, "lib/tools/fetch-page.ts 必须能定位 chromium.launch 调用");
for (const call of launchCalls) {
  assert.ok(
    call[1].startsWith("buildChromiumLaunchPlan"),
    `chromium.launch 参数必须经 buildChromiumLaunchPlan 构造，不得内联写死（实际：${call[1].trim()}）`,
  );
}
// --no-sandbox 只允许出现在「严格 === "1"」的逃生阀分支里；默认分支必须显式开沙箱
assert.match(
  fetchPageSource,
  /noSandboxEnv === "1"\s*\?\s*\{\s*headless:\s*true,\s*chromiumSandbox:\s*false,\s*args:\s*\[\s*"--no-sandbox"\s*\]\s*\}/,
  "逃生阀分支：仅 noSandboxEnv === \"1\" 时才 chromiumSandbox:false + --no-sandbox",
);
assert.match(
  fetchPageSource,
  /:\s*\{\s*headless:\s*true,\s*chromiumSandbox:\s*true,\s*args:\s*\[\s*\]\s*\}/,
  "默认分支：chromiumSandbox 显式 true（Playwright 原生默认 false，不显式开等于没开）且 args 为空",
);
ok("F03 fetch-page：launch 参数经 buildChromiumLaunchPlan；--no-sandbox 仅存在于严格 \"1\" 的逃生阀分支");

// --- F03：compose 与 Dockerfile 一致 ------------------------------------------
assert.match(
  compose,
  new RegExp(`^\\s*user:\\s*["']?${uid}:${uid}["']?\\s*$`, "m"),
  `docker-compose.yml 的 user 必须与 Dockerfile uid:gid（${uid}:${uid}）一致`,
);
assert.match(compose, /no-new-privileges:\s*true/, "compose 必须配置 security_opt: no-new-privileges:true");
assert.match(compose, /独立.{0,6}网络出口|网络出口/, "compose 必须注释说明生产环境的独立网络出口建议（本轮未建立）");
ok(`F03 compose：user ${uid}:${uid} 与 Dockerfile 一致 + no-new-privileges:true + 出口隔离建议注释`);

console.log(`\nALL-PASS（${passed} 项静态断言全部通过；本脚本不替代 Linux 上的 docker build 实测）`);
