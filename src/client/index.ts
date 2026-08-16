/**
 * @dsh-external/dsh-sound-alerts — 浏览器端声音提示。
 *
 * 事件源（全部来自 client-runtime 的 sessions 服务，无需任何宿主 RPC）：
 *
 * 1. 需要授权 / 需要提问（"需要我授权权限"）
 *    - 会话列表条目出现 pendingInteraction：
 *      "approval"  = 沙箱/命令权限审批（approval/requested 帧）；
 *      "question" / "plan-review" = ask_user_question 提问（question/requested 帧）。
 *    → 播放"注意"提示音（授权为双音重复，提问为单次双音）。
 *
 * 2. 任务 / 运行完成（"项目完成"）
 *    - 会话 running true→false（列表快照）或 turnEnds 增长（会话事件）：
 *      延迟 2.5s 复检（排队间隙不误报）后播三连胜利音；
 *    - 后台会话出现 completed 标记（侧栏绿色"done"提醒）：播三连胜利音；
 *    - 当前会话 goal 投影 phase → "complete"：播放四音胜利收尾。
 *
 * 3. 任务失败
 *    - 当前会话 lastAgentError 从 null → 字符串（host/agent-error 帧）：
 *      播放关羽之歌（D 羽调五声音阶合成致敬版，悲壮进行曲）。
 *
 * 4. 自定义声音
 *    - 每个事件（授权/提问/完成/失败/goal）可上传自己的音频文件：
 *      文件以 dataURL 存入 IndexedDB（不占 localStorage 配额），设置里只存元信息；
 *      播放时优先用自定义音频，加载/播放失败自动回退内置合成音。
 *    - 试听按钮：有自定义播自定义，无自定义播默认音。
 *
 * 5. 设置
 *    - 设置 → 通用 面板：总开关 + 音量 + 各事件开关/上传/试听/清除
 *      （settings.general.item slot）；持久化于 localStorage（dsh-sound-alerts:settings）。
 *
 * 6. 诊断
 *    - console.debug('[sound-alerts]', ...) + window.__soundAlertsLog 最近 100 条。
 *
 * 浏览器自动播放策略：AudioContext 懒创建，首次 pointerdown/keydown 手势解锁；
 * 后台标签页仍可出声（这正是提醒场景）。resume() 竞态已处理（异步恢复后补播）。
 * 自定义音频走 <audio> 元素，页面有过用户激活即可后台播放。
 *
 * 构建：npm run build:client（esbuild → lib/client.js，ModuleLoader.load 注册）。
 */
import { createElement, useRef, useState } from 'react'

const SETTINGS_KEY = 'dsh-sound-alerts:settings'

/** 可自定义声音的事件类型 */
export type SoundEvent = 'approval' | 'question' | 'done' | 'error' | 'goal'

/** 自定义声音元信息（音频本体存 IndexedDB；url 分支为将来粘贴链接预留） */
export interface CustomSound {
  source: 'file' | 'url'
  /** 显示名（文件名或 URL） */
  name: string
  /** source === 'url' 时的音频地址 */
  url?: string
}

export interface SoundSettings {
  /** 总开关 */
  enabled: boolean
  /** 音量 0..1 */
  volume: number
  /** 授权/提问提示音 */
  approval: boolean
  /** 任务/运行完成提示音 */
  done: boolean
  /** goal 完成提示音 */
  goal: boolean
  /** 任务失败提示音（关羽之歌） */
  error: boolean
  /** 各事件自定义声音（缺省 = 内置合成音） */
  custom: Partial<Record<SoundEvent, CustomSound>>
}

const DEFAULT_SETTINGS: SoundSettings = {
  enabled: true,
  volume: 0.45,
  approval: true,
  done: true,
  goal: true,
  error: true,
  custom: {},
}

function loadSettings(): SoundSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<SoundSettings>
      return { ...DEFAULT_SETTINGS, ...parsed, custom: parsed.custom ?? {} }
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings: SoundSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* storage unavailable — keep in-memory value */
  }
}

// ── IndexedDB：自定义音频本体（dataURL）──────────────────────────────────────

