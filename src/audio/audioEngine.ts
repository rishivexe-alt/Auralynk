// ============================================================
// Auralynk output stage.
//
// One shared AudioContext for every sound the application
// produces: BFSK transmissions, calibration sweeps and carrier
// test tones. Creating (and re-creating) AudioContexts
// unnecessarily is a common source of browser glitches, so the
// context is created lazily and reused.
// ============================================================

export class AudioEngine {
  private contextInstance: AudioContext | null = null
  private oscillator: OscillatorNode | null = null
  private toneGain: GainNode | null = null

  /** Creates the context if needed and resumes it if suspended. */
  async ensureContext(): Promise<AudioContext> {
    if (!this.contextInstance) {
      this.contextInstance = new AudioContext({ latencyHint: 'interactive' })
    }

    if (this.contextInstance.state === 'suspended') {
      await this.contextInstance.resume()
    }

    return this.contextInstance
  }

  /** The output context, or null before the first user gesture. */
  get context(): AudioContext | null {
    return this.contextInstance
  }

  get sampleRate(): number {
    return this.contextInstance?.sampleRate ?? 0
  }

  /**
   * Starts a continuous sine tone. Used by the calibration sweep.
   * Any tone already playing is stopped first.
   */
  async startTone(frequency: number, amplitude: number): Promise<void> {
    const context = await this.ensureContext()

    this.stopTone()

    const oscillator = context.createOscillator()
    const gain = context.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, context.currentTime)

    const now = context.currentTime
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(amplitude, now + 0.02)

    oscillator.connect(gain)
    gain.connect(context.destination)

    oscillator.start(now)

    this.oscillator = oscillator
    this.toneGain = gain
  }

  stopTone(): void {
    if (this.oscillator) {
      const oscillator = this.oscillator
      const gain = this.toneGain
      const context = this.contextInstance

      this.oscillator = null
      this.toneGain = null

      if (context && gain) {
        const now = context.currentTime
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03)
      }

      oscillator.onended = null

      try {
        oscillator.stop(context ? context.currentTime + 0.05 : 0)
      } catch {
        // oscillator already stopped
      }

      window.setTimeout(() => {
        oscillator.disconnect()
        gain?.disconnect()
      }, 120)
    }
  }

  /** Plays a tone for a fixed duration, then stops it. */
  async playTone(frequency: number, durationMs: number, amplitude = 0.06): Promise<void> {
    await this.startTone(frequency, amplitude)

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, durationMs)
    })

    this.stopTone()
  }

  /** Audible/ultrasonic carrier check used by calibration. */
  async testCarrier(frequency: number): Promise<void> {
    await this.playTone(frequency, 1500, 0.06)
  }

  async close(): Promise<void> {
    this.stopTone()

    if (this.contextInstance) {
      await this.contextInstance.close()
      this.contextInstance = null
    }
  }
}
