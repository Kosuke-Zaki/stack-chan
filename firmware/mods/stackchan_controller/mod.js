/**
 * stackchan_controller mod — 汎用ラジコン / stt_server_stackchan プロトコル対応
 *
 * 旧 monologue mod をベースに、実験専用の内容を持たない汎用ラジコン mod として
 * 独立させたもの（PC側の stackchan_controller パッケージに対応する、実機側の受け口）。
 *
 * 首振り pan: 0〜12（15°刻み、6=正面）、-1=動かさない
 * 首振り yaw_deg: -90〜90の連続角度（指定時は pan より優先、15°刻みに量子化しない）
 * 仰角 pitch_deg: -30〜10（tiltサーボの可動域にハードクランプ済み）
 * pan/tilt軸のサーボ速度・加速度・ゲイン・電流飽和(pan_velocity等)を個別指定可能
 * 表情 expression: NEUTRAL/ANGRY/SAD/HAPPY/SLEEPY/DOUBTFUL/COLD/HOT（m5stack-avatarの
 *   Expression enumを包含。doubt=doubtful扱い）
 * 発話中の動き move_while_speaking: 基準角度の周辺でランダムに首を揺らしながら話す
 * モータ速度: PAN_IDLE（ランダム）/ PAN_INTERVENTION（介入・視線 phrase）
 */

import Timer from 'timer'
import WebSocket from 'WebSocket'
import { asyncWait, randomBetween } from 'stackchan-util'
import config from 'mc/config'

/** 待機ランダム首振り（従来どおりの速さ） */
const PAN_IDLE = {
  profileVelocity: 30,
  profileAcceleration: 20,
  gain: 0.2,
  saturation: 60,
}

/** 介入・視線合わせ（I/G/F/V 等の pan 指定 phrase） */
const PAN_INTERVENTION = {
  profileVelocity: 52,
  profileAcceleration: 34,
  gain: 0.2,
  saturation: 60,
}

const DEG_TO_RAD = Math.PI / 180
const HEAD_PITCH_RAD = -Math.PI / 12
const HEAD_PAN_CENTER_INDEX = 6
const HEAD_PAN_MIN_INDEX = 0
const HEAD_PAN_MAX_INDEX = 12
const HEAD_YAW_MIN_DEG = -90
const HEAD_YAW_MAX_DEG = 90
// tilt サーボの可動域はドライバ側(dynamixel-driver.ts)で -30〜+10 度にハードクランプ
// されている。ここでの範囲チェックはtraceログを実角度に近づけるためのもので、
// 安全性そのものはドライバ側のクランプで担保されている。
const HEAD_PITCH_MIN_DEG = -30
const HEAD_PITCH_MAX_DEG = 10

const POSES = {
  roopleft: { rotation: { y: 15 * DEG_TO_RAD, p: HEAD_PITCH_RAD, r: 0 } },
  roopright: { rotation: { y: -15 * DEG_TO_RAD, p: HEAD_PITCH_RAD, r: 0 } },
  center: { rotation: { y: 0, p: HEAD_PITCH_RAD, r: 0 } },
}

const ACTION_NO_MOTION = -1
const IDLE_KEYS = ['roopleft', 'roopright', 'center']
const WAIT_MIN_MS = 5000
const WAIT_MAX_MS = 8000

/**
 * 表情(expression) → stack-chan Emotion 文字列（renderer-base.tsのEmotion enumと一致）。
 * m5stack-avatar(C++版)のExpression enum(Happy/Angry/Sad/Doubt/Sleepy/Neutral)を包含する
 * スーパーセットなので、そちらの表記もそのまま受け付ける（doubt=doubtful扱い）。
 * surprised/dizzyは、DOUBTFUL/COLD/HOTの描き分けと合わせて
 * Kosuke-Zaki/stack-chan（rt-net/stack-chanのfork）側のrenderer変更が
 * 実機に書き込まれていないと見た目に反映されない。
 */
const EXPRESSION_TO_EMOTION = {
  neutral: 'NEUTRAL',
  angry: 'ANGRY',
  sad: 'SAD',
  happy: 'HAPPY',
  sleepy: 'SLEEPY',
  doubtful: 'DOUBTFUL',
  doubt: 'DOUBTFUL',
  cold: 'COLD',
  hot: 'HOT',
  surprised: 'SURPRISED',
  dizzy: 'DIZZY',
}