const IDB_NAME = 'dsh-sound-alerts'
const IDB_STORE = 'custom'
const MAX_CUSTOM_BYTES = 10 * 1024 * 1024

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function idbGet(key: string): Promise<unknown> {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbDel(key: string): Promise<void> {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── 诊断 ─────────────────────────────────────────────────────────────────────

type DebugEntry = { t: number; msg: string; data?: string }

function dbg(msg: string, data?: unknown): void {
  const entry: DebugEntry = { t: Date.now(), msg, data: data === undefined ? undefined : typeof data === 'string' ? data : safeString(data) }
  const log = (window as unknown as { __soundAlertsLog?: DebugEntry[] }).__soundAlertsLog ?? []
  log.push(entry)
  if (log.length > 100) log.shift()
  ;(window as unknown as { __soundAlertsLog: DebugEntry[] }).__soundAlertsLog = log
  console.debug('[sound-alerts]', msg, entry.data ?? '')
}

function safeString(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}

// ── Web Audio 合成引擎（无音频资源，正弦/三角波合成，包络防爆音）────────────

let audioContext: AudioContext | null = null

function ensureAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (Ctor === undefined) return null
  if (audioContext === null) audioContext = new Ctor()
  return audioContext
}

interface Note {
  freq: number
  start: number
  dur: number
  type?: OscillatorType
  gain?: number
}

function scheduleNotes(ctx: AudioContext, notes: Note[], volume: number): void {
  for (const note of notes) {
    const { freq, start, dur, type = 'sine', gain = 0.9 } = note
    const osc = ctx.createOscillator()
    const amp = ctx.createGain()
    osc.type = type
    osc.frequency.value = freq
    const t0 = ctx.currentTime + start
    const g = Math.min(0.9, Math.max(0.001, volume * gain))
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(g, t0 + 0.02)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(amp).connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + dur + 0.05)
  }
}

/**
 * 播放旋律。AudioContext 处于 suspended 时先 resume（异步），恢复后再补播；
 * 避免 Chrome 自动挂起（后台/节能）导致静默丢失。
 */
function playMelody(notes: Note[], volume: number): void {
  const ctx = ensureAudio()
  if (ctx === null) {
    dbg('play skipped: no AudioContext')
    return
  }
  if (ctx.state === 'running') {
    scheduleNotes(ctx, notes, volume)
    return
  }
  dbg('audio suspended, resuming', ctx.state)
  if (ctx.state === 'suspended') {
    void ctx.resume().then(() => {
      if (ctx.state === 'running') scheduleNotes(ctx, notes, volume)
      else dbg('resume failed to reach running', ctx.state)
    }).catch((error) => dbg('resume error', String(error)))
  }
}

/** 授权待审批：双音 ×2（急切） */
const ATTENTION_APPROVAL: Note[] = [
  { freq: 932, start: 0, dur: 0.22, type: 'triangle' },
  { freq: 659, start: 0.26, dur: 0.3, type: 'triangle' },
  { freq: 932, start: 0.6, dur: 0.22, type: 'triangle' },
  { freq: 659, start: 0.86, dur: 0.42, type: 'triangle' },
]

/** 提问待回答：单次双音（柔和） */
const ATTENTION_QUESTION: Note[] = [
  { freq: 784, start: 0, dur: 0.2, type: 'triangle' },
  { freq: 587, start: 0.24, dur: 0.34, type: 'triangle' },
]

/** 任务/运行完成：三连胜利音（523→659→784） */
const DONE: Note[] = [
  { freq: 523, start: 0, dur: 0.16 },
  { freq: 659, start: 0.18, dur: 0.16 },
  { freq: 784, start: 0.36, dur: 0.3 },
]

/** goal 完成：胜利三连音 + 高音收尾 */
const VICTORY: Note[] = [
  { freq: 523, start: 0, dur: 0.16 },
  { freq: 659, start: 0.18, dur: 0.16 },
  { freq: 784, start: 0.36, dur: 0.18 },
  { freq: 1047, start: 0.56, dur: 0.5 },
]

/**
 * 任务失败：关羽之歌（致敬版）。
 * D 羽调五声音阶 + 低音鼓的悲壮进行曲，合成自 Web Audio（无版权音频）。
 * 结构：前奏鼓点 ×4 → 主题下行乐句 ×2（第二遍带长音收尾）→ 鼓点收束。
 */
