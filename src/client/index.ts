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
 *      延迟 2.5s 复检（排队间隙不误报）后播"完成"音；
 *    - 后台会话出现 completed 标记（侧栏绿色"done"提醒）：播"完成"音；
 *    - 当前会话 goal 投影 phase → "complete"：播放胜利三连音。
 *
 * 3. 设置
 *    - 设置 → 通用 面板有一行开关 + 音量滑杆（settings.general.item slot）；
 *    - 持久化于 localStorage（键 dsh-sound-alerts:settings）。
 *
 * 4. 诊断
 *    - console.debug('[sound-alerts]', ...) + window.__soundAlertsLog 最近 100 条。
 *
 * 浏览器自动播放策略：AudioContext 懒创建，首次 pointerdown/keydown 手势解锁；
 * 后台标签页仍可出声（这正是提醒场景）。resume() 竞态已处理（异步恢复后补播）。
 *
 * 构建：npm run build:client（esbuild → lib/client.js，ModuleLoader.load 注册）。
 */
import { createElement, useState } from 'react'

const SETTINGS_KEY = 'dsh-sound-alerts:settings'

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
}

const DEFAULT_SETTINGS: SoundSettings = {
  enabled: true,
  volume: 0.45,
  approval: true,
  done: true,
  goal: true,
}

function loadSettings(): SoundSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<SoundSettings>
      return { ...DEFAULT_SETTINGS, ...parsed }
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

/** 任务完成：上行两音 */
const DONE: Note[] = [
  { freq: 659, start: 0, dur: 0.18 },
  { freq: 880, start: 0.2, dur: 0.4 },
]

/** goal 完成：胜利三连音 + 高音收尾 */
const VICTORY: Note[] = [
  { freq: 523, start: 0, dur: 0.16 },
  { freq: 659, start: 0.18, dur: 0.16 },
  { freq: 784, start: 0.36, dur: 0.18 },
  { freq: 1047, start: 0.56, dur: 0.5 },
]

/** 全局防抖：1.2s 内最多一声，避免批量完成/多会话同时触发时轰炸 */
let lastPlayAt = 0

function play(notes: Note[], volume: number, reason: string): void {
  const now = Date.now()
  if (now - lastPlayAt < 1200) {
    dbg('play throttled', reason)
    return
  }
  lastPlayAt = now
  dbg('play', reason)
  playMelody(notes, volume)
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
  getSnapshot(): { turnEnds?: { size?: number } }
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
        if (goal.phase === 'complete') play(VICTORY, settings.volume, 'goal-complete')
        lastGoalPhase = goal.phase
      }
    }

    const onSession = (): void => {
      if (currentSession === undefined) return
      // 兜底完成信号：回合数增长 → 延迟复检运行态
      const size = currentSession.getSnapshot().turnEnds?.size ?? 0
      if (size > lastTurnEnds) {
        lastTurnEnds = size
        dbg('turnEnds grew', String(size))
        scheduleRunEndCheck()
      }
      checkGoal('session')
    }

    const scheduleRunEndCheck = (): void => {
      const settings = loadSettings()
      later(() => {
        const now = currentSession === undefined ? undefined : sessions.list.getSnapshot().byId[currentSession.sessionId]
        if (now !== undefined && now.running !== true) {
          const s = loadSettings()
          if (s.enabled && s.done) play(DONE, s.volume, 'run-end')
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

        // ① 需要授权 / 需要提问
        const pending = entry.pendingInteraction
        if (pending !== undefined && seenInteraction.get(id) !== pending) {
          seenInteraction.set(id, pending)
          dbg('pendingInteraction', `${id}: ${pending}`)
          if (settings.enabled && settings.approval) {
            play(pending === 'approval' ? ATTENTION_APPROVAL : ATTENTION_QUESTION, settings.volume, `pending:${pending}`)
          }
        }

        // ② 后台会话完成（侧栏 "done" 标记）
        if (entry.completed === true && !completedNotified.has(id)) {
          completedNotified.add(id)
          dbg('session completed flag', id)
          if (settings.enabled && settings.done) play(DONE, settings.volume, 'session-completed')
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
                if (s.enabled && s.done) play(DONE, s.volume, 'run-end:' + sid)
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
          const projection = currentSession.projections?.get('goal')
          const goal = projection?.goal
          lastGoalId = goal?.id
          lastGoalPhase = goal?.phase
          lastTurnEnds = currentSession.getSnapshot().turnEnds?.size ?? 0
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

function SoundSettingsRow(): unknown {
  const [settings, setSettings] = useState(loadSettings)
  const update = (patch: Partial<SoundSettings>): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next)
  }
  return createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' } },
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
  )
}
