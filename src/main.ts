// ============================================================
// Auralynk application controller.
//
// Binds the page to the audio layer:
//   engine        one shared output AudioContext
//   microphone    one shared input stream + analyser
//   transmitter   BFSK framing -> AudioBuffer -> speakers
//   receiver      microphone PCM -> BFSK demodulator -> text
//   calibration   tone sweep over the shared engine/microphone
//
// All signal processing lives in src/audio/*; this file only
// handles the document, the state transitions and the numbers
// that are shown to the user.
// ============================================================

import './style.css'
import { APP_TEMPLATE } from './appTemplate'
import { AudioEngine } from './audio/audioEngine'
import { MicrophoneAnalyzer } from './audio/microphoneAnalyzer'
import { BfskTransmitter } from './audio/transmitter'
import { BfskReceiver } from './audio/receiver'
import {
  ChannelCalibration,
  type CalibrationProgress,
  type CalibrationReport,
} from './audio/channelCalibration'
import {
  buildPacket,
  DEFAULT_BFSK_CONFIG,
  type EncodedPacket,
  getTransmissionInfo,
  MAX_PAYLOAD_BYTES,
  PREAMBLE_BITS,
  textToUtf8,
  validateBfskConfig,
} from './audio/bfskModem'
import type { BfskConfig } from './audio/bfskModem'
import type { DemodulatorFrame, DemodulatorTelemetry } from './audio/bfskDemodulator'

// ------------------------------------------------------------
// Mount
// ------------------------------------------------------------

const root = document.querySelector<HTMLDivElement>('#app')

if (!root) {
  throw new Error('Application root #app was not found.')
}

root.innerHTML = APP_TEMPLATE

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)

  if (!element) {
    throw new Error(`Missing required element #${id}.`)
  }

  return element as T
}

const systemStatusText = byId<HTMLSpanElement>('system-status-text')
const launchTransmitterButton = byId<HTMLButtonElement>('launch-transmitter')
const launchReceiverButton = byId<HTMLButtonElement>('launch-receiver')

const heroFrequency0 = byId<HTMLDivElement>('hero-frequency-0')
const heroFrequency1 = byId<HTMLDivElement>('hero-frequency-1')
const heroDataRate = byId<HTMLElement>('hero-data-rate')
const heroLink = byId<HTMLElement>('hero-link')

const message = byId<HTMLTextAreaElement>('message')
const characterCount = byId<HTMLSpanElement>('character-count')
const frequency0Input = byId<HTMLInputElement>('frequency-0')
const frequency1Input = byId<HTMLInputElement>('frequency-1')
const symbolTimeInput = byId<HTMLInputElement>('symbol-time')
const packetMeta = byId<HTMLElement>('packet-meta')
const transmitButton = byId<HTMLButtonElement>('transmit-button')
const txStatusText = byId<HTMLElement>('tx-status-text')
const txStatus = byId<HTMLDivElement>('tx-status')

const receiverState = byId<HTMLDivElement>('receiver-state')
const receiverDescription = byId<HTMLDivElement>('receiver-description')
const inputLevel = byId<HTMLSpanElement>('input-level')
const meterFill = byId<HTMLDivElement>('meter-fill')
const detectedFrequency = byId<HTMLElement>('detected-frequency')
const detectedBit = byId<HTMLElement>('detected-bit')
const decodedMessage = byId<HTMLDivElement>('decoded-message')
const crcStatus = byId<HTMLSpanElement>('crc-status')
const listenButton = byId<HTMLButtonElement>('listen-button')
const rxStatus = byId<HTMLDivElement>('rx-status')

const spectrumCanvas = byId<HTMLCanvasElement>('spectrum-canvas')
const spectrumEmpty = byId<HTMLDivElement>('spectrum-empty')
const spectrumState = byId<HTMLElement>('spectrum-state')
const frequencyAxis = byId<HTMLDivElement>('frequency-axis')

const snrValue = byId<HTMLElement>('snr-value')
const decodedBits = byId<HTMLElement>('decoded-bits')
const crcFails = byId<HTMLElement>('crc-fails')
const berValue = byId<HTMLElement>('ber-value')
const packetCount = byId<HTMLElement>('packet-count')
const packetLoss = byId<HTMLElement>('packet-loss')
const qualityLabel = byId<HTMLElement>('quality-label')
const qualityFill = byId<HTMLDivElement>('quality-fill')
const telemetryNote = byId<HTMLElement>('telemetry-note')