function resolveEmotion(data) {
  if (typeof data.expression !== 'string') return null
  const key = data.expression.trim().toLowerCase()
  return EXPRESSION_TO_EMOTION[key] || null
}

/** 「動きながら話す」モード: 基準角度(yaw_deg指定値、未指定なら正面)の周辺でランダムに首を揺らし続ける */
const SPEAK_WIGGLE_SPREAD_DEG = 15
const SPEAK_WIGGLE_MIN_MS = 900
const SPEAK_WIGGLE_MAX_MS = 1800

/** 口パク（公式 chat_audioio に近い反映間隔） */
const MOUTH_UPDATE_INTERVAL_MS = 200
const MOUTH_FLAP_OPEN_MS = 350
const MOUTH_FLAP_CLOSED_MS = 350
const MOUTH_QUANTIZE_STEP = 0.1
const MOUTH_OPEN_FIRST = 0.9
const MOUTH_OPEN_LEVEL = 0.7
const MOUTH_CLOSED_LEVEL = 0.05

function resolveWsUrl() {
  if (config.robot && config.robot.wsUrl) return config.robot.wsUrl
  const host = (config.robot && config.robot.wsHost) || '192.168.0.2'
  const port = (config.robot && config.robot.wsPort) || 8088
  return `ws://${host}:${port}/`
}

function randomWaitMs() {
  return randomBetween(WAIT_MIN_MS, WAIT_MAX_MS)
}

function randomIdleKey(excludeKey) {
  let key
  do {
    key = IDLE_KEYS[Math.floor(randomBetween(0, IDLE_KEYS.length))]
  } while (key === excludeKey && IDLE_KEYS.length > 1)
  return key
}

function headPanIndexToDeg(index) {
  return (index - HEAD_PAN_CENTER_INDEX) * 15
}

function normalizeHeadPanIndex(index) {
  if (typeof index !== 'number' || !Number.isFinite(index)) {
    return HEAD_PAN_CENTER_INDEX
  }
  const rounded = Math.round(index)
  if (rounded < HEAD_PAN_MIN_INDEX) return HEAD_PAN_MIN_INDEX
  if (rounded > HEAD_PAN_MAX_INDEX) return HEAD_PAN_MAX_INDEX
  return rounded
}

function clampPitchDeg(deg) {
  return Math.min(Math.max(deg, HEAD_PITCH_MIN_DEG), HEAD_PITCH_MAX_DEG)
}

/** pitchDeg が未指定(null)なら従来どおりの固定仰角を使う */
function resolvePitchRad(pitchDeg) {
  return pitchDeg != null ? clampPitchDeg(pitchDeg) * DEG_TO_RAD : HEAD_PITCH_RAD
}

function headPanIndexToPose(index, pitchDeg) {
  if (index === ACTION_NO_MOTION) return null
  const panIndex = normalizeHeadPanIndex(index)
  const yawDeg = headPanIndexToDeg(panIndex)
  return { rotation: { y: yawDeg * DEG_TO_RAD, p: resolvePitchRad(pitchDeg), r: 0 } }
}

function clampYawDeg(deg) {
  return Math.min(Math.max(deg, HEAD_YAW_MIN_DEG), HEAD_YAW_MAX_DEG)
}

/** 15°刻みに量子化せず、連続角度をそのままポーズへ変換する */
function yawDegToPose(deg, pitchDeg) {
  const clamped = clampYawDeg(deg)
  return { rotation: { y: clamped * DEG_TO_RAD, p: resolvePitchRad(pitchDeg), r: 0 } }
}

/**
 * data.{prefix}_velocity / _acceleration / _gain / _saturation から
 * サーボ軸オプション(profileVelocity/profileAcceleration/gain/saturation)を組み立てる。
 * 1つも指定が無ければ null（呼び出し側で「上書きなし」として扱う）。
 */
function extractAxisMotion(data, prefix) {
  const velocity = data[`${prefix}_velocity`]
  const acceleration = data[`${prefix}_acceleration`]
  const gain = data[`${prefix}_gain`]
  const saturation = data[`${prefix}_saturation`]
  const opts = {}
  if (typeof velocity === 'number' && Number.isFinite(velocity)) opts.profileVelocity = velocity
  if (typeof acceleration === 'number' && Number.isFinite(acceleration)) {
    opts.profileAcceleration = acceleration
  }
  if (typeof gain === 'number' && Number.isFinite(gain)) opts.gain = gain
  if (typeof saturation === 'number' && Number.isFinite(saturation)) opts.saturation = saturation
  return Object.keys(opts).length > 0 ? opts : null
}

