/* eslint-disable prefer-const */
import AudioOut from 'pins/audioout'
import WavStreamer from 'wavstreamer'
import calculatePower from 'calculate-power'
import HTTPClient from 'embedded:network/http/client'
import { File } from 'file'
import config from 'mc/config'
import getMemoryStatus from 'memory-status'

function printMemoryStatus(label: string): void {
  const memory = getMemoryStatus()

  trace(`\n--- Memory: ${label} ---\n`)
  trace(`PSRAM free:        ${memory.psramFree}\n`)
  trace(`PSRAM minimum:     ${memory.psramMinimum}\n`)
  trace(`PSRAM largest:     ${memory.psramLargest}\n`)
  trace(`Internal free:     ${memory.internalFree}\n`)
  trace(`Internal minimum:  ${memory.internalMinimum}\n`)
  trace(`DMA free:          ${memory.dmaFree}\n`)
}
const QUERY_PATH = config.file.root + 'query.json'

function chooseBufferDuration(text: string): number {
  const length = text.replace(/\s+/g, '').length

  if (length <= 20) return 500
  if (length <= 50) return 800
  if (length <= 100) return 1200
  return 1600
}
/* global trace, SharedArrayBuffer */

declare const device: any

export type TTSProperty = {
  onPlayed: (number) => void
  onDone: () => void
  host: string
  port: number
  sampleRate: number
  speakerId: number
}

export class TTS {  
  audio: AudioOut
  onPlayed: (number) => void
  onDone: () => void
  // TODO: Add type definition for HTTPClient
  client: HTTPClient
  host: string
  port: number
  streaming: boolean
  file: File
  speakerId: number
  constructor(props: TTSProperty) {
    this.onPlayed = props.onPlayed
    this.onDone = props.onDone
    this.audio = new AudioOut({ streams: 1, bitsPerSample: 16, sampleRate: props.sampleRate ?? 11025 })
    this.speakerId = props.speakerId ?? 1
    this.host = props.host
    this.port = props.port
  }

  setSpeakerId(speakerId: number): void {
    if (
      typeof speakerId !== 'number' ||
      !Number.isFinite(speakerId) ||
      speakerId < 0
    ) {
      throw new RangeError(`invalid VoiceVox speaker ID: ${speakerId}`)
    }
  
    if (this.streaming) {
      throw new Error('cannot change speaker while playing')
    }
  
    this.speakerId = Math.floor(speakerId)
    trace(`VoiceVox speaker changed to ${this.speakerId}\n`)
  }

  async getQuery(text: string, speakerId = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      File.delete(QUERY_PATH)
      const file = new File(QUERY_PATH, true)
      const sampleRate = this.audio?.sampleRate ?? 11025
      const client = new device.network.http.io({
        ...device.network.http,
        host: this.host,
        port: this.port,
      })
      client.request({
        method: 'POST',
        path: encodeURI(`/audio_query?text=${text}&speaker=${speakerId}`),
        headers: new Map([['Content-Type', 'application/x-www-form-urlencoded']]),
        onHeaders(status) {
          if (status !== 200) {
            reject(`server returned ${status}`)
          }
        },
        onReadable(count) {
          file.write(this.read(count))
          // trace(`${count} bytes written. position: ${file.position}\n`)
        },
        onDone() {
          if (sampleRate !== 24000) {
            file.position = file.length - 1
            file.write(`, "outputSamplingRate": ${sampleRate}}`)
          }
          file.close()
          client.close()
          resolve()
        },
      })
    })
  }
  async stream(key: string): Promise<void> {
    if (this.streaming) {
      throw new Error('already playing')
    }
  
    this.streaming = true

    const host = this.host
    const port = this.port
    const speakerId = this.speakerId
    const bufferDuration = chooseBufferDuration(key)
    const textLength = key.replace(/\s+/g, '').length

    trace(`VoiceVox buffer=${bufferDuration}ms, length=${textLength}\n`)

    try {
      await this.getQuery(key, speakerId)
    } catch (e) {
      this.streaming = false
      trace(`VoiceVox query ERROR: ${e}\n`)
      throw e
    }
  
    const { onPlayed, onDone, audio } = this
    const file = new File(QUERY_PATH)
  
    trace(`file opened. length: ${file.length}, position: ${file.position}\n`)
  
    return new Promise((resolve, reject) => {
      let started = false
      let pauseCount = 0
      let lastPowerUpdateMs = 0
  
      let streamer = new WavStreamer({
        http: device.network.http,
        host,
        port,
        path: encodeURI(`/synthesis?speaker=${speakerId}`),
  
        audio: {
          out: audio,
          stream: 0,
        },
  
        bufferDuration,
  
        request: {
          method: 'POST',
          headers: new Map([
            ['content-type', 'application/json'],
            ['content-length', `${file.length}`],
          ]),
  
          onWritable(count) {
            this.write(file.read(ArrayBuffer, count))
          },
        },
  
        onPlayed(buffer) {
          const now = Date.now()
    
          if (now - lastPowerUpdateMs < 50)
            return
    
          lastPowerUpdateMs = now
    
          const power = calculatePower(buffer)
          onPlayed?.(power)
        },
  
        onReady(state) {
          if (state) {
            if (started)
              trace('VoiceVox resumed\n')
            else {
              started = true
              trace('VoiceVox started\n')
            }
        
            audio.start()
          } else {
            if (started) {
              pauseCount += 1
              trace(`VoiceVox paused: ${pauseCount}\n`)
            }
        
            audio.stop()
          }
        },
  
        onError: (e) => {
          file.close()
          trace(`VoiceVox ERROR: ${e}\n`)
          this.streaming = false
          streamer?.close()
          reject(e)
        },
  
        onDone: () => {
          file.close()
          audio.stop()
  
          trace(
            `VoiceVox DONE buffer=${bufferDuration}ms pauses=${pauseCount}\n`
          )
  
          this.streaming = false
          streamer?.close()
          onDone?.()
          resolve()
        },
      })
    })
  }
}
