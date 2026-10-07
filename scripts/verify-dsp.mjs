// ============================================================
// Auralynk DSP verification (Node, no browser required).
//
//   node scripts/verify-dsp.mjs
//
// Loads the real TypeScript sources through Vite's SSR loader,
// so exactly the code that ships in the browser is exercised:
//
//   1. CRC-16/CCITT known-answer test
//   2. packet build -> parse round trip (incl. edge cases)
//   3. corruption / truncation handling
//   4. modulate -> demodulate end to end at several sample
//      rates, chunk sizes, symbol phases and noise levels
//   5. carrier detect / telemetry sanity
// ============================================================

import { createServer } from 'vite'

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

const server = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
})

const modem = await server.ssrLoadModule('/src/audio/bfskModem.ts')
const demodulator = await server.ssrLoadModule('/src/audio/bfskDemodulator.ts')

const {
  buildPacket,
  bytesToBits,
  crc16Ccitt,
  DEFAULT_BFSK_CONFIG,
  findSyncIndex,
  FRAME_OVERHEAD_BYTES,
  MAX_PAYLOAD_BYTES,
  modulateToSamples,
  PREAMBLE_BITS,
  parsePacketAt,
  SYNC_WORD,
} = modem

const { BfskDemodulator } = demodulator

const encoder = new TextEncoder()

// ------------------------------------------------------------
section('1. CRC-16/CCITT known-answer test')
// ------------------------------------------------------------

const kat = crc16Ccitt(encoder.encode('123456789'))
check('crc("123456789") = 0x29B1', kat === 0x29b1, `got 0x${kat.toString(16)}`)

const emptyCrc = crc16Ccitt(new Uint8Array(0))
check('crc("") = 0xFFFF (init value)', emptyCrc === 0xffff, `got 0x${emptyCrc.toString(16)}`)

// ------------------------------------------------------------
section('2. Packet build -> parse round trip')
// ------------------------------------------------------------

const roundTripMessages = [
  'Hello from Auralynk.',
  '',
  'Ültralink ✓ — acoustic modem',
  '日本語のメッセージも送信できます',
  'x'.repeat(MAX_PAYLOAD_BYTES),
]

for (const text of roundTripMessages) {
  const packet = buildPacket(text)
  const parsed = parsePacketAt(packet.bits, PREAMBLE_BITS.length)

  check(
    `round trip ${JSON.stringify(text.slice(0, 24))}${text.length > 24 ? '…' : ''} (${text.length} chars)`,
    parsed.status === 'ok' && parsed.text === text,
    `status=${parsed.status} text=${JSON.stringify(parsed.text ?? null)}`,
  )

  const expectedBytes = FRAME_OVERHEAD_BYTES + encoder.encode(text).length
  check(
    `frame size for ${JSON.stringify(text.slice(0, 16))}`,
    packet.packet.length === expectedBytes,
    `got ${packet.packet.length}, expected ${expectedBytes}`,
  )
}

let threw = false

try {
  buildPacket('x'.repeat(MAX_PAYLOAD_BYTES + 1))
} catch {
  threw = true
}

check(`message of ${MAX_PAYLOAD_BYTES + 1} bytes is rejected`, threw)

// ------------------------------------------------------------
section('3. Corruption and truncation')
// ------------------------------------------------------------

const protectedPacket = buildPacket('integrity check')
const corruptedBits = protectedPacket.bits.slice()

// flip one payload bit (inside the payload, after SYNC + LENGTH)
corruptedBits[PREAMBLE_BITS.length + 32 + 5] ^= 1
const corruptedParse = parsePacketAt(corruptedBits, PREAMBLE_BITS.length)
check('single flipped payload bit -> crc-error', corruptedParse.status === 'crc-error', corruptedParse.status)

const truncated = protectedPacket.bits.slice(0, protectedPacket.bits.length - 20)
const truncatedParse = parsePacketAt(truncated, PREAMBLE_BITS.length)
check('truncated frame -> need-more', truncatedParse.status === 'need-more', truncatedParse.status)

const nonsense = Array.from({ length: 200 }, () => Math.floor(Math.random() * 2))
nonsense[PREAMBLE_BITS.length] = 1
nonsense[PREAMBLE_BITS.length + 1] = 1
const nonsenseParse = parsePacketAt(nonsense, PREAMBLE_BITS.length)
check(
  'impossible length field -> invalid',
  nonsenseParse.status === 'invalid' || nonsenseParse.status === 'need-more' || nonsenseParse.status === 'crc-error',
  nonsenseParse.status,
)

