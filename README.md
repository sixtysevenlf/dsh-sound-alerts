# @dsh-external/dsh-sound-alerts

DSH Web UI 声音提示插件（browser client bundle，`platform: web`）。

当以下事件发生时播放合成提示音（Web Audio 合成，无需音频资源）：

| 事件 | 声音 | 触发源 |
| --- | --- | --- |
| 需要授权（沙箱/命令审批） | 双音 ×2（急切） | 会话 `pendingInteraction === 'approval'`（`approval/requested` 帧） |
| 需要回答问题（ask_user_question） | 单次双音（柔和） | 会话 `pendingInteraction` 为 `question` / `plan-review` |
| 任务/运行完成 | 三连胜利音 | 会话 `running` true→false（2.5s 复检）或后台会话 `completed` 标记 |
| goal 完成 | 四音胜利收尾 | 当前会话 goal 投影 phase → `complete` |

声音在浏览器标签页中播放（含后台标签页），首次点击/按键后解锁 AudioContext。

## 设置

设置 → 通用 → "声音提示 (Sound Alerts)"：总开关 + 音量滑杆。
持久化于 localStorage 键 `dsh-sound-alerts:settings`：
`{ "enabled": true, "volume": 0.45, "approval": true, "done": true, "goal": true }`

## 结构

- `src/index.ts` — node half：空 apply（纯 UI 插件，让行出现在 host Loader）。
- `src/client/index.ts` — 浏览器 half：声音引擎 + sessions 监视 + 设置行。
- `cordis.patch.yml` — bundle patch：向 Web 装配树插入名录行 `sound-alerts`。
- `dsh.bundle.patch` — 使本包作为 profile bundle 层装配（dependencies + bundles）。

## 构建与安装

```bash
# 构建（node half: tsc；client half: tsdown → lib/client.js）
npm install
bash scripts/build.sh        # DSH_CHECKOUT 自动探测（$HOME/dsh-harness）
npm run build:client

# 注入器环境内热装配（改 profile package.json + junction + loader.create）
dev_install_package D:/DSH/plugins/dsh-sound-alerts
```

安装后刷新浏览器页面：启动图 `window.__DSH_BOOT__` 会包含本包 client.js，
声音即生效（新名录行需一次刷新，之后 HMR 管内容热更）。
