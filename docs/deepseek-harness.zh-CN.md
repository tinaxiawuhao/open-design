# DeepSeek Harness × Open Design 适配指南（中文）

本文件面向 fork 的 DeepSeek Harness 运行时适配器（`apps/daemon/src/runtimes/defs/deepseek-harness.ts`），
说明如何安装、配置并接入使用。

> 当前 fork 的适配器为**协议级适配**：Open Design 通过 `dsh` 的
> `--profile open-design --stdio` 子进程协议（dsh-profile JSONL）驱动 Harness。
> 本 fork 尚未移植上游的「一键安装器 / 连接组件」（`od agent setup
> deepseek-harness` 与 `/api/agents/:agentId/companion/install` 路由），
> 因此需要手动完成下列安装步骤。

## 1. 安装 DeepSeek Harness（dsh）

适配器通过 PATH 中的 `dsh` 可执行文件发现 Harness，也可以显式指定环境变量：

- `DSH_BIN`：指向 `dsh` 可执行文件的绝对路径（Windows 下可以是 `dsh.cmd`）。
- `DSH_HOME`：dsh 数据目录（默认 `~/.dsh`）。Open Design 的 profile 位于
  `${DSH_HOME}/profiles/open-design`。

安装方式参考 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)：

```sh
# npm 全局安装（示例）
npm install -g @deepseek-ai/dsh-cmdline
```

安装完成后，确认版本：

```sh
dsh --version
```

> **可发现性（重要）**：Open Design 的「本地 Agent」扫描会先在 PATH 中寻找
> `dsh`。若 `dsh` 不在 PATH（例如以源码方式运行、未全局安装），列表里**不会
> 出现** DeepSeek Harness，此时必须设置 `DSH_BIN`。可在设置对话框（左侧选中
> 「DeepSeek Harness」→ Advanced: proxy & custom paths）填写 `DSH_BIN` /
> `DSH_HOME` 并保存，然后回「本地 Agent」页重新扫描；也可用任意路径的稳定
> wrapper（如 `%USERPROFILE%\.dsh\bin\dsh.cmd`）并把它配到 `DSH_BIN`。

## 2. 安装 open-design runtime 插件

适配器固定使用 `--profile open-design` 启动，该 profile 需要加载
`@open-design/dsh-runtime` 插件（声明 `open-design` runtime 的
probe / models / stdio 协议）。该插件**未发布到 npm**（
`dsh plugin --profile open-design add @open-design/dsh-runtime` 会 404），
需要本地构建后安装。

### 2.1 创建 profile

`dsh plugin --profile open-design` 首次执行时会自动初始化 profile 目录
（位于 `${DSH_HOME}/profiles/open-design`），并把 `@deepseek-ai/dsh-base`
写入 bundle 列表：

```sh
dsh plugin --profile open-design list
```

### 2.2 构建插件（以 0.16.1 fork 仓库为例）

```sh
# 取上游 dsh-runtime 源码，把 package.json 中所有 0.1.0-rc.6 pin 改为 0.1.0-rc.7
cp -r <origin>/packages/dsh-runtime ./dsh-runtime-rc7
cd dsh-runtime-rc7
pnpm install      # 需要可访问 npm registry（npmmirror 也可）
pnpm build        # 产出 dist/{index,startup,invariant}.js
```

> 该插件与 rc.7 API 完全兼容（typecheck 零漂移），仅需调整版本 pin。

### 2.3 安装到 DSH_HOME

```sh
# 把插件包链接到 dsh 的 flat-fallback 依赖目录（一个 bundle 一个包）
# Windows（junction，无需管理员）：
mklink /J "%USERPROFILE%\.dsh\profiles\node_modules\@open-design\dsh-runtime" <dsh-runtime-rc7 绝对路径>
# POSIX（符号链接）：
ln -s <dsh-runtime-rc7 绝对路径> "$HOME/.dsh/profiles/node_modules/@open-design/dsh-runtime"
```

然后编辑 `${DSH_HOME}/profiles/open-design/package.json`，把
`@open-design/dsh-runtime` 追加到 `dsh.profile.bundles`：

```json
{
  "name": "dsh-profile-open-design",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@open-design/dsh-runtime"]
    }
  }
}
```

### 2.4 验证

```sh
dsh --profile open-design --probe
# 应输出：{"v":1,"type":"probe","runtime":"open-design","protocol_version":1,...}
dsh --profile open-design --models
# 应输出模型目录，例如 {"v":1,"type":"models","models":[{"provider":"deepseek-official",...}]}
```

> Windows 上 `--models` 为冷启动探测：dsh 通过 tsx/esbuild 启动并加载整个
> profile，单独执行约 9–13 秒，多路并发扫描时可能更长（见 §4 的缓存说明）。

> 尚未安装插件时，`--probe` / `--models` / `--stdio` 会因 profile 没有可启动的
> runtime 而失败或超时；此时 Open Design 检测仍会报告 agent 可用（版本探测成功），
> 但模型列表回退到默认项，运行任务会报协议错误——请优先完成插件安装。

## 3. 配置 DeepSeek API Key

API Key 在 DeepSeek Harness 自己的 Web UI 中配置，不需要粘贴到 Open Design：

1. 终端运行 `dsh web`，打开 Harness Web UI（默认 `http://127.0.0.1:3080`）。
2. 进入「设置 → 模型 → DeepSeek」，粘贴 API Key 并保存。
   Key 以只写方式保存，页面无法回显明文。
