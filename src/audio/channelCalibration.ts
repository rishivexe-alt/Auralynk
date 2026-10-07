// ============================================================
// Auralynk channel calibration.
//
// There is exactly one calibration implementation in the
// project. It reuses the microphone owner and the output
// engine owned by the application, so no extra AudioContext or
// second microphone stream is ever opened.
//
// What it actually measures (nothing is fabricated):
//   1. the microphone noise floor with no test tone present,
//   2. the received level at every frequency of a tone sweep,
//      together with the LOCAL spectral floor around that
//      frequency while the tone plays.
// The local floor is what the receiver's Goertzel integrator
// actually competes against, so the sweep is scored on measured
// narrowband SNR (tone level − local floor) rather than tone
// level minus the broadband RMS. From that it *chooses* the two
// carriers: the pair, 250 Hz .. 3 kHz apart, whose weaker member
// has the largest narrowband SNR. Link margin, carrier imbalance
// and a verdict are computed from the same measurements.
// ============================================================

import { type AudioEngine } from './audioEngine'
import { type MicrophoneAnalyzer } from './microphoneAnalyzer'
import { type BfskConfig } from './bfskModem'

export type CalibrationVerdict = 'good' | 'marginal' | 'poor'

export interface SweepPoint {
  frequency: number
  magnitude: number
  noiseDb: number
}

export interface SweepOptions {
  startHz: number
  stopHz: number
  stepHz: number
  dwellMs: number
}

export interface CalibrationReport {
  sweep: SweepOptions
  points: SweepPoint[]
  noiseFloorDb: number
  sampleRate: number
  carrier0: number
  carrier1: number
  level0Db: number
  level1Db: number
  imbalanceDb: number
  /** Narrowband SNR margins (tone level − local spectral floor). */
  margin0Db: number
  margin1Db: number
  minMarginDb: number
  verdict: CalibrationVerdict
  summary: string
  notes: string[]
  timestamp: number
}

export interface CalibrationProgress {
  phase: 'idle' | 'noise' | 'sweep' | 'done'
  step: number
  total: number
  frequency?: number
  detail: string
}

const NOISE_MS = 600
const TONE_AMPLITUDE = 0.25
const SAMPLE_INTERVAL_MS = 50
const SETTLE_MS = 60
const MAX_SWEEP_POINTS = 120

/** Probe the local spectral floor this far above each tone. */
const GUARD_OFFSET_HZ = 240
const GUARD_SEARCH_HZ = 60
/** Quantile of guard samples used as the local noise estimate. */
const NOISE_PERCENTILE = 0.25

const MIN_PAIR_SEPARATION_HZ = 250
const MAX_PAIR_SEPARATION_HZ = 3000

const GOOD_MARGIN_DB = 25
const MARGINAL_MARGIN_DB = 12

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function abortError(): Error {
  const error = new Error('Calibration aborted.')
  error.name = 'AbortError'
  return error
}

export class ChannelCalibration {
  private readonly microphone: MicrophoneAnalyzer
  private readonly engine: AudioEngine
  private abortRequested = false
  private running = false

  constructor(microphone: MicrophoneAnalyzer, engine: AudioEngine) {
    this.microphone = microphone
    this.engine = engine
  }

  get isRunning(): boolean {
    return this.running
  }

  abort(): void {
    this.abortRequested = true
    void this.engine.stopTone()
  }