// sync word detection must match all 16 bits (regression: the
// pattern used to collapse to the low byte 0x91 only)
{
  const syncBits = bytesToBits([(SYNC_WORD >> 8) & 0xff, SYNC_WORD & 0xff])
  check('sync pattern is 16 bits', syncBits.length === 16, `got ${syncBits.length}`)

  const withPreamble = [...PREAMBLE_BITS, ...syncBits, ...bytesToBits([0x00, 0x05, 65, 66, 67, 68, 69])]
  check('sync found after preamble', findSyncIndex(withPreamble, 0) === 16, `got ${findSyncIndex(withPreamble, 0)}`)

  const lowByteOnly = bytesToBits([0x00, 0x91, 0x00, 0x91])
  check('0x91 alone is not a sync word', findSyncIndex(lowByteOnly, 0) === -1, `got ${findSyncIndex(lowByteOnly, 0)}`)

  const syncAlone = [...bytesToBits([0x00]), ...syncBits, ...bytesToBits([0x00, 0x05])]
  check('sync word without preamble is not a frame start', findSyncIndex(syncAlone, 0) === -1, `got ${findSyncIndex(syncAlone, 0)}`)

  const preambleOnly = [...PREAMBLE_BITS, ...bytesToBits([0x00, 0x05, 65, 66, 67, 68, 69])]
  check('no sync in preamble + payload', findSyncIndex(preambleOnly, 0) === -1, `got ${findSyncIndex(preambleOnly, 0)}`)
}

// ------------------------------------------------------------
section('4. Modulate -> demodulate end to end')
// ------------------------------------------------------------