3. 保存后返回 Open Design，无需让 `dsh web` 常驻，运行任务时 Open Design 会自行调用 dsh。

如果没有 API Key，请前往 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建。

> **为什么 Open Design 不收集 Key？** Open Design 自身**不保存任何模型
> API Key**——Key 只存在于 dsh 自己的配置里，模型与凭据全部来自你本机已配置
> 好的 CLI。Open Design 通过 `dsh --profile open-design --models` 读取模型
> 目录，通过 stdio 协议把请求交给 dsh 执行，Key 全程不经过 Open Design。
> 因此用法与本机 CLI 完全一致：**配置好 CLI 后，直接在 Open Design 里选
> CLI、选模型即可，无需重复填 Key**。

## 4. 在 Open Design 中接入

1. 打开「本地 Agent」页面，点击「重新扫描」。
2. 确认「DeepSeek Harness」出现在列表中且状态可用（版本探测成功）。
3. 点击「测试」验证连接；测试失败时会给出具体的错误码与指引（如
   `MISSING_CREDENTIAL` → 回到第 3 步配置 Key）。
4. 测试通过后，在模型选择器中选择 Harness 提供的模型
   （格式为 `provider/model`，例如 `deepseek-official/deepseek-v4-flash`），开始生成。

> **扫描耗时**：模型目录的首次探测需要冷启动 dsh（Windows 约 9–15 秒，多路
> 并发扫描时最长约 60 秒），期间列表可能先显示「Default (CLI config)」。
> 成功获取的目录会以 10 分钟 TTL 缓存，之后每次扫描瞬时返回。

### 支持的能力

- 协议：`dsh-profile-jsonl`（stdio JSONL 帧：probe / ready / session / thinking /
  text / tool_call / tool_result / usage / result / protocol_error）。
- 会话：Harness 自行管理会话 id（`capturesSessionIdFromStream`），Open Design 捕获
  `status` 事件中的 `sessionId` 作为续接句柄，下一轮通过 execute 帧的
  `resume_session_id` 续接，保留工作记忆。
- 取消：通过协议 `cancel` 命令下发。
- 模型列表：`dsh --profile open-design --models`，带 reasoning 选项。

## 5. 环境变量速查

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `DSH_BIN` | `dsh` 可执行文件路径（可选） | PATH 查找 |
| `DSH_HOME` | dsh 数据目录（可选） | `~/.dsh` |
| `DEEPSEEK_API_KEY` | 自动化场景的模型 API Key（Harness 读取） | 无 |

## 6. 常见问题

### Open Design 检测不到 DeepSeek Harness？

- 确认 `dsh --version` 在终端可用；不可用时设置 `DSH_BIN`。
- 确认 profile 已创建：`dsh --profile open-design --probe` 应返回 probe 帧。
- 在「本地 Agent」页面点击「重新扫描」。

### 列表里没有 DeepSeek Harness（只有 OpenCode）？

这是**可发现性问题**：本地 Agent 扫描只识别 PATH 中能找到（或 `DSH_BIN` 显式
指定）的 dsh。若 dsh 未全局安装（例如以源码方式运行），它不会出现在列表里，
需要：

1. 打开设置对话框，左侧选中「DeepSeek Harness」（先确认扫描已把它标记为
   available；若它根本没出现，说明 `DSH_BIN` 未生效）。
2. 在 Advanced: proxy & custom paths 中填写 `DSH_BIN`（例如
   `C:\Users\<你>\.dsh\bin\dsh.cmd`）与 `DSH_HOME`，保存。
3. 回「本地 Agent」页重新扫描，DeepSeek Harness 即会出现在列表中。

另外注意：DeepSeek Harness 是**本地 CLI 代理**，不会出现在「自带密钥
（BYOK）」页面——BYOK 页面按设计只列出 BYOK OpenCode 一个代理；本地 CLI
代理统一在「本地 Agent」页管理。

### 模型列表长时间只有「Default (CLI config)」？

- 首次扫描需要冷启动 dsh（约 9–15 秒，并发时最长约 60 秒），请稍候并再次
  刷新/重新扫描；成功后结果会缓存 10 分钟。
- 若始终只有默认项，在终端运行 `dsh --profile open-design --models` 确认能
  输出模型目录；失败说明插件未装好（见 §2）。

### 测试报 `MISSING_CREDENTIAL` / `DSH_PROVIDER_AUTH_FAILED`？

API Key 尚未配置。运行 `dsh web`，在「设置 → 模型 → DeepSeek」中保存 Key 后重试。

### 测试报 `DSH_PROFILE_RESUME_REJECTED`？

上一轮的会话句柄已失效（例如 profile 数据被清理）。Open Design 会清除该句柄并在
同一轮自动以新会话重试；若重试仍失败，请确认 profile 目录完好。

## 7. 后续路线（fork 尚未包含）

- `od agent setup deepseek-harness` 一键安装命令与安装向导（把第 2 节的
  构建 + 链接 + 配置步骤封装成 CLI）。
- `/api/agents/:agentId/companion/install` 安装路由与连接组件安装提示。
- 一键安装脚本与发布地址（`open-design.ai/install-dsh.*`）。
- `@open-design/dsh-runtime` 发布到 npm 后，`dsh plugin --profile open-design add`
  可直接安装（当前未发布，镜像上亦无 rc.6 版本，只有 rc.7）。
