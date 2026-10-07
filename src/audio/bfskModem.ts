// ============================================================
// Auralynk BFSK Modem — single source of truth for
// packet framing, CRC, bit ordering and BFSK modulation.
//
// Transmitter and receiver BOTH use the definitions in this
// file. There is no second packet implementation.
//
// PACKET FORMAT (deterministic, MSB-first, big-endian fields)
//
//   [PREAMBLE]  16 bits : 1 0 1 0 1 0 ... 1 0   (bit level only)
//   [SYNC]      2 bytes : 0xD3 0x91
//   [LENGTH]    2 bytes : payload length, big endian
//   [PAYLOAD]   N bytes : UTF-8 message
//   [CRC]       2 bytes : CRC-16/CCITT over SYNC..PAYLOAD
//
// ============================================================

export interface BfskConfig {
  carrier0: number
  carrier1: number
  symbolTimeMs: number
  amplitude: number
}

export interface EncodedPacket {
  text: string
  payload: Uint8Array
  packet: Uint8Array
  bits: number[]
  crc: number
}

export interface BfskTransmission {
  audioBuffer: AudioBuffer
  packet: EncodedPacket
  durationMs: number
}

// ------------------------------------------------------------
// Limits
// ------------------------------------------------------------

export const MAX_PAYLOAD_BYTES = 512
export const MIN_CARRIER_HZ = 200
export const MAX_CARRIER_HZ = 22000
export const MIN_SYMBOL_TIME_MS = 5
export const MAX_SYMBOL_TIME_MS = 500

// ------------------------------------------------------------
// Default configuration: 18.5 kHz / 19.5 kHz, 20 ms symbols
// ------------------------------------------------------------

export const DEFAULT_BFSK_CONFIG: BfskConfig = {
  carrier0: 18500,
  carrier1: 19500,
  symbolTimeMs: 20,
  amplitude: 0.55,
}

// ------------------------------------------------------------
// Framing constants
// ------------------------------------------------------------

export const SYNC_WORD = 0xd391

export const PREAMBLE_BITS: number[] = Array.from({ length: 16 }, (_, i) =>
  i % 2 === 0 ? 1 : 0,
)

/** Number of header + trailer bytes: SYNC(2) + LENGTH(2) + CRC(2). */
export const FRAME_OVERHEAD_BYTES = 6

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

export function validateBfskConfig(
  config: BfskConfig,
  nyquistHz: number = MAX_CARRIER_HZ,
): string | null {
  const { carrier0, carrier1, symbolTimeMs, amplitude } = config

  if (!Number.isFinite(carrier0) || !Number.isFinite(carrier1)) {
    return 'Carrier frequencies must be valid numbers.'
  }

  if (carrier0 < MIN_CARRIER_HZ || carrier0 > MAX_CARRIER_HZ) {
    return `Carrier 0 must be between ${MIN_CARRIER_HZ} and ${MAX_CARRIER_HZ} Hz.`
  }

  if (carrier1 < MIN_CARRIER_HZ || carrier1 > MAX_CARRIER_HZ) {
    return `Carrier 1 must be between ${MIN_CARRIER_HZ} and ${MAX_CARRIER_HZ} Hz.`
  }

  if (carrier0 === carrier1) {
    return 'Carrier 0 and Carrier 1 must be different frequencies.'
  }

  if (carrier0 >= nyquistHz || carrier1 >= nyquistHz) {
    return `Carriers must stay below ${(nyquistHz / 1000).toFixed(1)} kHz for this audio device.`
  }

  if (
    !Number.isFinite(symbolTimeMs) ||
    symbolTimeMs < MIN_SYMBOL_TIME_MS ||
    symbolTimeMs > MAX_SYMBOL_TIME_MS
  ) {
    return `Symbol time must be between ${MIN_SYMBOL_TIME_MS} and ${MAX_SYMBOL_TIME_MS} ms.`
  }

  if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 1) {
    return 'Amplitude must be between 0 and 1.'
  }

  return null
}

// ------------------------------------------------------------
// CRC-16/CCITT  (poly 0x1021, init 0xFFFF)
// ------------------------------------------------------------

export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0xffff

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8

    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }

  return crc & 0xffff
}

// ------------------------------------------------------------
// UTF-8 helpers
// ------------------------------------------------------------

export function textToUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function utf8ToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