  async run(
    options: SweepOptions,
    onProgress?: (progress: CalibrationProgress) => void,
  ): Promise<CalibrationReport> {
    if (this.running) {
      throw new Error('A calibration run is already in progress.')
    }

    this.running = true
    this.abortRequested = false

    try {
      await this.microphone.start()

      const sampleRate = this.microphone.getSampleRate() || 48000
      const nyquist = sampleRate / 2
      const startHz = Math.max(200, Math.round(options.startHz))
      const stopHz = Math.round(Math.min(options.stopHz, nyquist - 500))
      const stepHz = Math.max(50, Math.round(options.stepHz))

      if (stopHz <= startHz) {
        throw new Error('The sweep range does not fit below the Nyquist limit of this device.')
      }

      const points: SweepPoint[] = []

      for (let f = startHz; f <= stopHz; f += stepHz) {
        points.push({ frequency: f, magnitude: -120, noiseDb: -120 })
      }

      if (points.length > MAX_SWEEP_POINTS) {
        throw new Error(
          `Sweep would run ${points.length} tones (limit ${MAX_SWEEP_POINTS}). Increase STEP or narrow the range.`,
        )
      }

      const total = points.length + 1
      let step = 0

      onProgress?.({
        phase: 'noise',
        step: ++step,
        total,
        detail: 'Measuring the microphone noise floor…',
      })

      const noiseFloorDb = await this.measureNoiseFloor(NOISE_MS)

      this.throwIfAborted()

      const dwellMs = Math.max(100, Math.round(options.dwellMs))

      for (const point of points) {
        this.throwIfAborted()

        onProgress?.({
          phase: 'sweep',
          step: ++step,
          total,
          frequency: point.frequency,
          detail: `Sweeping ${point.frequency} Hz (${step} of ${total})…`,
        })

        const measured = await this.measureTone(point.frequency, dwellMs)

        point.magnitude = measured.signalDb
        point.noiseDb = measured.noiseDb
      }

      await this.engine.stopTone()
      await sleep(150)

      onProgress?.({
        phase: 'done',
        step: total,
        total,
        detail: 'Selecting carrier pair…',
      })

      const report = this.evaluate(options, points, noiseFloorDb, sampleRate)

      onProgress?.({
        phase: 'done',
        step: total,
        total,
        detail: 'Calibration complete.',
      })

      return report
    } catch (error) {
      await this.engine.stopTone()

      if (this.abortRequested && !(error instanceof Error && error.name === 'AbortError')) {
        throw abortError()
      }

      throw error
    } finally {
      this.running = false
      this.abortRequested = false
      await this.engine.stopTone()
    }
  }

  private throwIfAborted(): void {
    if (this.abortRequested) {
      throw abortError()
    }
  }

  /** Median of the instantaneous RMS level over `durationMs` of silence. */
  private async measureNoiseFloor(durationMs: number): Promise<number> {
    const samples: number[] = []
    const started = performance.now()

    while (performance.now() - started < durationMs) {
      samples.push(this.microphone.getLevelDb())
      await sleep(SAMPLE_INTERVAL_MS)
    }

    if (samples.length === 0) {
      return -120
    }

    samples.sort((a, b) => a - b)
    const middle = Math.floor(samples.length / 2)

    return samples.length % 2 === 0
      ? (samples[middle - 1] + samples[middle]) / 2
      : samples[middle]
  }

  /**
   * Peak spectral magnitude at `frequency` plus the local spectral
   * floor in the guard band just above it, while the tone plays.
   */
  private async measureTone(
    frequency: number,
    dwellMs: number,
  ): Promise<{ signalDb: number; noiseDb: number }> {
    await this.engine.startTone(frequency, TONE_AMPLITUDE)

    let peak = -Infinity
    const noiseDb: number[] = []
    const started = performance.now()

    while (performance.now() - started < dwellMs) {
      if (this.abortRequested) {
        break
      }

      const measurement = this.microphone.findFrequency(frequency, 120)

      if (measurement && measurement.magnitude > peak) {
        peak = measurement.magnitude
      }

      const guard = this.microphone.findFrequency(frequency + GUARD_OFFSET_HZ, GUARD_SEARCH_HZ)

      if (guard) {
        noiseDb.push(guard.magnitude)
      }

      await sleep(SAMPLE_INTERVAL_MS)
    }

    await this.engine.stopTone()
    await sleep(SETTLE_MS)

    const signalDb = Number.isFinite(peak) ? peak : -120
    const localFloor =
      noiseDb.length === 0 ? -120 : percentileDb(noiseDb.slice().sort((a, b) => a - b), NOISE_PERCENTILE)

    return { signalDb, noiseDb: localFloor }
  }

