// ============================================================
// Auralynk BFSK Demodulator
//
// Pure TypeScript signal processing: no Web Audio dependency,
// so the exact same code can be unit tested in Node and used
// in the browser.
//
// How it works
// ------------
// 1. The incoming PCM stream is split into symbol windows whose
//    length is governed by a per-hypothesis tracked symbol
//    period (initially `symbolTimeMs` at the local sample rate).
// 2. The symbol phase (where a boundary actually falls) is
//    unknown, so PHASE_COUNT phase hypotheses are evaluated in
//    parallel with Goertzel detectors at carrier0 and carrier1.
// 3. A symbol-timing recovery loop (early-late gate) runs on
//    every hypothesis. Each symbol is integrated in two halves;
//    at a bit transition the opposite carrier leaks into whichever
//    half the misplaced boundary touches. The *amplitude* of that
//    leak is proportional to the timing offset, so the loop nudges
//    the hypothesis' symbol period to null the offset. The
//    receiver therefore follows the transmitter's clock and
//    tolerates sample-clock drift and phase glitches.
// 4. Every hypothesis produces bits. Each buffers bits and looks
//    for PREAMBLE -> SYNC -> LENGTH -> PAYLOAD -> CRC using the
//    shared packet parser.
// 5. The first hypothesis that produces a CRC-valid frame wins;
//    the other hypotheses are flushed so the same frame cannot
//    be reported twice.
// 6. Carrier presence and SNR are derived from spectral
//    coherence (carrier energy / total window energy), which
//    needs no noise-floor calibration.
// ============================================================

import { type BfskConfig, findSyncIndex, parsePacketAt, PREAMBLE_BITS } from './bfskModem'

export const PHASE_COUNT = 16

/** Largest frame the parser can accept: SYNC+LEN+max payload+CRC. */
const MAX_FRAME_BITS = 48 + 512 * 8

/** Keep this many bits while hunting for a sync word. */
const SYNC_HUNT_BITS = 256

/** Bits kept after a failed hunt so a split sync word is not lost. */
const SYNC_HUNT_KEEP = PREAMBLE_BITS.length * 4

/** Coherence above this value means a tone is present (≈ 2 dB SNR). */
const CARRIER_COHERENCE_THRESHOLD = 0.2

const SILENCE_ENERGY = 1e-12

/**
 * Symbol-timing recovery constants.
 *
 * `TIMING_GAIN` is the first-order loop gain (period samples per
 * sample of error). `TIMING_LIMIT` clamps the tracked period to
 * ±10 % of nominal. `TIMING_MIN_LEAK` ignores halves where the
 * opposite-carrier leak is too small to carry timing information,
 * which also keeps the loop from reacting to noise on flat runs.
 */
const TIMING_GAIN = 0.02
const TIMING_LIMIT = 0.1
const TIMING_MIN_LEAK = 1e-4
const TIMING_MIN_ASYMMETRY = 0.2

export interface DemodulatorTelemetry {
  carrierPresent: boolean
  bit: 0 | 1 | null
  frequency: number | null
  coherence: number
  snrDb: number
  quality: number
  inputDb: number
  decodedBits: number
  crcFailures: number
}

export interface DemodulatorFrame {
  text: string
  payload: Uint8Array
  frameBits: number[]
  snrDb: number
  bitErrors: number | null
  ber: number | null
}

interface ReferenceFrame {
  packetBits: number[]
  payload: Uint8Array
}

interface PhaseState {
  skip: number
  /** Tracked symbol period in samples (fractional). */
  period: number
  /** Integer window length for the current symbol. */
  windowLen: number
  count: number
  // Full-window Goertzel accumulators (decision + telemetry).
  s10: number
  s20: number
  s11: number
  s21: number
  // First-half Goertzel accumulators (timing error detector).
  a10: number
  a20: number
  a11: number
  a21: number
  // Second-half Goertzel accumulators (timing error detector).
  b10: number
  b20: number
  b11: number
  b21: number
  energy: number
  bits: number[]
  awaiting: boolean
  power0: number
  power1: number
  coherence: number
}