// ------------------------------------------------------------
// Bit ordering — always MSB first
// ------------------------------------------------------------

export function bytesToBits(bytes: ArrayLike<number>): number[] {
  const bits: number[] = []

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]

    for (let bit = 7; bit >= 0; bit--) {
      bits.push((byte >> bit) & 1)
    }
  }

  return bits
}

export function bitsToBytes(bits: ArrayLike<number>): Uint8Array {
  const byteCount = Math.floor(bits.length / 8)
  const bytes = new Uint8Array(byteCount)

  for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
    let value = 0

    for (let bit = 0; bit < 8; bit++) {
      value = (value << 1) | (bits[byteIndex * 8 + bit] & 1)
    }

    bytes[byteIndex] = value
  }

  return bytes
}

export function bitsToByte(bits: ArrayLike<number>, offset: number): number {
  let value = 0

  for (let i = 0; i < 8; i++) {
    value = (value << 1) | (bits[offset + i] ?? 0)
  }

  return value
}

// ------------------------------------------------------------
// Packet building
// ------------------------------------------------------------

export function buildPacket(text: string): EncodedPacket {
  const payload = textToUtf8(text)

  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Message is too large: ${payload.length} UTF-8 bytes (limit ${MAX_PAYLOAD_BYTES}).`,
    )
  }

  // SYNC + LENGTH + PAYLOAD — exactly the range the receiver
  // runs the CRC over.
  const body = new Uint8Array(4 + payload.length)

  body[0] = (SYNC_WORD >> 8) & 0xff
  body[1] = SYNC_WORD & 0xff
  body[2] = (payload.length >> 8) & 0xff
  body[3] = payload.length & 0xff
  body.set(payload, 4)

  const crc = crc16Ccitt(body)

  const packet = new Uint8Array(body.length + 2)
  packet.set(body)
  packet[packet.length - 2] = (crc >> 8) & 0xff
  packet[packet.length - 1] = crc & 0xff

  const bits = [...PREAMBLE_BITS, ...bytesToBits(packet)]

  return { text, payload, packet, bits, crc }
}

// ------------------------------------------------------------
// Packet parsing (receiver side)
// ------------------------------------------------------------

export type PacketParseStatus = 'need-more' | 'invalid' | 'crc-error' | 'ok'

export interface ParsedPacket {
  status: PacketParseStatus
  /** Bit index just after the consumed frame (only for ok / crc-error). */
  consumedBits: number
  /** Bit index of the sync word that was inspected. */
  syncIndex: number
  text?: string
  payload?: Uint8Array
  /** Frame bits, from SYNC through CRC, excluding the preamble. */
  frameBits?: number[]
  receivedCrc?: number
  calculatedCrc?: number
}

function sliceBits(bits: ArrayLike<number>, from: number, to: number): number[] {
  const out: number[] = []

  for (let i = from; i < to; i++) {
    out.push(bits[i] & 1)
  }

  return out
}

function findBitPattern(bits: ArrayLike<number>, pattern: number[], from: number): number {
  outer: for (let start = from; start <= bits.length - pattern.length; start++) {
    for (let i = 0; i < pattern.length; i++) {
      if (bits[start + i] !== pattern[i]) {
        continue outer
      }
    }

    return start
  }

  return -1
}

/**
 * Locates the start of a frame by matching the full acquisition
 * pattern — the alternating preamble immediately followed by the
 * sync word — and returns the bit index of the sync word itself
 * (i.e. the offset the parser must start from).
 *
 * Matching all 32 bits (instead of the 16-bit sync alone) drops
 * the probability of a false lock in a noisy or misaligned bit
 * stream from ~2^-16 to ~2^-32, which is what the preamble is
 * for. Returns -1 when no frame start is present.
 */
export function findSyncIndex(bits: ArrayLike<number>, from = 0): number {
  const syncBytes = [(SYNC_WORD >> 8) & 0xff, SYNC_WORD & 0xff]
  const acquisition = [...PREAMBLE_BITS, ...bytesToBits(syncBytes)]
  const start = findBitPattern(bits, acquisition, from)

  return start < 0 ? -1 : start + PREAMBLE_BITS.length
}

/**
 * Attempt to read one complete frame starting at `syncIndex`.
 * Returns `need-more` when the bit buffer does not hold the whole
 * frame yet, so the caller can keep buffering.
 */
export function parsePacketAt(bits: ArrayLike<number>, syncIndex: number): ParsedPacket {
  const headerEnd = syncIndex + 32

  if (bits.length < headerEnd) {
    return { status: 'need-more', consumedBits: 0, syncIndex }
  }

  const payloadLength =
    (bitsToByte(bits, syncIndex + 16) << 8) | bitsToByte(bits, syncIndex + 24)

  if (payloadLength > MAX_PAYLOAD_BYTES) {
    return { status: 'invalid', consumedBits: 0, syncIndex }
  }

  const crcStart = headerEnd + payloadLength * 8
  const frameEnd = crcStart + 16

  if (bits.length < frameEnd) {
    return { status: 'need-more', consumedBits: 0, syncIndex }
  }

  const frameBits = sliceBits(bits, syncIndex, frameEnd)
  const frameBytes = bitsToBytes(frameBits)

  const receivedCrc = (frameBytes[frameBytes.length - 2] << 8) | frameBytes[frameBytes.length - 1]
  const calculatedCrc = crc16Ccitt(frameBytes.subarray(0, frameBytes.length - 2))

  if (receivedCrc !== calculatedCrc) {
    return {
      status: 'crc-error',
      consumedBits: frameEnd,
      syncIndex,
      receivedCrc,
      calculatedCrc,
      frameBits,
    }
  }

  const payload = frameBytes.subarray(4, 4 + payloadLength)

  return {
    status: 'ok',
    consumedBits: frameEnd,
    syncIndex,
    text: utf8ToText(payload),
    payload: new Uint8Array(payload),
    frameBits,
    receivedCrc,
    calculatedCrc,
  }
}

// ------------------------------------------------------------
// Modulation: bits -> PCM samples
// ------------------------------------------------------------

/**
 * Renders one BFSK symbol per bit.
 * 0 -> carrier0, 1 -> carrier1, raised-cosine envelope per symbol.
 */
export function modulateToSamples(
  bits: ArrayLike<number>,
  config: BfskConfig,
  sampleRate: number,
): Float32Array<ArrayBuffer> {
  const samplesPerSymbol = Math.max(1, Math.round((config.symbolTimeMs / 1000) * sampleRate))
  const total = bits.length * samplesPerSymbol
  const channel = new Float32Array(total)

  const step0 = (2 * Math.PI * config.carrier0) / sampleRate
  const step1 = (2 * Math.PI * config.carrier1) / sampleRate

  let index = 0

  for (let i = 0; i < bits.length; i++) {
    const step = bits[i] === 0 ? step0 : step1

    for (let s = 0; s < samplesPerSymbol; s++) {
      const envelope = Math.sin((Math.PI * s) / samplesPerSymbol)
      channel[index++] = Math.sin(step * s) * config.amplitude * envelope
    }
  }

  return channel
}

export function createBfskAudio(
  context: AudioContext,
  encoded: EncodedPacket,
  config: BfskConfig = DEFAULT_BFSK_CONFIG,
): BfskTransmission {
  const samples = modulateToSamples(encoded.bits, config, context.sampleRate)
  const audioBuffer = context.createBuffer(1, samples.length, context.sampleRate)
  audioBuffer.copyToChannel(samples, 0)

  return {
    audioBuffer,
    packet: encoded,
    durationMs: encoded.bits.length * config.symbolTimeMs,
  }
}

// ------------------------------------------------------------
// Transmission metadata for the UI
// ------------------------------------------------------------

export interface TransmissionInfo {
  text: string
  payloadBytes: number
  packetBytes: number
  totalBits: number
  carrier0: number
  carrier1: number
  symbolTimeMs: number
  bitrate: number
  durationMs: number
  crc: string
}

export function getTransmissionInfo(
  encoded: EncodedPacket,
  config: BfskConfig = DEFAULT_BFSK_CONFIG,
): TransmissionInfo {
  return {
    text: encoded.text,
    payloadBytes: encoded.payload.length,
    packetBytes: encoded.packet.length,
    totalBits: encoded.bits.length,
    carrier0: config.carrier0,
    carrier1: config.carrier1,
    symbolTimeMs: config.symbolTimeMs,
    bitrate: 1000 / config.symbolTimeMs,
    durationMs: encoded.bits.length * config.symbolTimeMs,
    crc: `0x${encoded.crc.toString(16).padStart(4, '0').toUpperCase()}`,
  }
}