const calibrationStatus = byId<HTMLElement>('calibration-status')
const calibrationStart = byId<HTMLInputElement>('calibration-start')
const calibrationStop = byId<HTMLInputElement>('calibration-stop')
const calibrationStep = byId<HTMLInputElement>('calibration-step')
const calibrationDwell = byId<HTMLInputElement>('calibration-dwell')
const calibrationProgress = byId<HTMLDivElement>('calibration-progress')
const calibrationResults = byId<HTMLDivElement>('calibration-results')
const calibrationButton = byId<HTMLButtonElement>('calibration-button')
const calibrationQuality = byId<HTMLElement>('calibration-quality')
const calibratedF0 = byId<HTMLElement>('calibrated-f0')
const calibratedF1 = byId<HTMLElement>('calibrated-f1')
const calibratedSnr = byId<HTMLElement>('calibrated-snr')
const calibratedNoise = byId<HTMLElement>('calibrated-noise')
const applyCalibrationButton = byId<HTMLButtonElement>('apply-calibration')

const spectrumContext = spectrumCanvas.getContext('2d')
const sweepCanvas = byId<HTMLCanvasElement>('sweep-canvas')

// ------------------------------------------------------------
// Audio services
// ------------------------------------------------------------

const engine = new AudioEngine()
const microphone = new MicrophoneAnalyzer()
const transmitter = new BfskTransmitter(engine)

const receiver = new BfskReceiver(microphone, {
  onTelemetry: handleTelemetry,
  onFrame: handleFrame,
})

const calibration = new ChannelCalibration(microphone, engine)

// ------------------------------------------------------------
// UI state
// ------------------------------------------------------------

type Tone = 'idle' | 'busy' | 'ok' | 'error'

let packetsOk = 0
let packetsLost = 0
let lastBer: number | null = null
let lastFrameAt = 0
let lastReport: CalibrationReport | null = null
let axisSampleRate = 0

// A "packet" is measured per carrier burst: one acoustic
// transmission is a burst of carrier energy that starts, delivers
// (or fails to deliver) a frame, and stops. Counting bursts —
// not every CRC retry from the parallel phase hypotheses — is the
// only figure that reflects real packet loss.
const BURST_END_MS = 250
let burstStartAt: number | null = null
let burstAbsentSince: number | null = null
let burstDecoded = false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error.'
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function nyquistLimit(): number {
  const inputRate = microphone.getSampleRate()

  if (inputRate > 0) {
    return inputRate / 2
  }

  const outputRate = engine.sampleRate

  if (outputRate > 0) {
    return outputRate / 2
  }

  return 22050
}

function readConfig(): { config: BfskConfig; error: string | null } {
  const config: BfskConfig = {
    carrier0: Number(frequency0Input.value),
    carrier1: Number(frequency1Input.value),
    symbolTimeMs: Number(symbolTimeInput.value),
    amplitude: DEFAULT_BFSK_CONFIG.amplitude,
  }

  return { config, error: validateBfskConfig(config, nyquistLimit()) }
}

function setTxStatus(text: string, tone: Tone = 'idle'): void {
  txStatusText.textContent = text
  txStatus.dataset.tone = tone
}

function setRxStatus(text: string): void {
  rxStatus.textContent = text
}

// ------------------------------------------------------------
// Transmitter panel
// ------------------------------------------------------------

function updateCharacterCount(): void {
  const bytes = textToUtf8(message.value).length

  characterCount.textContent = `${bytes} / ${MAX_PAYLOAD_BYTES} BYTES`
  characterCount.classList.toggle('over', bytes > MAX_PAYLOAD_BYTES)
}

function updateHeroDisplay(): void {
  const { config } = readConfig()

  heroFrequency0.textContent = Number.isFinite(config.carrier0)
    ? (config.carrier0 / 1000).toFixed(1)
    : '—'
  heroFrequency1.textContent = Number.isFinite(config.carrier1)
    ? (config.carrier1 / 1000).toFixed(1)
    : '—'
  heroDataRate.textContent =
    Number.isFinite(config.symbolTimeMs) && config.symbolTimeMs > 0
      ? `${(1000 / config.symbolTimeMs).toFixed(0)} bps`
      : '—'
}

