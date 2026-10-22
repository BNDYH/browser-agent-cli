# browser-agent-cli

`dt` 用命令行操作本机 Chrome。首次命令惰性启动 daemon，后续命令复用 CDP 连接；默认空闲 30 分钟后断开连接并退出 daemon，保留 Chrome 页面和登录态。

需要 Node.js 20+、本机 Chrome/Chromium。使用 Unix socket，首版面向 macOS/Linux；不下载浏览器内核，不需要扩展。

## 安装与使用

```bash
npm install
npm link
export DT_SESSION=my-session
export DT_TASK=default
dt launch --json
dt goto https://example.com --json
dt snapshot --json
dt kill
```

`npm run demo` 可演示一次完整的 snapshot → 填表 → 保存 → 抓包流程。它启动临时独立 Chrome，结果存于 `artifacts/demo`，十分钟后自动关闭演示实例。

`launch` 使用独立持久 profile，第一次使用需在这个浏览器里登录。它不会复制日常 Chrome 的登录数据。`connect 9222` 可连接已经开启调试端口的 Chrome。

```bash
# macOS 手动启动调试 Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$HOME/.dt-chrome"
dt connect 9222 --json
```

`dt help` 查看命令。命令后可加 `--json`、`--session <id>`、`--task <id>`；环境变量可复用到后续命令。JSON 成功结果写 stdout，错误对象写 stderr 并退出 1。无副作用的 `help` 不启动 daemon。

## 常用命令

| 用途 | 命令 |
| --- | --- |
| 连接 | `launch [--port n] [--profile dir] [--headless]`、`connect [port]`、`status`、`disconnect` |
| 页面 | `tabs`、`use <id>`、`new [url]`、`goto <url>`、`reload`、`back` |
| 观察 | `snapshot [--image]`、`shot [file] [--full-page]`、`title`、`url` |
| 操作 | `click <selector>`、`dblclick <selector>`、`type <selector> <text>`、`fill <selector> <text>`、`select <selector> <value>` |
| 等待 | `wait <selector> [--timeout ms]`、`waitms <ms>` |
| 请求 | `reqs [URL子串或method:POST]`、`req <n>`、`res <n>`、`reqclear`、`har [file] [--no-redact]` |
| 注入 | `eval <js>`、`ls <selector>`、`ck get [key]`、`ck set <key> <value>`、`ck clear [key]`、`ls get [key]`、`ls set <key> <value>` |
| 其他 | `overlay on`、`overlay off`、`run <script.mjs>`、`repl`、`install-skill` |

`type` 逐字符追加；`fill` 替换现有内容；`select` 使用 option 的 value。选择器支持 CSS、`text=文本`、`role=button[name="提交"]`。`ls` 的首参数为 `get` 或 `set` 时访问 localStorage，查询同名 HTML 标签请使用 `css=get` / `css=set`。

## 观察与引用

`snapshot` 读取 Chrome Accessibility tree，返回 `nodes`（语义层级和文本）、`elements`（可操作元素）、`text`（缩进文本）。`elements[].ref` 可原样用作 selector：

```bash
dt snapshot --json
# 使用刚返回的 ref；以下仅为格式示意，请勿照抄不存在的引用
dt fill '[data-dt-ref="dt-snapshot-0123456789ab-0"]' 'Example' --json
dt snapshot --json
```

引用在页面变化或新的 snapshot 后可能失效；元素找不到时重新观察。snapshot 不修改网站原有 ID，并排除 DT 标识。包含同进程 iframe；跨进程 iframe 无法完整读取时返回 warnings。最多返回 2,000 个语义节点。`--image` 返回 PNG base64；`shot` 直接保存 PNG。

## scope 与生命周期

每个 `(DT_SESSION, DT_TASK)` 首次需要页面时创建专属空白 tab。`tabs` 返回 Chrome 的稳定 target ID，`active` 表示该 scope 当前选中的操作目标，不表示系统前台焦点。`use` 不主动激活窗口；`use <id> --activate` 显式打开目标 tab。自动工作台与 `new` 使用后台建页。

未指定 session 时使用状态目录内持久化的本机默认标识；多个 AI 会话应显式使用不同标识。标识允许 1–128 个字母、数字、点、下划线和连字符。

scope 隔离操作目标、请求缓存与标识偏好，不隔离同一浏览器 context 的 cookie/localStorage，也不是访问控制边界。`tabs` 可以看到全局 tab；`use` 可显式选择共享 tab。共享 tab 的新请求会进入当时选中它的各 scope 缓存。同一 tab 的命令排他执行，执行期间续租；冲突返回 `-32003`，不自动重放命令。同一 scope 的并发命令也立即返回冲突。

```bash
dt kill                         # 关闭当前 scope 的专属 tab、清缓存
dt kill --session              # 清理当前 session 的全部 task
dt kill --session another      # 清理指定 session
dt kill --daemon               # 退出 daemon，保留浏览器
dt kill --daemon --browser     # 同时关闭连接中的、由 dt 启动的浏览器
```

`disconnect` 显式断开，随后需要 `connect` 或 `launch`。正常空闲退出或崩溃后的下一次命令会尝试重连原浏览器；保存的 target ID、归属和 overlay 设置可恢复，请求缓存不会恢复。`status` 和事件订阅不会延长空闲时间。