const GUAN_YU: Note[] = [
  // 前奏：四记战鼓
  { freq: 73.4, start: 0, dur: 0.14, type: 'sine', gain: 1 },
  { freq: 73.4, start: 0.36, dur: 0.14, type: 'sine', gain: 1 },
  { freq: 73.4, start: 0.72, dur: 0.14, type: 'sine', gain: 1 },
  { freq: 73.4, start: 1.08, dur: 0.16, type: 'sine', gain: 1.1 },
  // 低音持续（悲壮底色）
  { freq: 146.83, start: 1.4, dur: 3.5, type: 'sine', gain: 0.5 },
  // 主题 A：D5 C5 A4 F5 E5 D5（号角式下行）
  { freq: 587.33, start: 1.4, dur: 0.3, type: 'triangle', gain: 1 },
  { freq: 523.25, start: 1.74, dur: 0.2, type: 'triangle', gain: 0.9 },
  { freq: 440, start: 2.0, dur: 0.42, type: 'triangle', gain: 0.95 },
  { freq: 698.46, start: 2.48, dur: 0.24, type: 'triangle', gain: 1 },
  { freq: 659.25, start: 2.76, dur: 0.16, type: 'triangle', gain: 0.9 },
  { freq: 587.33, start: 2.96, dur: 0.5, type: 'triangle', gain: 1 },
  // 主题 B：A4 C5 D5 长音 + 收束
  { freq: 440, start: 3.52, dur: 0.2, type: 'triangle', gain: 0.9 },
  { freq: 523.25, start: 3.76, dur: 0.16, type: 'triangle', gain: 0.9 },
  { freq: 587.33, start: 3.96, dur: 0.7, type: 'triangle', gain: 1.05 },
  // 收束：低音鼓 + 根音长鸣
  { freq: 73.4, start: 4.72, dur: 0.16, type: 'sine', gain: 1.1 },
  { freq: 146.83, start: 4.72, dur: 0.9, type: 'sine', gain: 0.6 },
]

/** 各事件的内置回退音 */
const FALLBACKS: Record<SoundEvent, Note[]> = {
  approval: ATTENTION_APPROVAL,
  question: ATTENTION_QUESTION,
  done: DONE,
  error: GUAN_YU,
  goal: VICTORY,
}

// ── 播放入口（内置合成 + 自定义音频）──────────────────────────────────────────

/** 全局防抖：1.2s 内最多一声，避免批量完成/多会话同时触发时轰炸 */
let lastPlayAt = 0

/** 播放自定义音频（dataURL 来自 IndexedDB；url 分支预留）。失败返回 false。 */
async function playCustomAudio(event: SoundEvent, custom: CustomSound, volume: number): Promise<boolean> {
  try {
    let src: string | undefined
    if (custom.source === 'url' && typeof custom.url === 'string' && custom.url.length > 0) {
      src = custom.url
    } else if (custom.source === 'file') {
      const stored = await idbGet('custom:' + event) as { dataUrl?: string } | undefined
      if (stored !== undefined && typeof stored.dataUrl === 'string') src = stored.dataUrl
    }
    if (src === undefined) return false
    const audio = new Audio(src)
    audio.volume = Math.min(1, Math.max(0, volume))
    await audio.play()
    return true
  } catch {
    return false
  }
}

/**
 * 事件播放统一入口：防抖 → 自定义音频优先 → 失败/缺省回退内置合成音。
 */
function playEvent(event: SoundEvent, volume: number, reason: string): void {
  const now = Date.now()
  if (now - lastPlayAt < 1200) {
    dbg('play throttled', reason)
    return
  }
  lastPlayAt = now
  dbg('play', reason)
  const settings = loadSettings()
  const custom = settings.custom?.[event]
  if (custom !== undefined) {
    void (async () => {
      const ok = await playCustomAudio(event, custom, settings.volume)
      if (!ok) {
        dbg('custom audio failed, fallback to builtin', `${event}: ${custom.name}`)
        playMelody(FALLBACKS[event], settings.volume)
      }
    })()
  } else {
    playMelody(FALLBACKS[event], settings.volume)
  }
}

// ── 会话监视 ─────────────────────────────────────────────────────────────────

interface ListSnapshot {
  ids: string[]
  byId: Record<string, {
    id: string
    running?: boolean
    completed?: boolean
    pendingInteraction?: string
  }>
  current?: string
}