function updatePacketMeta(): void {
  try {
    const packet = buildPacket(message.value)
    const info = getTransmissionInfo(packet, readConfig().config)

    packetMeta.textContent =
      `FRAME ${info.packetBytes} BYTES · ${info.totalBits} SYMBOLS · ` +
      `${info.durationMs} MS · CRC ${info.crc}`
  } catch {
    packetMeta.textContent = `MESSAGE EXCEEDS ${MAX_PAYLOAD_BYTES} UTF-8 BYTES`
  }
}

function handleConfigChanged(): void {
  updateHeroDisplay()
  updatePacketMeta()

  const { config, error } = readConfig()

  if (receiver.isRunning) {
    if (error) {
      setRxStatus(error.toUpperCase())
    } else {
      receiver.updateConfig(config)
      setRxStatus(
        `MICROPHONE ACTIVE · ${microphone.getSampleRate().toLocaleString()} Hz · ` +
          `${config.carrier0.toLocaleString()}/${config.carrier1.toLocaleString()} Hz`,
      )
    }
  }

  if (error) {
    setTxStatus(error, 'error')
  } else if (!transmitter.isTransmitting) {
    setTxStatus('READY TO TRANSMIT', 'idle')
  }
}

function setTransmittingUi(active: boolean): void {
  transmitButton.classList.toggle('active', active)
  transmitButton.innerHTML = active
    ? '<span class="transmit-symbol">■</span> STOP TRANSMISSION'
    : '<span class="transmit-symbol">▶</span> TRANSMIT MESSAGE'
  heroLink.textContent = active ? 'TX ACTIVE' : receiver.isRunning ? 'RX LIVE' : 'READY'
}

async function handleTransmitClick(): Promise<void> {
  if (transmitter.isTransmitting) {
    transmitter.stop()
    return
  }

  const text = message.value

  if (!text) {
    setTxStatus('ENTER A MESSAGE FIRST', 'error')
    message.focus()
    return
  }

  const { config, error } = readConfig()

  if (error) {
    setTxStatus(error, 'error')
    return
  }

  let packet: EncodedPacket

  try {
    packet = buildPacket(text)
  } catch (buildError) {
    setTxStatus(errorMessage(buildError), 'error')
    return
  }

  const info = getTransmissionInfo(packet, config)

  // A loopback reference is what makes the BER figure a real
  // measurement instead of a decorative number.
  receiver.setReference({
    packetBits: packet.bits.slice(PREAMBLE_BITS.length),
    payload: packet.payload,
  })

  setTransmittingUi(true)
  setTxStatus(
    `TRANSMITTING · ${info.totalBits} SYMBOLS · ${info.durationMs} MS`,
    'busy',
  )

  try {
    const result = await transmitter.transmitPacket(packet, config, (fraction) => {
      setTxStatus(
        `TRANSMITTING · ${Math.round(fraction * 100)}% · ${info.totalBits} SYMBOLS`,
        'busy',
      )
    })

    setTxStatus(
      result.outcome === 'completed'
        ? `COMPLETE · ${info.totalBits} SYMBOLS · ${info.durationMs} MS · CRC ${info.crc}`
        : 'TRANSMISSION STOPPED',
      result.outcome === 'completed' ? 'ok' : 'idle',
    )
  } catch (transmitError) {
    setTxStatus(errorMessage(transmitError), 'error')
  } finally {
    receiver.setReference(null)
    setTransmittingUi(false)
  }
}

// ------------------------------------------------------------
// Receiver panel
// ------------------------------------------------------------

