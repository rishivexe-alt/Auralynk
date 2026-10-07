// ============================================================
// Auralynk page markup.
//
// Kept out of the controller so the document structure is
// readable and can be reviewed independently of the logic.
//
// Section order (required by the design spec):
//   HEADER · HERO · TRANSMITTER | RECEIVER · SIGNAL LAB ·
//   CHANNEL CALIBRATION · SYSTEM ARCHITECTURE · FOOTER
// ============================================================

export const APP_TEMPLATE = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#D4AF37" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
        <div>
          <div class="brand-name">AURALYNK</div>
          <div class="brand-subtitle">ACOUSTIC DATA COMMUNICATION</div>
        </div>
      </div>
      <div class="system-status">
        <span class="status-dot"></span>
        <span id="system-status-text">SYSTEM READY</span>
      </div>
    </header>

    <section class="hero">
      <div class="hero-content">
        <div class="eyebrow">BROWSER-BASED ACOUSTIC MODEM</div>
        <h1>Send Text<br><span>Through Sound.</span></h1>
        <p class="hero-description">
          Convert digital messages into high-frequency acoustic signals,
          transmit them through the air, and reconstruct the original
          message using a microphone and real-time signal processing.
        </p>
        <div class="hero-actions">
          <button class="primary-button" id="launch-transmitter" type="button">
            <span>&#9654;</span> LAUNCH TRANSMITTER
          </button>
          <button class="secondary-button" id="launch-receiver" type="button">
            <span>&#9673;</span> LAUNCH RECEIVER
          </button>
        </div>
      </div>

      <div class="hero-visual">
        <div class="signal-card">
          <div class="signal-card-header">
            <span>LIVE ACOUSTIC LINK</span>
            <span class="live-indicator"><i></i> LIVE</span>
          </div>
          <div class="frequency-display">
            <div class="frequency-node">
              <div class="frequency-value" id="hero-frequency-0">18.5</div>
              <div class="frequency-unit">kHz</div>
              <div class="frequency-label">CARRIER 0</div>
            </div>
            <div class="wave-container">
              <div class="wave-line"></div>
              <div class="wave-line wave-line-2"></div>
            </div>
            <div class="frequency-node">
              <div class="frequency-value" id="hero-frequency-1">19.5</div>
              <div class="frequency-unit">kHz</div>
              <div class="frequency-label">CARRIER 1</div>
            </div>
          </div>
          <div class="signal-footer">
            <span>MODULATION</span><strong>BFSK</strong>
            <span>DATA RATE</span><strong id="hero-data-rate">50 bps</strong>
            <span>LINK</span><strong class="green" id="hero-link">READY</strong>
          </div>
        </div>
      </div>
    </section>

    <main class="dashboard">
      <section class="panel transmitter-panel">
        <div class="panel-header">
          <div>
            <div class="panel-number">01 / TRANSMITTER</div>
            <h2>Send a Message</h2>
          </div>
          <div class="panel-icon transmitter-icon">TX</div>
        </div>

        <div class="message-section">
          <label for="message">MESSAGE</label>
          <textarea
            id="message"
            placeholder="Enter the message you want to transmit..."
          >Hello from Auralynk.</textarea>
          <div class="textarea-info">
            <span>UTF-8 ENCODING</span>
            <span id="character-count">20 / 512 BYTES</span>
          </div>
        </div>

        <div class="settings-grid">
          <div class="setting">
            <label for="frequency-0">CARRIER 0</label>
            <div class="value-input">
              <input id="frequency-0" type="number" value="18500" min="200" max="22000" step="100">
              <span>Hz</span>
            </div>
          </div>
          <div class="setting">
            <label for="frequency-1">CARRIER 1</label>
            <div class="value-input">
              <input id="frequency-1" type="number" value="19500" min="200" max="22000" step="100">
              <span>Hz</span>
            </div>
          </div>
          <div class="setting">
            <label for="symbol-time">SYMBOL TIME</label>
            <div class="value-input">
              <input id="symbol-time" type="number" value="20" min="5" max="500" step="1">
              <span>ms</span>
            </div>
          </div>
          <div class="setting">
            <label>MODULATION</label>
            <div class="value-static" title="Binary frequency-shift keying is the only implemented mode.">BFSK</div>
          </div>
        </div>

        <div class="packet-preview">
          <div class="packet-title">PACKET PREVIEW</div>
          <div class="packet-flow">
            <span>PREAMBLE</span><b>&rarr;</b>
            <span>SYNC</span><b>&rarr;</b>
            <span>LENGTH</span><b>&rarr;</b>
            <span>PAYLOAD</span><b>&rarr;</b>
            <span>CRC-16</span>
          </div>
          <div class="packet-meta" id="packet-meta">FRAME 6 + 20 BYTES &middot; 192 BITS &middot; CRC 0x0000</div>
        </div>

        <button class="transmit-button" id="transmit-button" type="button">
          <span class="transmit-symbol">&#9654;</span> TRANSMIT MESSAGE
        </button>
        <div class="tx-status" id="tx-status" data-tone="idle">
          <span class="status-dot"></span><span id="tx-status-text">READY TO TRANSMIT</span>
        </div>
      </section>

      <section class="panel receiver-panel">
        <div class="panel-header">
          <div>
            <div class="panel-number">02 / RECEIVER</div>
            <h2>Listen &amp; Decode</h2>
          </div>
          <div class="panel-icon receiver-icon">RX</div>
        </div>

        <div class="receiver-display">
          <div class="microphone-status">
            <div class="mic-circle"><div class="mic-symbol">&#9673;</div></div>
            <div>
              <div class="receiver-state" id="receiver-state">STANDBY</div>
              <div class="receiver-description" id="receiver-description">Microphone monitoring inactive</div>
            </div>
          </div>

          <div class="signal-meter">
            <div class="meter-header">
              <span>INPUT LEVEL</span>
              <span id="input-level">-&infin; dBFS</span>
            </div>
            <div class="meter"><div class="meter-fill" id="meter-fill"></div></div>
          </div>

          <div class="detected-frequency">
            <div>
              <span>DETECTED FREQUENCY</span>
              <strong id="detected-frequency">&mdash;</strong>
            </div>
            <div>
              <span>DETECTED BIT</span>
              <strong id="detected-bit">&mdash;</strong>
            </div>
          </div>
        </div>

        <div class="decoded-section">
          <div class="decoded-header">
            <span>DECODED MESSAGE</span>
            <span class="crc-badge" id="crc-status">CRC &mdash;</span>
          </div>
          <div class="decoded-message" id="decoded-message">Waiting for transmission...</div>
        </div>

        <button class="listen-button" id="listen-button" type="button">
          <span>&#9673;</span> START LISTENING
        </button>
        <div class="rx-status" id="rx-status">MICROPHONE NOT ACTIVE</div>
      </section>
    </main>

    <section class="signal-lab">
      <div class="section-heading">
        <div>
          <div class="panel-number">03 / SIGNAL LAB</div>
          <h2>Acoustic Signal Analysis</h2>
        </div>
        <p>Real-time frequency-domain analysis of the acoustic communication channel.</p>
      </div>

      <div class="lab-grid">
        <div class="lab-card spectrum-card">
          <div class="lab-card-header">
            <span>FREQUENCY SPECTRUM</span>
            <span class="lab-live" id="spectrum-state">MICROPHONE OFFLINE</span>
          </div>
          <div class="spectrum">
            <canvas id="spectrum-canvas"></canvas>
            <div class="spectrum-empty" id="spectrum-empty">
              START THE RECEIVER TO SEE THE LIVE SPECTRUM
            </div>
          </div>
          <div class="frequency-axis" id="frequency-axis">
            <span>0 Hz</span><span>6 kHz</span><span>12 kHz</span><span>18 kHz</span><span>24 kHz</span>
          </div>
        </div>

        <div class="lab-card stats-card">
          <div class="lab-card-header"><span>LINK TELEMETRY</span></div>
          <div class="telemetry-grid">
            <div class="telemetry"><span>SNR</span><strong id="snr-value">&mdash;</strong></div>
            <div class="telemetry"><span>BER</span><strong id="ber-value">&mdash;</strong></div>
            <div class="telemetry"><span>PACKETS</span><strong id="packet-count">0</strong></div>
            <div class="telemetry"><span>PACKET LOSS</span><strong id="packet-loss">&mdash;</strong></div>
            <div class="telemetry"><span>BITS</span><strong id="decoded-bits">0</strong></div>
            <div class="telemetry"><span>CRC FAILS</span><strong id="crc-fails">0</strong></div>
          </div>
          <div class="quality">
            <div class="quality-header">
              <span>LINK QUALITY</span>
              <span id="quality-label">STANDBY</span>
            </div>
            <div class="quality-bar"><div id="quality-fill"></div></div>
          </div>
          <div class="telemetry-note" id="telemetry-note">
            BER is measured against the transmitted packet on loopback.
          </div>
        </div>
      </div>
    </section>

    <section class="signal-lab" id="channel-calibration">
      <div class="section-heading">
        <div>
          <div class="panel-number">04 / CHANNEL CALIBRATION</div>
          <h2>Acoustic Channel Calibration</h2>
        </div>
        <p>Sweep the acoustic channel and select the strongest carrier pair.</p>
      </div>

      <div class="calibration-grid">
        <div class="lab-card calibration-card">
          <div class="lab-card-header">
            <span>CHANNEL SWEEP</span>
            <span class="lab-live" id="calibration-status">READY</span>
          </div>

          <div class="calibration-fields">
            <label class="field">START Hz
              <input id="calibration-start" type="number" value="9000" min="200" max="22000" step="100">
            </label>
            <label class="field">STOP Hz
              <input id="calibration-stop" type="number" value="21500" min="200" max="22000" step="100">
            </label>
            <label class="field">STEP Hz
              <input id="calibration-step" type="number" value="500" min="50" max="2000" step="50">
            </label>
            <label class="field">DWELL ms
              <input id="calibration-dwell" type="number" value="250" min="100" max="2000" step="50">
            </label>
          </div>

          <div class="progress-track"><div class="progress-fill" id="calibration-progress"></div></div>

          <div class="sweep-plot">
            <canvas id="sweep-canvas"></canvas>
          </div>

          <div class="calibration-results" id="calibration-results">
            Press RUN CHANNEL CALIBRATION to begin.
          </div>

          <button class="transmit-button" id="calibration-button" type="button">
            &#9654; RUN CHANNEL CALIBRATION
          </button>
        </div>

        <div class="lab-card calibration-card">
          <div class="lab-card-header">
            <span>CALIBRATED LINK</span>
            <span id="calibration-quality">STANDBY</span>
          </div>
          <div class="link-stats">
            <div class="link-stat">
              <div>RECOMMENDED CARRIER 0</div>
              <strong id="calibrated-f0">&mdash;</strong><span>Hz</span>
            </div>
            <div class="link-stat">
              <div>RECOMMENDED CARRIER 1</div>
              <strong id="calibrated-f1">&mdash;</strong><span>Hz</span>
            </div>
            <div class="link-stat">
              <div>LINK MARGIN (WORST CARRIER)</div>
              <strong id="calibrated-snr">&mdash;</strong><span>dB</span>
            </div>
            <div class="link-stat">
              <div>NOISE FLOOR</div>
              <strong id="calibrated-noise">&mdash;</strong><span>dBFS</span>
            </div>
          </div>
          <button class="secondary-button" id="apply-calibration" type="button" disabled>
            APPLY TO TRANSMITTER
          </button>
        </div>
      </div>
    </section>

    <section class="architecture">
      <div class="section-heading">
        <div>
          <div class="panel-number">05 / SYSTEM ARCHITECTURE</div>
          <h2>How Auralynk Works</h2>
        </div>
      </div>
      <div class="architecture-flow">
        <div class="architecture-node"><span>01</span><strong>TEXT</strong><small>User Message</small></div>
        <div class="flow-arrow">&rarr;</div>
        <div class="architecture-node"><span>02</span><strong>ENCODE</strong><small>UTF-8 + Packet</small></div>
        <div class="flow-arrow">&rarr;</div>
        <div class="architecture-node"><span>03</span><strong>MODULATE</strong><small>BFSK</small></div>
        <div class="flow-arrow">&rarr;</div>
        <div class="architecture-node highlight"><span>04</span><strong>ACOUSTIC</strong><small>Speaker &rarr; Air</small></div>
        <div class="flow-arrow">&rarr;</div>
        <div class="architecture-node"><span>05</span><strong>DETECT</strong><small>Goertzel DSP</small></div>
        <div class="flow-arrow">&rarr;</div>
        <div class="architecture-node"><span>06</span><strong>DECODE</strong><small>CRC &rarr; Text</small></div>
      </div>
    </section>

    <footer>
      <div>
        <strong>AURALYNK</strong>
        <span>Experimental Acoustic Communication Platform</span>
      </div>
      <div>WEB AUDIO API &middot; BFSK &middot; GOERTZEL DSP &middot; CRC-16/CCITT</div>
    </footer>
  </div>
`