interface SessionLike {
  sessionId: string
  subscribe(fn: () => void): () => void
  getSnapshot(): { turnEnds?: { size?: number }; lastAgentError?: string | null }
  projections?: { get(key: string): { goal?: { id?: string; phase?: string } } | undefined }
}

interface SessionsService {
  list: {
    subscribe(fn: () => void): () => void
    getSnapshot(): ListSnapshot
  }
  binding(id: string): { session: SessionLike } | undefined
}

type ClientCtx = {
  effect(fn: () => (() => void) | void, name?: string): void
  get(name: string): unknown
}

export function apply(ctx: ClientCtx): void {
  dbg('apply start')

  // 首次用户手势解锁 AudioContext（浏览器自动播放策略；后台标签页不受影响）
  const unlock = (): void => { ensureAudio() }
  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('keydown', unlock)
  ctx.effect(() => {
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, 'sound-alerts: unlock')

  // 受控延迟器：fiber 卸载时清空
  const timers = new Set<number>()
  const later = (fn: () => void, ms: number): void => {
    const id = window.setTimeout(() => { timers.delete(id); fn() }, ms)
    timers.add(id)
  }
  ctx.effect(() => {
    return () => {
      for (const id of timers) window.clearTimeout(id)
      timers.clear()
    }
  }, 'sound-alerts: timers')

  const start = (sessions: SessionsService): void => {
    const seenInteraction = new Map<string, string>()
    const completedNotified = new Set<string>()
    const runningStates = new Map<string, boolean>()

    let currentId: string | undefined
    let currentSession: SessionLike | undefined
    let unsubSession: (() => void) | undefined
    let lastGoalId: string | undefined
    let lastGoalPhase: string | undefined
    let lastTurnEnds = 0
    /** 最近观察到的 lastAgentError（快照引用/字符串），用于失败边缘检测 */
    let lastError: string | null = null
    /** 失败音时间窗：同一失败信息 20s 内不重复播放（防 reconnect 重发/重建误报） */
    let lastErrorPlayedAt = 0

    /** 检查当前会话 goal 相位（投影帧只触发 list notifier，因此 onList 与 onSession 都会调）。 */
    const checkGoal = (source: string): void => {
      if (currentSession === undefined) return
      const settings = loadSettings()
      if (!settings.enabled || !settings.goal) return
      const projection = currentSession.projections?.get('goal')
      const goal = projection?.goal
      if (goal === undefined || goal === null) {
        if (lastGoalId !== undefined || lastGoalPhase !== undefined) dbg('goal cleared', source)
        lastGoalId = undefined
        lastGoalPhase = undefined
        return
      }
      if (goal.id !== lastGoalId) {
        dbg('goal changed', `${source}: ${goal.id} phase=${goal.phase}`)
        lastGoalId = goal.id
        lastGoalPhase = goal.phase
      } else if (goal.phase !== lastGoalPhase) {
        dbg('goal phase transition', `${source}: ${lastGoalPhase} -> ${goal.phase}`)
        if (goal.phase === 'complete') playEvent('goal', settings.volume, 'goal-complete')
        lastGoalPhase = goal.phase
      }
    }

    const onSession = (): void => {
      if (currentSession === undefined) return
      const snap = currentSession.getSnapshot()
      // 兜底完成信号：回合数增长 → 延迟复检运行态
      const size = snap.turnEnds?.size ?? 0
      if (size > lastTurnEnds) {
        lastTurnEnds = size
        dbg('turnEnds grew', String(size))
        scheduleRunEndCheck()
      }
      // 任务失败边缘：lastAgentError null → 字符串（host/agent-error 帧）
      const err = snap.lastAgentError
      if (typeof err === 'string' && err !== lastError) {
        lastError = err
        const now = Date.now()
        if (now - lastErrorPlayedAt >= 20000) {
          lastErrorPlayedAt = now
          const settings = loadSettings()
          if (settings.enabled && settings.error) playEvent('error', settings.volume, 'agent-error')
          else dbg('agent-error suppressed (disabled)', err.slice(0, 80))
        } else {
          dbg('agent-error dedup window', err.slice(0, 80))
        }
      } else if (err === null && lastError !== null) {
        lastError = null
      }
      checkGoal('session')
    }

    const scheduleRunEndCheck = (): void => {
      later(() => {
        const now = currentSession === undefined ? undefined : sessions.list.getSnapshot().byId[currentSession.sessionId]
        if (now !== undefined && now.running !== true) {
          const s = loadSettings()
          if (s.enabled && s.done) playEvent('done', s.volume, 'run-end')
        } else {
          dbg('run-end recheck skipped (still running)', now?.running)
        }
      }, 2500)
    }

    const onList = (): void => {
      const snapshot = sessions.list.getSnapshot()
      const settings = loadSettings()
      dbg('onList', { ids: snapshot.ids.length, current: snapshot.current ?? null })

      for (const id of snapshot.ids) {
        const entry = snapshot.byId[id]
        if (entry === undefined) continue

        // ① 需要授权 / 需要提问（pending 从无到有或类型变化 → 响；消失 → 清除记忆，
        //    保证同一会话的第二次/下一次审批照样响）
        const pending = entry.pendingInteraction
        if (pending !== undefined) {
          if (seenInteraction.get(id) !== pending) {
            seenInteraction.set(id, pending)
            dbg('pendingInteraction', `${id}: ${pending}`)
            if (settings.enabled && settings.approval) {
              playEvent(pending === 'approval' ? 'approval' : 'question', settings.volume, `pending:${pending}`)
            }
          }
        } else if (seenInteraction.has(id)) {
          seenInteraction.delete(id)
          dbg('pendingInteraction cleared', id)
        }

        // ② 后台会话完成（侧栏 "done" 标记）
        if (entry.completed === true && !completedNotified.has(id)) {
          completedNotified.add(id)
          dbg('session completed flag', id)
          if (settings.enabled && settings.done) playEvent('done', settings.volume, 'session-completed')
        }

        // ③ 运行停止：延迟复检（排队间隙 running 短暂为 false 时不误报）
        const wasRunning = runningStates.get(id)
        const isRunning = entry.running === true
        if (wasRunning === true && !isRunning) {
          dbg('running edge true->false', id)
          if (id === currentSession?.sessionId) scheduleRunEndCheck()
          else {
            const sid = id
            later(() => {
              const now = sessions.list.getSnapshot().byId[sid]
              if (now !== undefined && now.running !== true) {
                const s = loadSettings()
                if (s.enabled && s.done) playEvent('done', s.volume, 'run-end:' + sid)
              }
            }, 2500)
          }
        }
        runningStates.set(id, isRunning)
      }

      // 跟随当前会话 → goal 投影（投影帧只更新 list，必须在这里检查）
      const nextId = snapshot.current
      if (nextId !== currentId) {
        currentId = nextId
        unsubSession?.()
        unsubSession = undefined
        currentSession = nextId === undefined ? undefined : sessions.binding(nextId)?.session
        if (currentSession !== undefined) {
          dbg('bound current session', currentSession.sessionId)
          const snap = currentSession.getSnapshot()
          const projection = currentSession.projections?.get('goal')
          const goal = projection?.goal
          lastGoalId = goal?.id
          lastGoalPhase = goal?.phase
          lastTurnEnds = snap.turnEnds?.size ?? 0
          // 初始化为当前值：页面加载后历史错误不算"新失败"
          lastError = typeof snap.lastAgentError === 'string' ? snap.lastAgentError : null
          unsubSession = currentSession.subscribe(onSession)
        } else {
          dbg('current session bind failed', nextId)
        }
      }
      checkGoal('list')
    }

    const unsubList = sessions.list.subscribe(onList)
    ctx.effect(() => {
      return () => {
        unsubList()
        unsubSession?.()
      }
    }, 'sound-alerts: watchers')
    onList()
  }

  // 设置行（设置 → 通用）：与声音监视无关，必须先注册（sessions 分支会提前 return）
  const registerSettingsRow = (): void => {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => slots.inject('settings.general.item', () => slots.register(
      { name: 'settings.general.item', id: 'sound-alerts', order: 90 },
      SoundSettingsRow,
    )), 'sound-alerts: settings row')
    dbg('settings row registered')
  }
  registerSettingsRow()

  // sessions 服务由 client-runtime 提供；启动时序上可能晚于本插件 apply，轮询等待
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    start(sessions as SessionsService)
    return
  }
  const retry = (): void => {
    const s = ctx.get('sessions')
    if (s !== undefined) {
      start(s as SessionsService)
      return
    }
    later(retry, 300)
  }
  later(retry, 300)
}