function resolveHeadPanIndex(data) {
  if (typeof data.pan === 'number') return data.pan
  if (typeof data.head === 'number') return data.head
  if (typeof data.action === 'number' && data.action !== ACTION_NO_MOTION) {
    return data.action
  }
  if (typeof data.action === 'number' && data.action === ACTION_NO_MOTION) {
    return ACTION_NO_MOTION
  }
  return HEAD_PAN_CENTER_INDEX
}

function sendReady(sock) {
  if (sock && sock.readyState === 1) {
    sock.send(JSON.stringify({ type: 'ready' }))
    trace('ready sent\n')
  }
}

function parseJob(data) {
  if (data.type === 'idle') {
    return { idle: !!data.enable }
  }
  if (data.type === 'phrase') {
    const text = typeof data.message === 'string' ? data.message : ''
    const panIndex = resolveHeadPanIndex(data)
    const yawDeg =
      typeof data.yaw_deg === 'number' && Number.isFinite(data.yaw_deg) ? data.yaw_deg : null
    const pitchDeg =
      typeof data.pitch_deg === 'number' && Number.isFinite(data.pitch_deg)
        ? data.pitch_deg
        : null
    const mouthMs =
      typeof data.mouth_ms === 'number' && Number.isFinite(data.mouth_ms)
        ? Math.max(0, Math.round(data.mouth_ms))
        : 0
    const mouthDelayMs =
      typeof data.mouth_delay_ms === 'number' && Number.isFinite(data.mouth_delay_ms)
        ? Math.max(0, Math.round(data.mouth_delay_ms))
        : 0
    const deviceTts = data.device_tts === true
    const speakerId =
      typeof data.speaker_id === 'number' && Number.isFinite(data.speaker_id)
        ? Math.max(0, Math.floor(data.speaker_id))
        : null
    const moveWhileSpeaking = data.move_while_speaking === true
    return {
      text: deviceTts ? text : '',
      speakerId,
      panIndex,
      yawDeg,
      pose: yawDeg !== null
        ? yawDegToPose(yawDeg, pitchDeg)
        : headPanIndexToPose(panIndex, pitchDeg),
      mouthMs,
      mouthDelayMs,
      panMotion: extractAxisMotion(data, 'pan'),
      tiltMotion: extractAxisMotion(data, 'tilt'),
      moveWhileSpeaking,
      emotion: resolveEmotion(data),
    }
  }
  if (typeof data.text === 'string' && data.text.length > 0) {
    const pose = POSES[data.pose] ? POSES[data.pose] : POSES.center
    return { text: data.text, panIndex: HEAD_PAN_CENTER_INDEX, pose, mouthMs: 0 }
  }
  if (data.role === 'assistant' && typeof data.message === 'string') {
    return { text: data.message, panIndex: ACTION_NO_MOTION, pose: null, mouthMs: 0 }
  }
  return null
}