function handleTelemetry(telemetry: DemodulatorTelemetry): void {
  inputLevel.textContent = `${telemetry.inputDb.toFixed(1)} dBFS`
  meterFill.style.width = `${clampPercent(((telemetry.inputDb + 60) / 60) * 100)}%`

  detectedFrequency.textContent = telemetry.frequency
    ? `${Math.round(telemetry.frequency).toLocaleString()} Hz`
    : '—'
  detectedBit.textContent = telemetry.bit === null ? '—' : String(telemetry.bit)

  snrValue.textContent = telemetry.carrierPresent ? `${telemetry.snrDb.toFixed(1)} dB` : '—'

  decodedBits.textContent = telemetry.decodedBits.toLocaleString()
  crcFails.textContent = telemetry.crcFailures.toLocaleString()

  trackCarrierBurst(telemetry.carrierPresent)

  const attempts = packetsOk + packetsLost

  packetCount.textContent = String(packetsOk)
  packetLoss.textContent = attempts > 0 ? `${((packetsLost / attempts) * 100).toFixed(1)}%` : '—'
  berValue.textContent = lastBer === null ? '—' : `${(lastBer * 100).toFixed(2)}%`

  const frameIsFresh = lastFrameAt > 0 && performance.now() - lastFrameAt < 3000

  if (frameIsFresh) {
    qualityLabel.textContent = 'PACKET DECODED'
  } else if (telemetry.carrierPresent) {
    qualityLabel.textContent = 'RECEIVING BFSK'
  } else if (receiver.isRunning) {
    qualityLabel.textContent = 'SEARCHING'
  } else {
    qualityLabel.textContent = 'STANDBY'
  }

  qualityFill.style.width = `${telemetry.quality}%`

  telemetryNote.textContent =
    lastBer === null
      ? 'BER appears once a packet is decoded against the transmitted reference.'
      : `BER measured against ${packetsOk} loopback frame${packetsOk === 1 ? '' : 's'}.`
}

function handleFrame(frame: DemodulatorFrame): void {
  packetsOk++
  burstDecoded = true
  lastBer = frame.ber
  lastFrameAt = performance.now()

  decodedMessage.textContent = frame.text
  crcStatus.textContent = 'CRC OK'
  crcStatus.dataset.state = 'ok'
}

function trackCarrierBurst(carrierPresent: boolean): void {
  const now = performance.now()

  if (carrierPresent) {
    burstAbsentSince = null

    if (burstStartAt === null) {
      burstStartAt = now
      burstDecoded = false
    }

    return
  }

  if (burstStartAt === null) {
    return
  }

  if (burstAbsentSince === null) {
    burstAbsentSince = now

    return
  }

  if (now - burstAbsentSince < BURST_END_MS) {
    return
  }

  if (!burstDecoded) {
    packetsLost++
    crcStatus.textContent = 'CRC FAIL'
    crcStatus.dataset.state = 'fail'
  }

  burstStartAt = null
  burstAbsentSince = null
  burstDecoded = false
}

function resetReceiverCounters(): void {
  packetsOk = 0
  packetsLost = 0
  lastBer = null
  lastFrameAt = 0
  burstStartAt = null
  burstAbsentSince = null
  burstDecoded = false

  packetCount.textContent = '0'
  packetLoss.textContent = '—'
  berValue.textContent = '—'
  snrValue.textContent = '—'
  decodedBits.textContent = '0'
  crcFails.textContent = '0'
  qualityFill.style.width = '0%'
  qualityLabel.textContent = 'STANDBY'
  crcStatus.textContent = 'CRC —'
  crcStatus.dataset.state = ''
  telemetryNote.textContent =
    'BER appears once a packet is decoded against the transmitted reference.'
}

function setReceiverUiActive(): void {
  const sampleRate = microphone.getSampleRate()
  const { config } = readConfig()

  receiverState.textContent = 'LISTENING'
  receiverDescription.textContent = 'Microphone input is being demodulated in real time'
  setRxStatus(
    `MICROPHONE ACTIVE · ${sampleRate.toLocaleString()} Hz · ` +
      `${config.carrier0.toLocaleString()}/${config.carrier1.toLocaleString()} Hz`,
  )
  listenButton.innerHTML = '<span>■</span> STOP LISTENING'
  listenButton.classList.add('active')
  heroLink.textContent = transmitter.isTransmitting ? 'TX ACTIVE' : 'RX LIVE'
  systemStatusText.textContent = 'RECEIVER ACTIVE'
}

function setReceiverUiStopped(): void {
  receiverState.textContent = 'STANDBY'
  receiverDescription.textContent = 'Microphone monitoring inactive'
  setRxStatus('MICROPHONE NOT ACTIVE')
  listenButton.innerHTML = '<span>◉</span> START LISTENING'
  listenButton.classList.remove('active')
  detectedFrequency.textContent = '—'
  detectedBit.textContent = '—'
  inputLevel.textContent = '-∞ dBFS'
  meterFill.style.width = '0%'
  heroLink.textContent = transmitter.isTransmitting ? 'TX ACTIVE' : 'READY'
  systemStatusText.textContent = 'SYSTEM READY'
}