// ── 设置行（设置 → 通用 → 声音提示）───────────────────────────────────────────

const EVENT_ROWS: Array<{ key: SoundEvent; label: string }> = [
  { key: 'approval', label: '需要授权' },
  { key: 'question', label: '需要提问' },
  { key: 'done', label: '任务完成' },
  { key: 'error', label: '任务失败' },
  { key: 'goal', label: 'Goal 完成' },
]

const BTN_STYLE: Record<string, string> = {
  fontSize: '12px',
  padding: '2px 10px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, #ccc)',
  background: 'var(--dsw-specific-tip, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
}

function EventRow(props: { event: SoundEvent; label: string; settings: SoundSettings; update: (patch: Partial<SoundSettings>) => void }): unknown {
  const { event, label, settings, update } = props
  const fileInput = useRef<HTMLInputElement>(null)
  const custom = settings.custom[event]
  const disabled = !settings.enabled

  const onFile = (e: { target: { files?: FileList | null } }): void => {
    const file = e.target.files?.[0]
    if (file === undefined || file === null) return
    if (file.size > MAX_CUSTOM_BYTES) {
      window.alert('音频文件不能超过 10MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      if (dataUrl.length === 0) return
      // IDB 以固定 key 存本体（文件名会变，key 稳定）
      void idbSet('custom:' + event, { name: file.name, dataUrl })
        .then(() => {
          update({ custom: { ...settings.custom, [event]: { source: 'file', name: file.name } } })
          dbg('custom sound saved', `${event}: ${file.name} (${file.size}B)`)
        })
        .catch((err) => dbg('custom save failed', String(err)))
    }
    reader.onerror = () => dbg('custom read failed', file.name)
    reader.readAsDataURL(file)
    // 允许连续选择同一文件
    e.target.value = ''
  }

  const clearCustom = (): void => {
    const next = { ...settings.custom }
    delete next[event]
    update({ custom: next })
    void idbDel('custom:' + event).catch((err) => dbg('custom delete failed', String(err)))
    dbg('custom sound cleared', event)
  }

  return createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px' } },
    createElement('span', { key: 'label', style: { width: 68, flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #888)' } }, label),
    createElement('button', {
      key: 'upload',
      type: 'button',
      disabled,
      onClick: () => fileInput.current?.click(),
      style: BTN_STYLE,
    }, '上传'),
    createElement('input', {
      key: 'file',
      ref: fileInput,
      type: 'file',
      accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.flac',
      style: { display: 'none' },
      onChange: onFile,
    }),
    createElement('button', {
      key: 'preview',
      type: 'button',
      disabled,
      onClick: () => {
        const s = loadSettings()
        if (!s.enabled) return
        playEvent(event, s.volume, 'preview:' + event)
      },
      style: BTN_STYLE,
    }, '试听'),
    custom !== undefined
      ? createElement('button', { key: 'clear', type: 'button', onClick: clearCustom, style: BTN_STYLE }, '清除')
      : null,
    custom !== undefined
      ? createElement('span', { key: 'custom-name', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #999)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 } }, custom.name)
      : null,
  )
}

function SoundSettingsRow(): unknown {
  const [settings, setSettings] = useState(loadSettings)
  const update = (patch: Partial<SoundSettings>): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next)
  }
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' } },
    createElement('div', { key: 'row1', style: { display: 'flex', alignItems: 'center', gap: 10 } },
      createElement('span', { key: 'label', style: { flex: 1, fontSize: 13 } }, '声音提示 (Sound Alerts)'),
      createElement('input', {
        key: 'toggle',
        type: 'checkbox',
        checked: settings.enabled,
        onChange: (e: { target: { checked: boolean } }) => update({ enabled: e.target.checked }),
      }),
      createElement('input', {
        key: 'volume',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.05,
        value: settings.volume,
        disabled: !settings.enabled,
        onChange: (e: { target: { value: string } }) => update({ volume: Number(e.target.value) }),
        style: { width: 120 },
      }),
    ),
    ...EVENT_ROWS.map((row) => createElement(EventRow, {
      key: row.key,
      event: row.key,
      label: row.label,
      settings,
      update,
    })),
  )
}