function createPhaseState(skip: number, period: number): PhaseState {
  const windowLen = Math.max(4, Math.round(period))

  return {
    skip,
    period: windowLen,
    windowLen,
    count: 0,
    s10: 0,
    s20: 0,
    s11: 0,
    s21: 0,
    a10: 0,
    a20: 0,
    a11: 0,
    a21: 0,
    b10: 0,
    b20: 0,
    b11: 0,
    b21: 0,
    energy: 0,
    bits: [],
    awaiting: false,
    power0: 0,
    power1: 0,
    coherence: 0,
  }
}

export class BfskDemodulator {
  private readonly carrier0: number
  private readonly carrier1: number
  private readonly symbolTimeMs: number
  private readonly symbolSamples: number
  private readonly coeff0: number
  private readonly coeff1: number
  private readonly phases: PhaseState[]

  private reference: ReferenceFrame | null = null
  private decodedBits = 0
  private crcFailures = 0
  private lastInputDb = -120

  constructor(config: BfskConfig, sampleRate: number) {
    this.carrier0 = config.carrier0
    this.carrier1 = config.carrier1
    this.symbolTimeMs = config.symbolTimeMs
    this.symbolSamples = Math.max(8, Math.round((config.symbolTimeMs / 1000) * sampleRate))
    this.coeff0 = 2 * Math.cos((2 * Math.PI * config.carrier0) / sampleRate)
    this.coeff1 = 2 * Math.cos((2 * Math.PI * config.carrier1) / sampleRate)
    this.phases = this.buildPhases()
  }

  private buildPhases(): PhaseState[] {
    return Array.from({ length: PHASE_COUNT }, (_, i) =>
      createPhaseState(Math.floor((i * this.symbolSamples) / PHASE_COUNT), this.symbolSamples),
    )
  }

  get config(): BfskConfig {
    return {
      carrier0: this.carrier0,
      carrier1: this.carrier1,
      symbolTimeMs: this.symbolTimeMs,
      amplitude: 1,
    }
  }

  get frameBitCapacity(): number {
    return MAX_FRAME_BITS
  }

  reset(): void {
    const fresh = this.buildPhases()

    for (let i = 0; i < this.phases.length; i++) {
      this.phases[i] = fresh[i]
    }

    this.decodedBits = 0
    this.crcFailures = 0
    this.lastInputDb = -120
  }

  /** Loopback reference used to measure a real bit error rate. */
  setReference(frame: ReferenceFrame | null): void {
    this.reference = frame
  }

  /**
   * Feed one chunk of mono PCM samples.
   * Returns every frame that completed inside this chunk.
   */
  push(samples: Float32Array): DemodulatorFrame[] {
    const frames: DemodulatorFrame[] = []
    const coeff0 = this.coeff0
    const coeff1 = this.coeff1
    const phases = this.phases

    let energy = 0

    for (let n = 0; n < samples.length; n++) {
      const x = samples[n]
      energy += x * x

      for (let p = 0; p < phases.length; p++) {
        const state = phases[p]

        if (state.skip > 0) {
          state.skip--
          continue
        }

        if (state.count === 0) {
          state.windowLen = Math.max(4, Math.round(state.period))
        }

        // Full-window detector: decision + energy/coherence.
        const s0 = x + coeff0 * state.s10 - state.s20
        state.s20 = state.s10
        state.s10 = s0

        const s1 = x + coeff1 * state.s11 - state.s21
        state.s21 = state.s11
        state.s11 = s1

        // Half-window detectors: early-late timing error.
        if (state.count < (state.windowLen >> 1)) {
          const a0 = x + coeff0 * state.a10 - state.a20
          state.a20 = state.a10
          state.a10 = a0

          const a1 = x + coeff1 * state.a11 - state.a21
          state.a21 = state.a11
          state.a11 = a1
        } else {
          const b0 = x + coeff0 * state.b10 - state.b20
          state.b20 = state.b10
          state.b10 = b0

          const b1 = x + coeff1 * state.b11 - state.b21
          state.b21 = state.b11
          state.b11 = b1
        }

        state.energy += x * x
        state.count++

        if (state.count === state.windowLen) {
          this.finaliseSymbol(state, frames)
        }
      }
    }

    this.lastInputDb = energy > 0 ? 10 * Math.log10(energy / samples.length) : -120

    return frames
  }