function releaseMicrophoneIfIdle(): void {
  if (!receiver.isRunning && !calibration.isRunning) {
    microphone.stop()
  }
}

async function handleListenClick(): Promise<void> {
  if (receiver.isRunning) {
    receiver.stop()
    releaseMicrophoneIfIdle()
    setReceiverUiStopped()
    return
  }

  const { config, error } = readConfig()

  if (error) {
    setRxStatus(error.toUpperCase())
    receiverState.textContent = 'ERROR'
    receiverDescription.textContent = error
    return
  }

  listenButton.disabled = true

  try {
    await receiver.start(config)
    resetReceiverCounters()
    setReceiverUiActive()
    decodedMessage.textContent = 'Listening for acoustic carrier...'
  } catch (microphoneError) {
    receiverState.textContent = 'ERROR'
    receiverDescription.textContent = errorMessage(microphoneError)
    setRxStatus('MICROPHONE ACCESS FAILED')
    listenButton.innerHTML = '<span>◉</span> START LISTENING'
  } finally {
    listenButton.disabled = false
  }
}

// ------------------------------------------------------------
// Spectrum (real microphone data, drawn on a canvas)
// ------------------------------------------------------------

const SPECTRUM_MIN_DB = -110
const SPECTRUM_MAX_DB = -10

function drawSpectrum(data: Float32Array | null): void {
  if (!spectrumContext) {
    return
  }

  const width = spectrumCanvas.clientWidth
  const height = spectrumCanvas.clientHeight

  if (width < 2 || height < 2) {
    return
  }

  const pixelRatio = window.devicePixelRatio || 1
  const targetWidth = Math.round(width * pixelRatio)
  const targetHeight = Math.round(height * pixelRatio)

  if (spectrumCanvas.width !== targetWidth || spectrumCanvas.height !== targetHeight) {
    spectrumCanvas.width = targetWidth
    spectrumCanvas.height = targetHeight
  }

  const context = spectrumContext

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, width, height)

  // horizontal grid + dB labels
  context.strokeStyle = 'rgba(211, 180, 107, 0.12)'
  context.fillStyle = 'rgba(255, 255, 255, 0.35)'
  context.font = '10px "DM Mono", monospace'
  context.lineWidth = 1

  for (let db = SPECTRUM_MIN_DB; db <= SPECTRUM_MAX_DB; db += 20) {
    const y = Math.round(height - ((db - SPECTRUM_MIN_DB) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB)) * height) + 0.5

    context.beginPath()
    context.moveTo(0, y)
    context.lineTo(width, y)
    context.stroke()
    context.fillText(`${db}`, 4, y - 3)
  }

  if (!data || data.length === 0) {
    return
  }

  const sampleRate = microphone.getSampleRate() || 48000
  const nyquist = sampleRate / 2
  const { config } = readConfig()

  // carrier markers
  const markers: Array<{ frequency: number; label: string }> = [
    { frequency: config.carrier0, label: 'F0' },
    { frequency: config.carrier1, label: 'F1' },
  ]

  for (const marker of markers) {
    if (!Number.isFinite(marker.frequency) || marker.frequency >= nyquist) {
      continue
    }

    const x = Math.round((marker.frequency / nyquist) * width) + 0.5

    context.save()
    context.setLineDash([4, 4])
    context.strokeStyle = 'rgba(211, 180, 107, 0.55)'
    context.beginPath()
    context.moveTo(x, 0)
    context.lineTo(x, height)
    context.stroke()
    context.restore()

    context.fillStyle = 'rgba(211, 180, 107, 0.9)'
    context.fillText(`${marker.label} ${(marker.frequency / 1000).toFixed(1)}k`, x + 4, 12)
  }

  // spectrum trace
  const columns = Math.max(1, Math.floor(width))
  const binsPerColumn = data.length / columns

  context.beginPath()
  context.moveTo(0, height)

  for (let column = 0; column < columns; column++) {
    const from = Math.floor(column * binsPerColumn)
    const to = Math.max(from + 1, Math.floor((column + 1) * binsPerColumn))

    let peak = SPECTRUM_MIN_DB

    for (let bin = from; bin < to && bin < data.length; bin++) {
      const value = data[bin]

      if (Number.isFinite(value) && value > peak) {
        peak = value
      }
    }

    const normalised = (Math.max(SPECTRUM_MIN_DB, Math.min(SPECTRUM_MAX_DB, peak)) - SPECTRUM_MIN_DB) /
      (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB)

    context.lineTo(column + 0.5, height - normalised * height)
  }

  context.lineTo(width, height)
  context.closePath()
  context.fillStyle = 'rgba(211, 180, 107, 0.28)'
  context.fill()

  context.strokeStyle = 'rgba(232, 208, 148, 0.9)'
  context.lineWidth = 1.25
  context.beginPath()

  for (let column = 0; column < columns; column++) {
    const from = Math.floor(column * binsPerColumn)
    const to = Math.max(from + 1, Math.floor((column + 1) * binsPerColumn))

    let peak = SPECTRUM_MIN_DB

    for (let bin = from; bin < to && bin < data.length; bin++) {
      const value = data[bin]

      if (Number.isFinite(value) && value > peak) {
        peak = value
      }
    }

    const normalised = (Math.max(SPECTRUM_MIN_DB, Math.min(SPECTRUM_MAX_DB, peak)) - SPECTRUM_MIN_DB) /
      (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB)
    const y = height - normalised * height

    if (column === 0) {
      context.moveTo(0.5, y)
    } else {
      context.lineTo(column + 0.5, y)
    }
  }

  context.stroke()
}

