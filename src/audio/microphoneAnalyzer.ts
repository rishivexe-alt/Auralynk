// ============================================================
// Auralynk input stage.
//
// Single owner of the microphone: one AudioContext, one
// MediaStream, one analyser. Both the BFSK receiver and the
// channel calibration sweep attach to this instance, so the
// application never opens two microphone streams at once.
// ============================================================

export interface FrequencyMeasurement {
  frequency: number
  magnitude: number
  sampleRate: number
}

export class MicrophoneAnalyzer {
  private contextInstance: AudioContext | null = null
  private stream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private spectrumBuffer: Float32Array<ArrayBuffer> | null = null
  private startPromise: Promise<void> | null = null

  async start(): Promise<void> {
    if (this.contextInstance && this.stream) {
      return
    }

    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.openMicrophone()

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async openMicrophone(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone input is not supported by this browser.')
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    })

    let context: AudioContext

    try {
      context = new AudioContext({ latencyHint: 'interactive' })
    } catch {
      stream.getTracks().forEach((track) => track.stop())
      throw new Error('Web Audio is unavailable in this browser.')
    }

    if (context.state === 'suspended') {
      await context.resume()
    }

    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()

    analyser.fftSize = 4096
    analyser.smoothingTimeConstant = 0
    analyser.minDecibels = -110
    analyser.maxDecibels = -10

    source.connect(analyser)

    this.contextInstance = context
    this.stream = stream
    this.sourceNode = source
    this.analyser = analyser
    this.spectrumBuffer = new Float32Array(analyser.frequencyBinCount)
  }

  get isActive(): boolean {
    return this.contextInstance !== null && this.stream !== null
  }

  get context(): AudioContext | null {
    return this.contextInstance
  }

  get source(): MediaStreamAudioSourceNode | null {
    return this.sourceNode
  }

  get analyserNode(): AnalyserNode | null {
    return this.analyser
  }

  getSampleRate(): number {
    return this.contextInstance?.sampleRate ?? 0
  }

  /** Attaches an extra processing node to the microphone source. */
  attach(node: AudioNode): void {
    this.sourceNode?.connect(node)
  }

  detach(node: AudioNode): void {
    try {
      this.sourceNode?.disconnect(node)
    } catch {
      // already disconnected
    }
  }

  getFrequencyData(): Float32Array | null {
    if (!this.analyser || !this.spectrumBuffer) {
      return null
    }

    this.analyser.getFloatFrequencyData(this.spectrumBuffer)

    return this.spectrumBuffer
  }

  /**
   * Peak magnitude around `targetFrequency` within `searchHz`.
   * Returns null when the microphone is not running.
   */
  findFrequency(targetFrequency: number, searchHz = 250): FrequencyMeasurement | null {
    if (!this.analyser || !this.contextInstance || !this.spectrumBuffer) {
      return null
    }

    this.analyser.getFloatFrequencyData(this.spectrumBuffer)

    const data = this.spectrumBuffer
    const sampleRate = this.contextInstance.sampleRate
    const binWidth = sampleRate / this.analyser.fftSize

    const startBin = Math.max(0, Math.floor((targetFrequency - searchHz) / binWidth))
    const endBin = Math.min(data.length - 1, Math.ceil((targetFrequency + searchHz) / binWidth))

    let bestBin = startBin
    let bestMagnitude = -Infinity

    for (let i = startBin; i <= endBin; i++) {
      if (data[i] > bestMagnitude) {
        bestMagnitude = data[i]
        bestBin = i
      }
    }

    if (!Number.isFinite(bestMagnitude)) {
      return null
    }

    return {
      frequency: bestBin * binWidth,
      magnitude: bestMagnitude,
      sampleRate,
    }
  }

  /** RMS level of the microphone signal in dBFS. */
  getLevelDb(): number {
    const analyser = this.analyser

    if (!analyser) {
      return -120
    }

    const buffer = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buffer)

    let sumSquares = 0

    for (let i = 0; i < buffer.length; i++) {
      sumSquares += buffer[i] * buffer[i]
    }

    const rms = Math.sqrt(sumSquares / buffer.length)

    return rms > 0 ? 20 * Math.log10(rms) : -120
  }

  stop(): void {
    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.sourceNode = null
    }

    if (this.analyser) {
      this.analyser.disconnect()
      this.analyser = null
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }

    this.spectrumBuffer = null

    const context = this.contextInstance
    this.contextInstance = null

    if (context) {
      void context.close().catch(() => undefined)
    }
  }
}