// Deterministic PRNG so the AWGN tests always exercise the same
// noise realization (mulberry32).
function createSeededRandom(seed) {
  let a = seed >>> 0

  return function random() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0

    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussianNoise(samples, snrDb) {
  const random = createSeededRandom(20260625)

  let signalPower = 0

  for (let i = 0; i < samples.length; i++) {
    signalPower += samples[i] * samples[i]
  }

  signalPower /= Math.max(1, samples.length)

  const noisePower = signalPower / Math.pow(10, snrDb / 10)
  const sigma = Math.sqrt(noisePower)
  const out = new Float32Array(samples.length)

  for (let i = 0; i < samples.length; i++) {
    let u = 0
    let v = 0

    while (u === 0) u = random()
    while (v === 0) v = random()

    const radius = Math.sqrt(-2 * Math.log(u))
    const angle = 2 * Math.PI * v

    out[i] = samples[i] + sigma * radius * Math.cos(angle)
  }

  return out
}

function silence(seconds, sampleRate) {
  return new Float32Array(Math.round(seconds * sampleRate))
}

function concat(parts) {
  let total = 0

  for (const part of parts) total += part.length

  const out = new Float32Array(total)
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

function runReceiver(samples, config, sampleRate, chunkSizes, { reference = null } = {}) {
  const demod = new BfskDemodulator(config, sampleRate)
  demod.setReference(reference)

  const frames = []
  let index = 0
  let chunkIndex = 0
  let everCarrier = false
  let maxCoherence = 0
  let maxSnrDb = -Infinity
  let maxCrcFailures = 0

  while (index < samples.length) {
    const size = Math.max(1, chunkSizes[chunkIndex++ % chunkSizes.length])
    const end = Math.min(samples.length, index + size)
    frames.push(...demod.push(samples.subarray(index, end)))

    const telemetry = demod.telemetry()

    if (telemetry.carrierPresent) everCarrier = true
    maxCoherence = Math.max(maxCoherence, telemetry.coherence)
    maxSnrDb = Math.max(maxSnrDb, telemetry.snrDb)
    maxCrcFailures = Math.max(maxCrcFailures, telemetry.crcFailures)

    index = end
  }

  return { frames, telemetry: demod.telemetry(), everCarrier, maxCoherence, maxSnrDb, maxCrcFailures }
}

function e2eCase({ label, text, sampleRate, chunkSizes, leadingSilence, offset, snrDb, config }) {
  const packet = buildPacket(text)
  const reference = { packetBits: packet.bits.slice(PREAMBLE_BITS.length), payload: packet.payload }

  const symbols = modulateToSamples(packet.bits, config, sampleRate)
  const parts = [silence(leadingSilence, sampleRate)]

  if (offset > 0) parts.push(silence(offset / sampleRate, sampleRate))

  parts.push(symbols)
  parts.push(silence(0.6, sampleRate))

  let stream = concat(parts)

  if (snrDb !== null) {
    stream = gaussianNoise(stream, snrDb)
  }

  const { frames, telemetry } = runReceiver(stream, config, sampleRate, chunkSizes, { reference })

  const ok = frames.length === 1 && frames[0].text === text

  check(
    label,
    ok,
    frames.length === 0
      ? 'no frame decoded'
      : `${frames.length} frames, first=${JSON.stringify(frames[0].text.slice(0, 20))}`,
  )

  if (ok && frames[0].ber !== null) {
    check(`${label}: BER measured`, frames[0].ber === 0, `ber=${frames[0].ber}`)
  }

  return { frames, telemetry, packet }
}

const baseConfig = { ...DEFAULT_BFSK_CONFIG }

e2eCase({
  label: '48 kHz, 2048-sample blocks, 0.35 s lead-in',
  text: 'Hello from Auralynk.',
  sampleRate: 48000,
  chunkSizes: [2048],
  leadingSilence: 0.35,
  offset: 0,
  snrDb: null,
  config: baseConfig,
})

e2eCase({
  label: '48 kHz, awkward 997-sample blocks',
  text: 'chunk boundaries must not lose symbols',
  sampleRate: 48000,
  chunkSizes: [997],
  leadingSilence: 0.31,
  offset: 0,
  snrDb: null,
  config: baseConfig,
})

e2eCase({
  label: '44.1 kHz device rate',
  text: 'sample rate independence',
  sampleRate: 44100,
  chunkSizes: [2048],
  leadingSilence: 0.4,
  offset: 0,
  snrDb: null,
  config: baseConfig,
})

e2eCase({
  label: 'misaligned symbol phase (137-sample offset)',
  text: 'phase hypothesis test',
  sampleRate: 48000,
  chunkSizes: [2048],
  leadingSilence: 0.5,
  offset: 137,
  snrDb: null,
  config: baseConfig,
})

e2eCase({
  label: 'misaligned symbol phase (733-sample offset), mixed blocks',
  text: 'second phase hypothesis',
  sampleRate: 48000,
  chunkSizes: [2048, 509, 1024],
  leadingSilence: 0.47,
  offset: 733,
  snrDb: null,
  config: baseConfig,
})

e2eCase({
  label: 'low amplitude (0.05)',
  text: 'amplitude invariance',
  sampleRate: 48000,
  chunkSizes: [2048],
  leadingSilence: 0.35,
  offset: 0,
  snrDb: null,
  config: { ...baseConfig, amplitude: 0.05 },
})

e2eCase({
  label: 'awgn channel at 20 dB SNR',
  text: 'noisy channel at twenty decibels',
  sampleRate: 48000,
  chunkSizes: [2048],
  leadingSilence: 0.4,
  offset: 0,
  snrDb: 20,
  config: baseConfig,
})

e2eCase({
  label: 'awgn channel at 12 dB SNR',
  text: 'noisy channel at twelve decibels',
  sampleRate: 48000,
  chunkSizes: [2048],
  leadingSilence: 0.4,
  offset: 0,
  snrDb: 12,
  config: baseConfig,
})

e2eCase({
  label: '5 ms symbols (200 baud)',
  text: 'fast',
  sampleRate: 48000,
  chunkSizes: [2048],
  leadingSilence: 0.3,
  offset: 0,
  snrDb: null,
  config: { ...baseConfig, symbolTimeMs: 5 },
})

e2eCase({
  label: '50 ms symbols (20 baud)',
  text: 'slow',
  sampleRate: 48000,
  chunkSizes: [2048],
  leadingSilence: 0.3,
  offset: 0,
  snrDb: null,
  config: { ...baseConfig, symbolTimeMs: 50 },
})

e2eCase({
  label: 'long payload (240 bytes) end to end',
  text: 'The quick brown fox jumps over the lazy dog. '.repeat(6).slice(0, 240),
  sampleRate: 48000,
  chunkSizes: [2048],
  leadingSilence: 0.4,
  offset: 0,
  snrDb: null,
  config: baseConfig,
})

e2eCase({
  label: 'unicode payload end to end',
  text: 'Ültralink ✓ — 日本語の音響モデム',
  sampleRate: 48000,
  chunkSizes: [2048, 777],
  leadingSilence: 0.4,
  offset: 0,
  snrDb: null,
  config: baseConfig,
})

e2eCase({
  label: 'large 65536-sample blocks',
  text: 'big block boundaries',
  sampleRate: 48000,
  chunkSizes: [65536],
  leadingSilence: 0.4,
  offset: 0,
  snrDb: null,
  config: baseConfig,
})

// two frames back to back inside one stream
{
  const config = baseConfig
  const packetA = buildPacket('frame one')
  const packetB = buildPacket('frame two')
  const sampleRate = 48000
  const stream = concat([
    silence(0.4, sampleRate),
    modulateToSamples(packetA.bits, config, sampleRate),
    silence(0.4, sampleRate),
    modulateToSamples(packetB.bits, config, sampleRate),
    silence(0.6, sampleRate),
  ])

  const { frames } = runReceiver(stream, config, sampleRate, [2048])

  check(
    'two separated frames in one stream',
    frames.length === 2 && frames[0].text === 'frame one' && frames[1].text === 'frame two',
    JSON.stringify(frames.map((frame) => frame.text)),
  )
}

// ------------------------------------------------------------
section('5. Carrier detect / telemetry')
// ------------------------------------------------------------

{
  const sampleRate = 48000
  const silent = silence(1, sampleRate)
  const { telemetry, everCarrier } = runReceiver(silent, baseConfig, sampleRate, [2048])

  check('silence: never reports a carrier', everCarrier === false)
  check('silence: input level is very low', telemetry.inputDb < -60, `inputDb=${telemetry.inputDb.toFixed(1)}`)
}

{
  const sampleRate = 48000
  const packet = buildPacket('carrier presence')
  const reference = { packetBits: packet.bits.slice(PREAMBLE_BITS.length), payload: packet.payload }
  const tone = concat([
    silence(0.3, sampleRate),
    modulateToSamples(packet.bits, baseConfig, sampleRate),
    silence(0.6, sampleRate),
  ])

  const { frames, everCarrier, maxSnrDb, maxCoherence } = runReceiver(tone, baseConfig, sampleRate, [2048], {
    reference,
  })

  check('modulated stream: carrier detected', everCarrier === true)
  check('modulated stream: plausible SNR', maxSnrDb > 5, `maxSnrDb=${maxSnrDb.toFixed(1)}`)
  check('modulated stream: one frame', frames.length === 1, `frames=${frames.length}`)
  check(
    'coherence of a clean carrier exceeds the 0.2 threshold',
    maxCoherence > 0.2,
    `maxCoherence=${maxCoherence.toFixed(3)}`,
  )
  check(
    'BER reported against the transmitted reference',
    frames.length === 1 && frames[0].ber === 0,
    frames.length === 1 ? `ber=${frames[0].ber}` : 'no frame',
  )
}

{
  const sampleRate = 48000
  const wrongConfig = { ...baseConfig, carrier0: 14000, carrier1: 15000 }
  const packet = buildPacket('mismatched configuration')
  const stream = concat([
    silence(0.3, sampleRate),
    modulateToSamples(packet.bits, baseConfig, sampleRate),
    silence(0.4, sampleRate),
  ])

  const { frames } = runReceiver(stream, wrongConfig, sampleRate, [2048])

  check('mismatched carriers decode nothing', frames.length === 0, `frames=${frames.length}`)
}

// ------------------------------------------------------------
section('6. Symbol-timing recovery (clock drift)')
// ------------------------------------------------------------

// Simulate a transmitter whose sample clock differs from the
// receiver: the same waveform is resampled, so every symbol is
// `factor` times as long in the receiver's sample domain. A fixed
// symbol grid loses lock; the early-late tracking loop follows it.
function resample(samples, factor) {
  const outLength = Math.floor(samples.length / factor)
  const out = new Float32Array(outLength)

  for (let i = 0; i < outLength; i++) {
    const position = i * factor
    const i0 = Math.floor(position)
    const fraction = position - i0
    const a = samples[i0] ?? 0
    const b = samples[Math.min(samples.length - 1, i0 + 1)] ?? a
    out[i] = a + (b - a) * fraction
  }

  return out
}

function driftCase({ label, text, factor }) {
  const packet = buildPacket(text)
  const reference = { packetBits: packet.bits.slice(PREAMBLE_BITS.length), payload: packet.payload }
  const symbols = modulateToSamples(packet.bits, baseConfig, 48000)
  const stream = concat([silence(0.4, 48000), resample(symbols, factor), silence(0.6, 48000)])

  const { frames } = runReceiver(stream, baseConfig, 48000, [2048], { reference })

  check(
    label,
    frames.length === 1 && frames[0].text === text,
    frames.length === 0 ? 'no frame decoded' : `${frames.length} frames, first=${JSON.stringify(frames[0].text.slice(0, 20))}`,
  )
}

driftCase({ label: '+0.1% transmitter clock drift', text: 'drift compensates up', factor: 1.001 })
driftCase({ label: '-0.1% transmitter clock drift', text: 'drift compensates down', factor: 0.999 })
driftCase({ label: '+0.3% transmitter clock drift', text: 'three thousand ppm fast', factor: 1.003 })
driftCase({ label: '-0.3% transmitter clock drift', text: 'three thousand ppm slow', factor: 0.997 })

// ------------------------------------------------------------
await server.close()

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  console.log('\nFailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