  private goertzelPower(s1: number, s2: number, coeff: number): number {
    return Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)
  }

  private finaliseSymbol(state: PhaseState, frames: DemodulatorFrame[]): void {
    const s = state.windowLen

    const power0 = this.goertzelPower(state.s10, state.s20, this.coeff0)
    const power1 = this.goertzelPower(state.s11, state.s21, this.coeff1)

    state.power0 = power0
    state.power1 = power1
    state.coherence = state.energy > SILENCE_ENERGY ? Math.max(power0, power1) / (s * state.energy) : 0

    const bit: 0 | 1 = power1 > power0 ? 1 : 0

    this.trackTiming(state, bit)

    state.s10 = 0
    state.s20 = 0
    state.s11 = 0
    state.s21 = 0
    state.a10 = 0
    state.a20 = 0
    state.a11 = 0
    state.a21 = 0
    state.b10 = 0
    state.b20 = 0
    state.b11 = 0
    state.b21 = 0
    state.energy = 0
    state.count = 0

    state.bits.push(bit)
    this.decodedBits++

    this.inspectBits(state, frames)
  }

  /**
   * Early-late gate timing error detector.
   *
   * At a bit transition the window straddles two carriers. If the
   * window boundary is misplaced by δ samples, the opposite carrier
   * leaks into one half for about δ samples. A pure tone's Goertzel
   * magnitude grows linearly with the number of samples it occupies,
   * so `√leak` is proportional to δ, giving a proportional (not
   * saturating) error signal:
   *
   *   errorSamples ≈ L · (√leakSecond − √leakFirst) / √onTone
   *
   * The tracked period is nudged by a small fraction of that error.
   * Halves with negligible leak carry no timing information and are
   * ignored, which stops the loop from wandering on flat bit runs
   * or noise.
   */
  private trackTiming(state: PhaseState, bit: 0 | 1): void {
    const otherFirst =
      bit === 0
        ? this.goertzelPower(state.a11, state.a21, this.coeff1)
        : this.goertzelPower(state.a10, state.a20, this.coeff0)
    const otherSecond =
      bit === 0
        ? this.goertzelPower(state.b11, state.b21, this.coeff1)
        : this.goertzelPower(state.b10, state.b20, this.coeff0)

    const leak = otherFirst + otherSecond

    if (leak <= TIMING_MIN_LEAK * (state.power0 + state.power1)) {
      return
    }

    // Noise fills both halves symmetrically; a real timing offset
    // pushes the opposite carrier into one half. Requiring a
    // minimum asymmetry stops the loop from random-walking on
    // AWGN while still responding to genuine boundary errors.
    const difference = otherSecond - otherFirst

    if (Math.abs(difference) <= leak * TIMING_MIN_ASYMMETRY) {
      return
    }

    const onTone = Math.sqrt(Math.max(SILENCE_ENERGY, state.power0, state.power1))
    const rawError = (state.windowLen * (Math.sqrt(otherSecond) - Math.sqrt(otherFirst))) / onTone
    const errorSamples = Math.max(-state.windowLen / 4, Math.min(state.windowLen / 4, rawError))
    const nominal = this.symbolSamples
    const limited = nominal * TIMING_LIMIT

    state.period = Math.min(
      nominal + limited,
      Math.max(nominal - limited, state.period - TIMING_GAIN * errorSamples),
    )
  }

  private inspectBits(state: PhaseState, frames: DemodulatorFrame[]): void {
    if (!state.awaiting) {
      const syncIndex = findSyncIndex(state.bits, 0)

      if (syncIndex < 0) {
        if (state.bits.length > SYNC_HUNT_BITS) {
          state.bits.splice(0, state.bits.length - SYNC_HUNT_KEEP)
        }

        return
      }

      if (syncIndex > 0) {
        state.bits.splice(0, syncIndex)
      }

      state.awaiting = true
    }

    const parsed = parsePacketAt(state.bits, 0)

    if (parsed.status === 'need-more') {
      if (state.bits.length > MAX_FRAME_BITS + SYNC_HUNT_BITS) {
        state.awaiting = false
        state.bits.splice(0, 1)
      }

      return
    }

    if (parsed.status === 'ok') {
      state.bits.splice(0, parsed.consumedBits)
      state.awaiting = false

      frames.push(this.buildFrame(parsed.payload!, parsed.text!, parsed.frameBits!))
      this.flushOtherPhases(state)
      return
    }

    // invalid length or CRC failure: slide forward one bit and resync
    this.crcFailures++
    state.awaiting = false
    state.bits.splice(0, 1)
  }

  private flushOtherPhases(source: PhaseState): void {
    for (const phase of this.phases) {
      if (phase === source) {
        continue
      }

      phase.bits.length = 0
      phase.awaiting = false
    }
  }

  private buildFrame(payload: Uint8Array, text: string, frameBits: number[]): DemodulatorFrame {
    const reference = this.reference

    let bitErrors: number | null = null
    let ber: number | null = null

    if (
      reference &&
      reference.payload.length === payload.length &&
      reference.packetBits.length === frameBits.length
    ) {
      let matches = true

      for (let i = 0; i < payload.length; i++) {
        if (reference.payload[i] !== payload[i]) {
          matches = false
          break
        }
      }

      if (matches) {
        bitErrors = 0

        for (let i = 0; i < frameBits.length; i++) {
          if (reference.packetBits[i] !== frameBits[i]) {
            bitErrors++
          }
        }

        ber = bitErrors / frameBits.length
      }
    }

    return {
      text,
      payload,
      frameBits,
      snrDb: this.telemetry().snrDb,
      bitErrors,
      ber,
    }
  }

  telemetry(): DemodulatorTelemetry {
    let bestCoherence = 0
    let bestPower = 0
    let power0 = 0
    let power1 = 0

    for (const phase of this.phases) {
      const peak = Math.max(phase.power0, phase.power1)

      if (peak > bestPower) {
        bestPower = peak
        power0 = phase.power0
        power1 = phase.power1
      }

      if (phase.coherence > bestCoherence) {
        bestCoherence = phase.coherence
      }
    }

    const carrierPresent =
      bestCoherence >= CARRIER_COHERENCE_THRESHOLD && bestPower > SILENCE_ENERGY

    return {
      carrierPresent,
      bit: carrierPresent ? (power1 > power0 ? 1 : 0) : null,
      frequency: carrierPresent ? (power1 > power0 ? this.carrier1 : this.carrier0) : null,
      coherence: bestCoherence,
      snrDb: coherenceToSnrDb(bestCoherence, this.symbolSamples),
      quality: qualityFromSnr(coherenceToSnrDb(bestCoherence, this.symbolSamples)),
      inputDb: this.lastInputDb,
      decodedBits: this.decodedBits,
      crcFailures: this.crcFailures,
    }
  }
}

/**
 * Converts spectral coherence into an estimated in-band SNR.
 *
 *   coherence ≈ 0.5 · γ/(γ+1) + (1/S)·1/(γ+1)
 *
 * where γ is the linear signal-to-noise ratio inside the symbol
 * window. Solving for γ gives the expression below.
 */
export function coherenceToSnrDb(coherence: number, symbolSamples: number): number {
  const floor = 1 / symbolSamples
  const clamped = Math.min(0.499, Math.max(floor, coherence))
  const gamma = (clamped - floor) / (0.5 - clamped)
  const db = 10 * Math.log10(Math.max(1e-4, gamma))

  return Math.max(-10, Math.min(30, db))
}

export function qualityFromSnr(snrDb: number): number {
  return Math.max(0, Math.min(100, Math.round(((snrDb + 6) / 26) * 100)))
}
