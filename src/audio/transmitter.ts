// ============================================================
// Auralynk transmitter.
//
// Renders the packet with the shared BFSK modulator
// (`bfskModem.ts`) and plays the resulting AudioBuffer.
// Playback is cancellable and always cleaned up, so a stuck
// oscillator or a runaway animation loop is impossible.
// ============================================================

import { type AudioEngine } from './audioEngine'
import {
  type BfskConfig,
  buildPacket,
  createBfskAudio,
  type EncodedPacket,
  getTransmissionInfo,
  type TransmissionInfo,
  validateBfskConfig,
} from './bfskModem'

export type TransmitOutcome = 'completed' | 'stopped'

export interface TransmitResult {
  outcome: TransmitOutcome
  info: TransmissionInfo
  packet: EncodedPacket
}

export class BfskTransmitter {
  private readonly engine: AudioEngine
  private active = false
  private source: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null
  private token = 0
  private progressTimer: number | null = null

  constructor(engine: AudioEngine) {
    this.engine = engine
  }

  get isTransmitting(): boolean {
    return this.active
  }

  async transmit(
    text: string,
    config: BfskConfig,
    onProgress?: (fraction: number) => void,
  ): Promise<TransmitResult> {
    const packet = buildPacket(text)

    return this.transmitPacket(packet, config, onProgress)
  }

  /**
   * Plays an already framed packet. The caller keeps the packet so
   * it can install a loopback reference on the receiver before the
   * first sample is played — that is what makes a real bit-error
   * rate measurable on the same machine.
   */
  async transmitPacket(
    packet: EncodedPacket,
    config: BfskConfig,
    onProgress?: (fraction: number) => void,
  ): Promise<TransmitResult> {
    if (this.active) {
      throw new Error('A transmission is already in progress.')
    }

    const context = await this.engine.ensureContext()

    const configError = validateBfskConfig(config, context.sampleRate / 2)
    if (configError) {
      throw new Error(configError)
    }

    const transmission = createBfskAudio(context, packet, config)
    const info = getTransmissionInfo(packet, config)

    const source = context.createBufferSource()
    const gain = context.createGain()

    source.buffer = transmission.audioBuffer
    gain.gain.value = 1

    source.connect(gain)
    gain.connect(context.destination)

    this.active = true
    this.source = source
    this.gain = gain
    const token = ++this.token
    const startedAt = context.currentTime

    if (onProgress) {
      this.progressTimer = window.setInterval(() => {
        if (this.token !== token) {
          return
        }

        const elapsed = context.currentTime - startedAt
        onProgress(Math.max(0, Math.min(1, elapsed / (transmission.durationMs / 1000))))
      }, 100)
    }

    const finished = new Promise<TransmitOutcome>((resolve) => {
      source.onended = () => resolve('completed')
    })

    source.start()

    const outcome = await finished

    if (this.token === token) {
      this.clearActive()
    }

    return { outcome, info, packet }
  }

  /** Silently aborts the current transmission. */
  stop(): void {
    if (!this.active) {
      return
    }

    this.token++
    const source = this.source
    const gain = this.gain
    const context = this.engine.context

    this.clearActive()

    if (source) {
      source.onended = null

      if (context && gain) {
        const now = context.currentTime
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03)
      }

      try {
        source.stop(context ? context.currentTime + 0.05 : 0)
      } catch {
        // already stopped
      }

      window.setTimeout(() => {
        source.disconnect()
        gain?.disconnect()
      }, 150)
    }
  }

  private clearActive(): void {
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer)
      this.progressTimer = null
    }

    this.active = false
    this.source = null
    this.gain = null
  }
}