  /** Picks the carrier pair whose weaker member has the best narrowband SNR. */
  private evaluate(
    options: SweepOptions,
    points: SweepPoint[],
    noiseFloorDb: number,
    sampleRate: number,
  ): CalibrationReport {
    let best = { index0: 0, index1: Math.min(1, points.length - 1), score: -Infinity, imbalance: 0 }

    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const separation = points[j].frequency - points[i].frequency

        if (separation < MIN_PAIR_SEPARATION_HZ || separation > MAX_PAIR_SEPARATION_HZ) {
          continue
        }

        const snrI = points[i].magnitude - points[i].noiseDb
        const snrJ = points[j].magnitude - points[j].noiseDb
        const weaker = Math.min(snrI, snrJ)
        const imbalance = Math.abs(points[i].magnitude - points[j].magnitude)

        if (weaker > best.score) {
          best = { index0: i, index1: j, score: weaker, imbalance }
        }
      }
    }

    const carrier0 = points[best.index0].frequency
    const carrier1 = points[best.index1].frequency
    const level0Db = points[best.index0].magnitude
    const level1Db = points[best.index1].magnitude
    const margin0Db = level0Db - points[best.index0].noiseDb
    const margin1Db = level1Db - points[best.index1].noiseDb
    const minMarginDb = Math.min(margin0Db, margin1Db)
    const imbalanceDb = Math.abs(level0Db - level1Db)

    const verdict: CalibrationVerdict =
      minMarginDb >= GOOD_MARGIN_DB
        ? 'good'
        : minMarginDb >= MARGINAL_MARGIN_DB
          ? 'marginal'
          : 'poor'

    const notes: string[] = []

    if (minMarginDb < 0) {
      notes.push(
        'The best available pair still sits at or below the local noise floor (-negative margin measured). A reliable packet link is very unlikely here — raise the volume, move the microphone closer to the speaker and quiet the room first.',
      )
    }

    if (noiseFloorDb > -45) {
      notes.push('The broadband noise floor is high — reduce background sound or gain before transmitting.')
    }

    if (imbalanceDb > 6) {
      notes.push(
        `The two carriers differ by ${imbalanceDb.toFixed(1)} dB — one bit is much weaker than the other.`,
      )
    }

    if (points.length < 3) {
      notes.push('The sweep produced fewer than three points — widen the range or lower STEP.')
    }

    if (notes.length === 0) {
      notes.push('Both carriers sit well above the local noise floor with a balanced response.')
    }

    const summary =
      verdict === 'good'
        ? `Link margin ${minMarginDb.toFixed(1)} dB at ${carrier0} / ${carrier1} Hz — a reliable acoustic link is expected.`
        : verdict === 'marginal'
          ? `Link margin ${minMarginDb.toFixed(1)} dB at ${carrier0} / ${carrier1} Hz — the link will work intermittently; increase volume or move closer.`
          : `Link margin ${minMarginDb.toFixed(1)} dB at ${carrier0} / ${carrier1} Hz — the carriers are at or below the local noise floor; no reliable packet link is expected under the current acoustic conditions.`

    return {
      sweep: options,
      points,
      noiseFloorDb,
      sampleRate,
      carrier0,
      carrier1,
      level0Db,
      level1Db,
      imbalanceDb,
      margin0Db,
      margin1Db,
      minMarginDb,
      verdict,
      summary,
      notes,
      timestamp: Date.now(),
    }
  }
}

/** Ordered array → the `q` (0..1) quantile in dB. */
function percentileDb(sorted: number[], q: number): number {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)))

  return sorted[index]
}

/** True when both carriers could physically be produced by `sampleRate`. */
export function carriersFitSampleRate(config: BfskConfig, sampleRate: number): boolean {
  if (sampleRate <= 0) {
    return true
  }

  return config.carrier0 < sampleRate / 2 && config.carrier1 < sampleRate / 2
}
