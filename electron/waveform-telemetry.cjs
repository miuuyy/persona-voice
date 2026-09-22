"use strict";

const ENVELOPE_INTERVAL_MS = 10;

function finiteMetric(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
}

function normalizedPeak(value) {
  if (!(value > 0)) return 0;
  const decibels = 20 * Math.log10(Math.min(1, value));
  return Math.max(0, Math.min(1, (decibels + 60) / 48));
}

function frameEnvelope(frame, intervalMs = ENVELOPE_INTERVAL_MS) {
  if (!frame || frame.sampleFormat !== "f32le" ||
      !Number.isInteger(frame.sampleRate) || frame.sampleRate < 8_000 || frame.sampleRate > 192_000 ||
      !Number.isInteger(frame.channels) || frame.channels < 1 || frame.channels > 2 ||
      !Number.isInteger(frame.samplesPerChannel) || frame.samplesPerChannel <= 0 ||
      !Buffer.isBuffer(frame.pcm) || frame.pcm.length !== frame.samplesPerChannel * frame.channels * 4 ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Waveform telemetry requires aligned f32le PCM");
  }

  const framesPerBucket = Math.max(1, Math.round(frame.sampleRate * intervalMs / 1000));
  const bucketCount = Math.ceil(frame.samplesPerChannel / framesPerBucket);
  const samples = new Array(bucketCount).fill(0);
  for (let sampleFrame = 0; sampleFrame < frame.samplesPerChannel; sampleFrame += 1) {
    let peak = 0;
    for (let channel = 0; channel < frame.channels; channel += 1) {
      const offset = (sampleFrame * frame.channels + channel) * 4;
      const value = frame.pcm.readFloatLE(offset);
      if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
    }
    const bucket = Math.floor(sampleFrame / framesPerBucket);
    samples[bucket] = Math.max(samples[bucket], peak);
  }
  return samples.map(normalizedPeak);
}

class WaveformTelemetry {
  constructor({ publish, clock = () => Date.now() }) {
    if (typeof publish !== "function") throw new TypeError("Waveform telemetry publisher is required");
    if (typeof clock !== "function") throw new TypeError("Waveform telemetry clock is required");
    this.publish = publish;
    this.clock = clock;
    this.active = false;
    this.sourceCursorMs = null;
    this.outputCursorMs = null;
  }

  setActive(active) {
    if (typeof active !== "boolean") throw new TypeError("Waveform telemetry activity must be boolean");
    this.active = active;
    this.sourceCursorMs = null;
    this.outputCursorMs = null;
    if (active) this.publish({ type: "reset", atMs: this.clock() });
    return this.active;
  }

  reset() {
    this.sourceCursorMs = null;
    this.outputCursorMs = null;
    if (this.active) this.publish({ type: "reset", atMs: this.clock() });
  }

  acceptSource(frame, { atMs = this.clock() } = {}) {
    if (!this.active) return;
    const samples = frameEnvelope(frame);
    const durationMs = frame.samplesPerChannel * 1000 / frame.sampleRate;
    const observedStart = atMs - durationMs;
    const startAtMs = this.sourceCursorMs !== null && Math.abs(this.sourceCursorMs - observedStart) <= 80
      ? this.sourceCursorMs
      : observedStart;
    const intervalMs = durationMs / samples.length;
    this.sourceCursorMs = startAtMs + durationMs;
    this.publish({
      type: "frame",
      stream: "source",
      startAtMs,
      intervalMs,
      samples,
      pipelineLatencyMs: null,
      inferenceMs: null,
    });
  }

  acceptOutput(frame, { latencyMs = null, inferenceMs = null, atMs = this.clock() } = {}) {
    if (!this.active) return;
    const samples = frameEnvelope(frame);
    const durationMs = frame.samplesPerChannel * 1000 / frame.sampleRate;
    const startAtMs = this.outputCursorMs !== null && this.outputCursorMs > atMs - 80
      ? Math.max(atMs, this.outputCursorMs)
      : atMs;
    const intervalMs = durationMs / samples.length;
    this.outputCursorMs = startAtMs + durationMs;
    this.publish({
      type: "frame",
      stream: "converted",
      startAtMs,
      intervalMs,
      samples,
      pipelineLatencyMs: finiteMetric(latencyMs),
      inferenceMs: finiteMetric(inferenceMs),
    });
  }
}

module.exports = {
  ENVELOPE_INTERVAL_MS,
  WaveformTelemetry,
  frameEnvelope,
  normalizedPeak,
};