## 抓包、日志与文件

只捕获连接后、scope 选中页面期间的新请求，默认每 scope 最近 500 条。`reqs` 只返回方法/URL/状态/耗时等摘要。`req`/`res` 与 HAR 默认脱敏 Authorization、Cookie、Set-Cookie、Proxy-Authorization 头；URL、查询参数和正文可能仍含敏感内容，HAR 不保证全面脱敏。

请求正文最多保留 64 KiB 字符；响应只保存已知 Content-Length 不超过 64 KiB 的文本内容。二进制、流式或未知长度的响应只保留元数据，并给出 `bodyOmitted` 原因。HAR 是捕获缓存的 HAR 1.2 表示，不是完整的 DevTools 网络归档，协议版本和分段耗时为占位值。

审计日志只记录时间、scope、命令名、tab 和成功状态，不保存命令参数或结果。`eval` 的显式返回值和 cookie/storage 查询结果仍会正常输出给调用者。

文件参数按执行 CLI 时的工作目录解析。默认截图存于 `$DT_STATE_DIR/shots`，默认 HAR 存于状态目录。状态文件和 socket 使用仅当前用户可访问的权限。

## 脚本与 REPL

脚本在 daemon 的 Node.js 进程中执行，是受信任的本地代码，可访问 Node API；不是沙箱。使用 `.mjs` 或 type=module 项目中的 `.js`，默认导出函数：

```js
export default async function ({ page, context }) {
  return { title: await page.title() };
}
```

`dt run script.mjs --json` 返回其结果。脚本不要调用 `process.exit()` 或无限等待；CLI 请求超时不会重放或强制终止仍在执行的脚本。`dt repl --session A --task B --json` 会将启动选项作为内部命令默认值；单行参数可覆盖 scope，但不影响后续命令。JSON 模式不输出提示符，错误 JSON 写 stderr，单条失败后继续。支持引号和空字符串，`exit`/`quit` 退出 REPL。`run` 的失败结果保留原始脚本堆栈，文本错误也输出 selector/URL/标题。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DT_STATE_DIR` | `~/.dt` | 状态、socket、日志、截图 |
| `DT_PROFILE` | `~/.dt-chrome` | 独立 Chrome profile |
| `DT_PORT` | `9222` | loopback CDP 端口 |
| `DT_CHROME_PATH` | 自动探测 | Chrome/Chromium 可执行文件 |
| `DT_SESSION` / `DT_TASK` | 本机持久 session / `default` | 调用 scope |
| `DT_IDLE_TIMEOUT_MS` | `1800000` | daemon 空闲超时 |
| `DT_REQ_CACHE` | `500` | 每 scope 请求容量 |
| `DT_WAIT_TIMEOUT` | `10000` | 导航与元素等待超时 |
| `DT_LOCK_TTL_MS` | `30000` | 命令执行租约，执行期间续租 |

daemon 级配置在启动时读取；修改后需要重启 daemon。CLI 参数优先于 daemon 默认值；scope 参数/环境变量按每次 CLI 调用读取。Chrome 调试端口只能连接 loopback，但本机其他进程仍可访问 CDP。

## skill、事件与验证

`dt install-skill` 或 `npm run install-skill` 将配套 skill 安装到 `~/.claude/skills/browser-control/SKILL.md`，项目安装本身不会修改全局 skill。

事件通过现有 Unix socket 提供：发送一行 `{"jsonrpc":"2.0","id":1,"method":"_subscribe"}` 后持续读取 NDJSON。首先收到 `daemon.status`，随后是 `cmd.start/end`、`tab.change`、`net.req`、`scope.create/destroy` 与 `daemon.heartbeat`。慢订阅者会被断开；重连后获取最新状态。可选菜单栏 companion 已提供当前操作页面的缩略预览，安装与启动见 [companion/README.md](companion/README.md)。截图观察不会延长 daemon 空闲时间。

```bash
npm test
DT_INTEGRATION=1 npm run test:integration
```

集成测试使用随机本机端口、临时独立 profile 和无界面 Chrome，结束时清理它启动的实例；需要允许本机 socket/端口监听及进程启动。普通 `npm run test:integration` 会跳过真实浏览器测试。

## 可选扩展后端与页面小窗

普通 Chrome 已有登录页可通过 `dt extension install` 安装桥接，再由扩展弹窗连接，最后运行 `dt connect --extension`；详细步骤和限制见 [扩展连接说明](docs/extension.md)。

macOS 上执行浏览器操作命令会自动启动页面小窗，后续操作复用已有面板并自动显示。小窗只显示当前操作页面缩略图；抓包与任务管理保留在 CLI。首次使用先安装面板依赖：

```bash
npm --prefix companion ci
```

也可用 `npm --prefix companion start` 单独启动面板。设置 `DT_COMPANION=0` 可关闭 CLI 自动启动；`help`、`status` 和 `kill` 不启动面板。没有安装 Electron 时 CLI 仍可独立使用，面板启动日志位于状态目录下的 `companion.log`。

扩展、窗口和有界面标签页验证分别使用 `DT_EXTENSION_INTEGRATION=1`、`DT_COMPANION_INTEGRATION=1`、`DT_FOCUS_INTEGRATION=1` 配合 `npm run test:integration`。有界面测试需可访问 macOS 桌面。