function updateFrequencyAxis(sampleRate: number): void {
  if (sampleRate === axisSampleRate) {
    return
  }

  axisSampleRate = sampleRate
  const nyquist = sampleRate / 2
  const labels = frequencyAxis.querySelectorAll('span')

  for (let i = 0; i < labels.length; i++) {
    const fraction = i / (labels.length - 1)
    const frequency = nyquist * fraction

    labels[i].textContent =
      frequency >= 1000 ? `${(frequency / 1000).toFixed(fraction === 0 ? 0 : 1)} kHz` : `${Math.round(frequency)} Hz`
  }
}

function animationLoop(): void {
  window.requestAnimationFrame(animationLoop)

  const active = microphone.isActive
  const data = active ? microphone.getFrequencyData() : null

  spectrumEmpty.hidden = active

  if (active) {
    const sampleRate = microphone.getSampleRate()
    spectrumState.textContent = `● LIVE · ${(sampleRate / 1000).toFixed(1)} kHz`
    updateFrequencyAxis(sampleRate)
  } else {
    spectrumState.textContent = 'MICROPHONE OFFLINE'
  }

  drawSpectrum(active ? data : null)
}

// ------------------------------------------------------------
// Channel calibration
// ------------------------------------------------------------

function setCalibrationStatus(text: string): void {
  calibrationStatus.textContent = text
}

function setCalibrationRunningUi(running: boolean): void {
  calibrationButton.textContent = running
    ? '■ ABORT CALIBRATION'
    : '▶ RUN CHANNEL CALIBRATION'
  calibrationButton.classList.toggle('active', running)
}