function onRobotCreated(robot) {
  let idleEnabled = false
  let queueRunning = false
  let lastIdleKey = null
  const queue = []
  const wsUrl = resolveWsUrl()
  let ws = null
  let reconnectTimer = null

  function isWsConnected() {
    return ws && ws.readyState === 1
  }

  function isCommandActive() {
    return queueRunning || queue.length > 0
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = Timer.set(() => {
      reconnectTimer = null
      connect()
    }, 3000)
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      Timer.clear(reconnectTimer)
      reconnectTimer = null
    }
  }

  function reconnectWs() {
    trace('ws manual reconnect\n')
    cancelReconnect()
    const old = ws
    ws = null
    if (old) {
      try {
        old.close()
      } catch (e) {
        trace(`ws close error: ${e}\n`)
      }
    }
    connect()
  }

  async function idleLoop() {
    while (true) {
      if (!idleEnabled || isCommandActive()) {
        await asyncWait(100)
        continue
      }
      const key = randomIdleKey(lastIdleKey)
      lastIdleKey = key
      await robot.setPose(POSES[key], { pan: PAN_IDLE })
      if (!idleEnabled || isCommandActive()) continue
      await asyncWait(randomWaitMs())
    }
  }

  function enqueueJob(job) {
    if (job.idle !== undefined) {
      idleEnabled = job.idle
      trace(`idle ${idleEnabled ? 'on' : 'off'} (remote)\n`)
      sendReady(ws)
      return
    }
    queue.push(job)
    runQueue()
  }

  function createMouthController(robot) {
    let pendingMouthOpen = 0
    let lastMouthOpen = -1
    let mouthUpdateTimer = null

    const clamp01 = (value) => Math.min(Math.max(value, 0), 1)
    const quantizeMouthOpen = (value) => {
      const clamped = clamp01(value)
      const stepped = Math.round(clamped / MOUTH_QUANTIZE_STEP) * MOUTH_QUANTIZE_STEP
      return clamp01(stepped)
    }

    const hasMouthApi =
      typeof robot.setMouthOpen === 'function' ||
      typeof robot.setMouseOpen === 'function'

    const applyMouthOpen = (value) => {
      const q = quantizeMouthOpen(value)
      if (typeof robot.setMouthOpen === 'function') {
        robot.setMouthOpen(q)
      } else if (typeof robot.setMouseOpen === 'function') {
        robot.setMouseOpen(q)
      }
      const app = robot.renderer?.application
      if (app && typeof app.distribute === 'function') {
        app.distribute('onChatOutputLevel', Math.round(q * 2000))
      }
      if (typeof robot.control === 'function') {
        robot.control()
      }
      if (typeof robot.invalidate === 'function') {
        robot.invalidate()
      }
      return q
    }

    const flushMouthOpen = () => {
      const q = quantizeMouthOpen(pendingMouthOpen)
      if (q === lastMouthOpen) return
      lastMouthOpen = q
      applyMouthOpen(q)
    }

    const setMouthLevel = (level) => {
      pendingMouthOpen = level
      flushMouthOpen()
    }

    const startFlusher = () => {
      if (mouthUpdateTimer != null) return
      mouthUpdateTimer = Timer.repeat(() => {
        flushMouthOpen()
      }, MOUTH_UPDATE_INTERVAL_MS)
    }

    const stopFlusher = () => {
      if (mouthUpdateTimer != null) {
        Timer.clear(mouthUpdateTimer)
        mouthUpdateTimer = null
      }
      pendingMouthOpen = 0
      lastMouthOpen = -1
      if (hasMouthApi) {
        applyMouthOpen(0)
      }
    }

    return { hasMouthApi, setMouthLevel, startFlusher, stopFlusher, flushMouthOpen }
  }

  const mouthCtrl = createMouthController(robot)
  trace(
    `mouth api setMouthOpen=${typeof robot.setMouthOpen} renderer=${robot.renderer ? 'yes' : 'no'}\n`
  )

  async function animateMouth(durationMs, delayMs = 0) {
    if (delayMs > 0) {
      trace(`mouth animate delay ${delayMs}ms\n`)
      await asyncWait(delayMs)
    }
    trace(
      `mouth animate start ${durationMs}ms open=${MOUTH_OPEN_FIRST}/${MOUTH_OPEN_LEVEL} close=${MOUTH_CLOSED_LEVEL}\n`
    )
    if (!mouthCtrl.hasMouthApi) {
      trace('setMouthOpen unavailable — FW 更新または mod.js 再配置が必要\n')
      await asyncWait(durationMs)
      return
    }
    mouthCtrl.startFlusher()
    const end = Date.now() + durationMs
    let open = true
    let openFlapCount = 0
    try {
      while (Date.now() < end) {
        if (open) {
          const level = openFlapCount === 0 ? MOUTH_OPEN_FIRST : MOUTH_OPEN_LEVEL
          mouthCtrl.setMouthLevel(level)
          openFlapCount += 1
        } else {
          mouthCtrl.setMouthLevel(MOUTH_CLOSED_LEVEL)
        }
        const holdMs = open ? MOUTH_FLAP_OPEN_MS : MOUTH_FLAP_CLOSED_MS
        await asyncWait(holdMs)
        open = !open
      }
    } finally {
      mouthCtrl.stopFlusher()
    }
    trace('mouth animate done\n')
  }

  /**
   * 「動きながら話す」モード: baseDeg（基準角度）の周辺を speechTask が終わるまで
   * ランダムに首を揺らし続ける（idleループに近い継続動作）。speechTask 自体は
   * 呼び出し側で Promise.all にも渡されるため、ここでは終了検知にのみ使う。
   */
  async function wiggleWhileSpeaking(baseDeg, pitchRad, motionOptions, speechTask) {
    let speaking = true
    speechTask.finally(() => {
      speaking = false
    })
    while (speaking) {
      const wiggledDeg = clampYawDeg(
        baseDeg + randomBetween(-SPEAK_WIGGLE_SPREAD_DEG, SPEAK_WIGGLE_SPREAD_DEG)
      )
      await robot.setPose(
        { rotation: { y: wiggledDeg * DEG_TO_RAD, p: pitchRad, r: 0 } },
        motionOptions
      )
      if (!speaking) break
      await asyncWait(randomBetween(SPEAK_WIGGLE_MIN_MS, SPEAK_WIGGLE_MAX_MS))
    }
  }

  async function runQueue() {
    if (queueRunning) return
    queueRunning = true
    try {
      while (queue.length > 0) {
        const job = queue.shift()
        const panDeg =
          job.panIndex === ACTION_NO_MOTION
            ? null
            : headPanIndexToDeg(normalizeHeadPanIndex(job.panIndex))
        const deg = job.yawDeg != null ? clampYawDeg(job.yawDeg) : panDeg
        const hasSpeechTask = job.mouthMs > 0 || job.text.length > 0
        trace(
          `phrase: pan=${job.panIndex} yaw_deg=${job.yawDeg ?? 'none'} deg=${deg ?? 'none'} pitch_deg=${job.pose ? job.pose.rotation.p / DEG_TO_RAD : 'none'} moveWhileSpeaking=${!!job.moveWhileSpeaking} emotion=${job.emotion ?? 'none'} panMotion=${JSON.stringify(job.panMotion || {})} tiltMotion=${JSON.stringify(job.tiltMotion || {})} mouth=${job.mouthMs}ms delay=${job.mouthDelayMs || 0}ms text=${job.text.slice(0, 60)}\n`
        )

        if (job.emotion) {
          robot.setEmotion(job.emotion)
        }

        const tasks = []
        let speechTask = null

        if (job.mouthMs > 0) {
          speechTask = animateMouth(job.mouthMs, job.mouthDelayMs || 0)
        } else if (job.text.length > 0) {
          if (job.speakerId != null) {
            if (robot.tts && typeof robot.tts.setSpeakerId === 'function') {
              robot.tts.setSpeakerId(job.speakerId)
            } else {
              trace(`speaker_id ignored: TTS does not support it\n`)
            }
          }

          speechTask = robot.say(job.text)
        }
        if (speechTask) tasks.push(speechTask)

        if (job.pose) {
          const motionOptions = { pan: { ...PAN_INTERVENTION, ...(job.panMotion || {}) } }
          if (job.tiltMotion) motionOptions.tilt = job.tiltMotion
          if (job.moveWhileSpeaking && hasSpeechTask) {
            tasks.push(wiggleWhileSpeaking(deg ?? 0, job.pose.rotation.p, motionOptions, speechTask))
          } else {
            tasks.push(robot.setPose(job.pose, motionOptions))
          }
        }
        if (tasks.length > 0) {
          await Promise.all(tasks)
        }
        if (!job.pose && job.mouthMs <= 0 && job.text.length === 0) {
          trace('phrase: no motion (pan=-1)\n')
        }
        sendReady(ws)
      }
    } catch (e) {
      trace(`chunk error: ${e}\n`)
      sendReady(ws)
    } finally {
      queueRunning = false
      if (queue.length > 0) runQueue()
    }
  }

  function connect() {
    cancelReconnect()
    const sock = new WebSocket(wsUrl)
    ws = sock
    sock.addEventListener('open', () => {
      trace(`ws open ${wsUrl}\n`)
      robot.setTorque(true)
    })
    sock.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data)
        trace(`ws recv: ${String(event.data).slice(0, 120)}\n`)
        if (data.type === 'idle') {
          enqueueJob({ idle: !!data.enable })
          return
        }
        const job = parseJob(data)
        if (!job) {
          trace('ws: ignored (unknown format)\n')
          return
        }
        enqueueJob(job)
      } catch (e) {
        trace(`ws parse error: ${e}\n`)
      }
    })
    sock.addEventListener('close', () => {
      if (ws !== sock) return
      ws = null
      trace('ws close, reconnect 3s\n')
      scheduleReconnect()
    })
    sock.addEventListener('error', () => {
      trace('ws error\n')
    })
  }

  connect()
  idleLoop()

  robot.button.a.onChanged = function () {
    if (!this.read()) return
    if (!isWsConnected()) {
      reconnectWs()
      return
    }
    idleEnabled = !idleEnabled
    trace(`idle ${idleEnabled ? 'on' : 'off'} (button)\n`)
  }
}

export { onRobotCreated }
export default { onRobotCreated }
