// ============================================================
// Auralynk receiver.
//
// Streams microphone PCM into the shared `BfskDemodulator`.
//
// The microphone AudioContext runs continuously (it is also the
// UI spectrum source), so symbols cannot be timed by request-
// animation-frame callbacks — 20 ms symbols are far shorter than
// one frame. Instead an AudioWorklet pulls sample blocks on the
// audio thread and posts them to the demodulator, whose symbol
// windows are aligned by sample count.
//
// An AudioWorklet (rather than the deprecated ScriptProcessor
// node it replaced) is essential here: ScriptProcessor runs on
// the main thread, so a busy frame (canvas redraws, DOM writes)
// can drop or delay audio blocks, which desynchronises symbol
// timing and corrupts frames. The worklet runs on the audio
// thread and is immune to main-thread load.
//
// The worklet is compiled from an inline Blob module, so the
// capture stage has no bundler or asset-loading dependency.
// ============================================================

import { type BfskConfig } from './bfskModem'
import {
  BfskDemodulator,
  type DemodulatorFrame,
  type DemodulatorTelemetry,
} from './bfskDemodulator'
import { type MicrophoneAnalyzer } from './microphoneAnalyzer'

export interface ReceiverCallbacks {
  onTelemetry: (telemetry: DemodulatorTelemetry) => void
  onFrame: (frame: DemodulatorFrame) => void
}

export interface LoopbackReference {
  packetBits: number[]
  payload: Uint8Array
}

const BLOCK_SIZE = 2048
const WORKLET_NAME = 'ultralink-capture'

const CAPTURE_WORKLET_SOURCE = `
const QUANTUM = 128

class UltraLinkCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(${BLOCK_SIZE})
    this.offset = 0
  }

  emit(value) {
    this.block[this.offset++] = value

    if (this.offset === this.block.length) {
      this.port.postMessage(this.block)
      this.block = new Float32Array(${BLOCK_SIZE})
      this.offset = 0
    }
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]

    // Never skip a render quantum: the demodulator times symbols
    // by absolute sample count, so a missing input must still
    // contribute QUANTUM (silent) samples or the phase grid drifts
    // permanently. A short channel is padded the same way.
    if (!channel) {
      for (let i = 0; i < QUANTUM; i++) {
        this.emit(0)
      }

      return true
    }

    for (let i = 0; i < channel.length; i++) {
      this.emit(channel[i])
    }

    for (let i = channel.length; i < QUANTUM; i++) {
      this.emit(0)
    }

    return true
  }
}

registerProcessor('${WORKLET_NAME}', UltraLinkCaptureProcessor)
`

export class BfskReceiver {
  private readonly microphone: MicrophoneAnalyzer
  private readonly callbacks: ReceiverCallbacks
  private demodulator: BfskDemodulator | null = null
  private workletNode: AudioWorkletNode | null = null
  private silentGain: GainNode | null = null
  private reference: LoopbackReference | null = null
  private lastTelemetry: DemodulatorTelemetry | null = null

  constructor(microphone: MicrophoneAnalyzer, callbacks: ReceiverCallbacks) {
    this.microphone = microphone
    this.callbacks = callbacks
  }

  get isRunning(): boolean {
    return this.workletNode !== null
  }

  get telemetry(): DemodulatorTelemetry | null {
    return this.lastTelemetry
  }

  /**
   * Rebuilds the demodulator with a new carrier/symbol setup.
   * Safe to call while the receiver is listening.
   */
  updateConfig(config: BfskConfig): void {
    if (!this.demodulator) {
      return
    }

    const sampleRate = this.microphone.getSampleRate() || 48000
    const demodulator = new BfskDemodulator(config, sampleRate)

    demodulator.setReference(this.reference)
    this.demodulator = demodulator
    this.lastTelemetry = null
  }

  /** Loopback reference used for a real bit-error-rate measurement. */
  setReference(reference: LoopbackReference | null): void {
    this.reference = reference
    this.demodulator?.setReference(reference)
  }

  async start(config: BfskConfig): Promise<void> {
    if (this.workletNode) {
      return
    }

    await this.microphone.start()

    const context = this.microphone.context

    if (!context) {
      throw new Error('The microphone audio context could not be started.')
    }

    if (!context.audioWorklet) {
      throw new Error('This browser does not support AudioWorklet capture.')
    }

    const demodulator = new BfskDemodulator(config, context.sampleRate)
    demodulator.setReference(this.reference)

    const moduleUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }),
    )

    try {
      await context.audioWorklet.addModule(moduleUrl)
    } finally {
      URL.revokeObjectURL(moduleUrl)
    }

    const workletNode = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })

    const silentGain = context.createGain()

    silentGain.gain.value = 0

    const callbacks = this.callbacks

    workletNode.port.onmessage = (event: MessageEvent<Float32Array>): void => {
      const frames = demodulator.push(event.data)

      // Frames first, telemetry second: the counters shown in the
      // UI (packets, loss) must include a frame decoded in this
      // very block.
      for (let i = 0; i < frames.length; i++) {
        callbacks.onFrame(frames[i])
      }

      const telemetry = demodulator.telemetry()

      this.lastTelemetry = telemetry
      callbacks.onTelemetry(telemetry)
    }

    // An AudioWorklet only processes while connected to the
    // destination, so it feeds a zero-gain node: no audio is
    // produced, but the graph stays live.
    this.microphone.attach(workletNode)
    workletNode.connect(silentGain)
    silentGain.connect(context.destination)

    this.demodulator = demodulator
    this.workletNode = workletNode
    this.silentGain = silentGain
    this.lastTelemetry = null
  }

  stop(): void {
    const workletNode = this.workletNode
    const silentGain = this.silentGain

    if (!workletNode) {
      return
    }

    workletNode.port.onmessage = null
    this.microphone.detach(workletNode)

    try {
      workletNode.disconnect()
    } catch {
      // already disconnected
    }

    if (silentGain) {
      try {
        silentGain.disconnect()
      } catch {
        // already disconnected
      }
    }

    this.workletNode = null
    this.silentGain = null
    this.demodulator = null
  }
}