function renderSweepPlot(report: CalibrationReport | null): void {
  const canvas = sweepCanvas
  const context = canvas.getContext('2d')

  if (!context) {
    return
  }

  const width = canvas.clientWidth
  const height = canvas.clientHeight

  if (width < 2 || height < 2) {
    return
  }

  const pixelRatio = window.devicePixelRatio || 1

  canvas.width = Math.round(width * pixelRatio)
  canvas.height = Math.round(height * pixelRatio)
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, width, height)

  context.strokeStyle = 'rgba(211, 180, 107, 0.12)'
  context.lineWidth = 1

  for (let i = 1; i < 4; i++) {
    const y = Math.round((height / 4) * i) + 0.5
    context.beginPath()
    context.moveTo(0, y)
    context.lineTo(width, y)
    context.stroke()
  }

  if (!report || report.points.length < 2) {
    context.fillStyle = 'rgba(255, 255, 255, 0.35)'
    context.font = '11px "DM Mono", monospace'
    context.fillText('NO SWEEP DATA', 12, height / 2)
    return
  }

  const points = report.points
  const minFrequency = points[0].frequency
  const maxFrequency = points[points.length - 1].frequency
  const values = points.map((point) => point.magnitude).concat([report.noiseFloorDb])
  const minValue = Math.min(...values) - 3
  const maxValue = Math.max(...values) + 3
  const span = Math.max(1, maxValue - minValue)

  const toX = (frequency: number): number =>
    ((frequency - minFrequency) / Math.max(1, maxFrequency - minFrequency)) * (width - 16) + 8
  const toY = (magnitude: number): number =>
    height - ((magnitude - minValue) / span) * (height - 16) + 8

  // noise floor reference
  context.save()
  context.setLineDash([5, 5])
  context.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  context.beginPath()
  context.moveTo(8, toY(report.noiseFloorDb))
  context.lineTo(width - 8, toY(report.noiseFloorDb))
  context.stroke()
  context.restore()

  context.fillStyle = 'rgba(255, 255, 255, 0.45)'
  context.font = '10px "DM Mono", monospace'
  context.fillText('NOISE FLOOR', 10, toY(report.noiseFloorDb) - 4)

  // response curve
  context.strokeStyle = '#d3b46b'
  context.lineWidth = 1.75
  context.beginPath()

  points.forEach((point, index) => {
    const x = toX(point.frequency)
    const y = toY(point.magnitude)

    if (index === 0) {
      context.moveTo(x, y)
    } else {
      context.lineTo(x, y)
    }
  })

  context.stroke()

  // chosen carriers
  const chosen = [
    { frequency: report.carrier0, label: 'F0' },
    { frequency: report.carrier1, label: 'F1' },
  ]

  for (const marker of chosen) {
    const x = toX(marker.frequency)

    context.save()
    context.setLineDash([3, 3])
    context.strokeStyle = 'rgba(211, 180, 107, 0.8)'
    context.beginPath()
    context.moveTo(x, 6)
    context.lineTo(x, height - 6)
    context.stroke()
    context.restore()

    context.fillStyle = '#e8d094'
    context.fillText(marker.label, x + 3, 12)
  }
}

function renderCalibrationReport(report: CalibrationReport): void {
  const rows = [...report.points]
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 6)
    .map((point) => {
      const margin = point.magnitude - report.noiseFloorDb

      return `${String(point.frequency).padStart(6)} Hz   ${point.magnitude
        .toFixed(1)
        .padStart(6)} dB   ${margin.toFixed(1).padStart(6)} dB`
    })

  const lines = [
    `NOISE FLOOR    ${report.noiseFloorDb.toFixed(1)} dBFS`,
    `SAMPLE RATE    ${report.sampleRate.toLocaleString()} Hz`,
    `SWEEP          ${report.sweep.startHz.toLocaleString()} → ${report.sweep.stopHz.toLocaleString()} Hz · ` +
      `${report.points.length} points`,
    '',
    '  FREQ         LEVEL      MARGIN',
    ...rows,
    '',
    `RECOMMENDED    ${report.carrier0.toLocaleString()} / ${report.carrier1.toLocaleString()} Hz`,
    `IMBALANCE      ${report.imbalanceDb.toFixed(1)} dB`,
    `LINK MARGIN    ${report.minMarginDb.toFixed(1)} dB`,
    '',
    ...report.notes.map((note) => `• ${note}`),
    '',
    report.summary,
  ]

  calibrationResults.textContent = lines.join('\n')

  calibratedF0.textContent = report.carrier0.toLocaleString()
  calibratedF1.textContent = report.carrier1.toLocaleString()
  calibratedSnr.textContent = report.minMarginDb.toFixed(1)
  calibratedNoise.textContent = report.noiseFloorDb.toFixed(1)
  calibrationQuality.textContent =
    report.verdict === 'good' ? 'GOOD' : report.verdict === 'marginal' ? 'MARGINAL' : 'WEAK'
  calibrationQuality.dataset.verdict = report.verdict
  applyCalibrationButton.disabled = false

  renderSweepPlot(report)
}

