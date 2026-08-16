# @dsh-external/dsh-sound-alerts

DSH Web UI 声音提示插件（browser client bundle，`platform: web`）。

当以下事件发生时播放提示音：

| 事件 | 默认声音 | 触发源 |
| --- | --- | --- |
| 需要授权（沙箱/命令审批） | 双音 ×2（急切） | 会话 `pendingInteraction === 'approval'`（`approval/requested` 帧） |
| 需要回答问题（ask_user_question） | 单次双音（柔和） | 会话 `pendingInteraction` 为 `question` / `plan-review` |
| 任务/运行完成 | 三连胜利音 | 会话 `running` true→false（2.5s 复检）或后台会话 `completed` 标记 |
| 任务失败 | 关羽之歌（合成致敬版） | 当前会话 `lastAgentError` 从无到有（`host/agent-error` 帧） |
| goal 完成 | 四音胜利收尾 | 当前会话 goal 投影 phase → `complete` |

默认音全部由 Web Audio 合成（无音频资源）；声音在浏览器标签页中播放（含后台
标签页），首次点击/按键后解锁 AudioContext。

## 自定义声音

设置 → 通用 → "声音提示 (Sound Alerts)"，每个事件一行：

```
需要授权    [上传] [试听] [清除] 自定义文件名.mp3
```

- **上传**：本地音频文件（mp3/wav/ogg/m4a/flac，≤10MB），以 dataURL 存入
  IndexedDB（不占 localStorage 配额，刷新/重启不丢）
- **试听**：有自定义播自定义，无自定义播内置合成音
- **清除**：删除自定义音频，恢复内置音
- **自动回退**：自定义音频加载/播放失败时静默回退内置合成音

播放时音量跟随滑杆；全局 1.2s 防抖避免批量事件轰炸。

## 设置

总开关 + 音量滑杆 + 各事件开关/上传/试听/清除，持久化于
localStorage 键 `dsh-sound-alerts:settings`。

## 诊断

`console.debug('[sound-alerts]', ...)` + `window.__soundAlertsLog`（最近 100 条）。

## 结构

- `src/index.ts` — node half：空 apply（纯 UI 插件，让行出现在 host Loader）。
- `src/client/index.ts` — 浏览器 half：声音引擎 + sessions 监视 + 设置行 + 自定义音频。
- `cordis.patch.yml` — bundle patch：向 Web 装配树插入名录行 `sound-alerts`。
- `dsh.bundle.patch` — 使本包作为 profile bundle 层装配（dependencies + bundles）。

## 构建与安装

```bash
# 依赖（esbuild 构建 client；--legacy-peer-deps 跳过内部 rc 包的 peer 自动安装）
npm install --legacy-peer-deps

# 构建（node half: tsc via scripts/build.sh；client half: esbuild via scripts/build-client.mjs）
bash scripts/build.sh        # DSH_CHECKOUT 自动探测（$HOME/dsh-harness）
npm run build:client

# 注入器环境内热装配（改 profile package.json + junction + loader.create）
dev_install_package D:/DSH/plugins/dsh-sound-alerts
```

安装后刷新浏览器页面：启动图 `window.__DSH_BOOT__` 会包含本包 client.js，
声音即生效（新名录行需一次刷新，之后 HMR 管内容热更）。