async function handleCalibrationClick(): Promise<void> {
  if (calibration.isRunning) {
    calibration.abort()
    return
  }

  const options = {
    startHz: Number(calibrationStart.value),
    stopHz: Number(calibrationStop.value),
    stepHz: Number(calibrationStep.value),
    dwellMs: Number(calibrationDwell.value),
  }

  const valid =
    Number.isFinite(options.startHz) &&
    Number.isFinite(options.stopHz) &&
    Number.isFinite(options.stepHz) &&
    Number.isFinite(options.dwellMs) &&
    options.startHz > 0 &&
    options.stopHz > options.startHz &&
    options.stepHz > 0 &&
    options.dwellMs > 0

  if (!valid) {
    setCalibrationStatus('INVALID SETTINGS')
    calibrationResults.textContent = 'Check START, STOP, STEP and DWELL before running the sweep.'
    return
  }

  const receiverWasStopped = !receiver.isRunning

  setCalibrationRunningUi(true)
  setCalibrationStatus('SCANNING')
  calibrationQuality.textContent = 'SCANNING'
  calibrationQuality.dataset.verdict = ''
  applyCalibrationButton.disabled = true
  calibratedF0.textContent = '—'
  calibratedF1.textContent = '—'
  calibratedSnr.textContent = '—'
  calibratedNoise.textContent = '—'
  calibrationProgress.style.width = '0%'
  calibrationResults.textContent = 'Starting the microphone and measuring the acoustic channel…'

  if (receiverWasStopped) {
    receiverState.textContent = 'CALIBRATING'
    receiverDescription.textContent = 'Microphone input is being used for channel measurement'
    listenButton.innerHTML = '<span>■</span> STOP LISTENING'
  }

  try {
    const report = await calibration.run(options, (progress: CalibrationProgress) => {
      calibrationProgress.style.width = `${clampPercent((progress.step / progress.total) * 100)}%`
      setCalibrationStatus(
        progress.phase === 'sweep' && progress.frequency
          ? `SWEEP ${progress.frequency.toLocaleString()} Hz`
          : progress.phase.toUpperCase(),
      )
      calibrationResults.textContent = progress.detail
    })

    lastReport = report
    renderCalibrationReport(report)
    setCalibrationStatus('COMPLETE')
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'

    setCalibrationStatus(aborted ? 'ABORTED' : 'ERROR')
    calibrationQuality.textContent = aborted ? 'STANDBY' : 'ERROR'
    calibrationResults.textContent = aborted
      ? 'Calibration aborted. The sweep results below are unchanged.'
      : errorMessage(error)
    renderSweepPlot(lastReport)
  } finally {
    setCalibrationRunningUi(false)
    calibrationProgress.style.width = '0%'

    if (receiverWasStopped && !receiver.isRunning) {
      releaseMicrophoneIfIdle()
      setReceiverUiStopped()
    }
  }
}

function handleApplyCalibration(): void {
  if (!lastReport) {
    return
  }

  frequency0Input.value = String(lastReport.carrier0)
  frequency1Input.value = String(lastReport.carrier1)
  handleConfigChanged()

  applyCalibrationButton.disabled = true
  setCalibrationStatus('APPLIED')
  setTxStatus(
    `CALIBRATED CARRIERS ${lastReport.carrier0.toLocaleString()}/${lastReport.carrier1.toLocaleString()} Hz`,
    'ok',
  )
}

// ------------------------------------------------------------
// Wiring
// ------------------------------------------------------------

message.addEventListener('input', () => {
  updateCharacterCount()
  updatePacketMeta()
})

frequency0Input.addEventListener('input', handleConfigChanged)
frequency1Input.addEventListener('input', handleConfigChanged)
symbolTimeInput.addEventListener('input', handleConfigChanged)

transmitButton.addEventListener('click', () => {
  void handleTransmitClick()
})

listenButton.addEventListener('click', () => {
  void handleListenClick()
})

calibrationButton.addEventListener('click', () => {
  void handleCalibrationClick()
})

applyCalibrationButton.addEventListener('click', handleApplyCalibration)

launchTransmitterButton.addEventListener('click', () => {
  document.querySelector('.transmitter-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  message.focus()
})

launchReceiverButton.addEventListener('click', () => {
  document.querySelector('.receiver-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
})

window.addEventListener('resize', () => {
  axisSampleRate = 0
  renderSweepPlot(lastReport)
})

// ------------------------------------------------------------
// Initial state
// ------------------------------------------------------------

updateCharacterCount()
updateHeroDisplay()
updatePacketMeta()
setReceiverUiStopped()
setTransmittingUi(false)
setTxStatus('READY TO TRANSMIT', 'idle')
renderSweepPlot(null)
window.requestAnimationFrame(animationLoop)
