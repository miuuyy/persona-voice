"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  WaveformTelemetry,
  frameEnvelope,
} = require("../electron/waveform-telemetry.cjs");

function frame({ amplitude, sampleRate = 48_000, channels = 2, durationMs = 20 }) {
  const samplesPerChannel = Math.round(sampleRate * durationMs / 1000);
  const pcm = Buffer.alloc(samplesPerChannel * channels * 4);
  for (let sample = 0; sample < samplesPerChannel; sample += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      pcm.writeFloatLE(amplitude, (sample * channels + channel) * 4);
    }
  }
  return { sequence: 1, sampleRate, channels, sampleFormat: "f32le", samplesPerChannel, pcm };
}

test("waveform envelope emits bounded ten-millisecond amplitude points", () => {
  const samples = frameEnvelope(frame({ amplitude: 0.25 }));
  assert.equal(samples.length, 2);
  assert.ok(samples.every((sample) => sample > 0 && sample <= 1));
  assert.deepEqual(frameEnvelope(frame({ amplitude: 0 })), [0, 0]);
});

test("telemetry publishes only while visible and never includes source PCM", () => {
  let now = 1_000;
  const published = [];
  const telemetry = new WaveformTelemetry({ publish: (value) => published.push(value), clock: () => now });
  const source = frame({ amplitude: 0.2 });

  telemetry.acceptSource(source);
  assert.equal(published.length, 0);

  telemetry.setActive(true);
  telemetry.acceptSource(source);
  now = 1_180;
  telemetry.acceptOutput(frame({ amplitude: 0.3, sampleRate: 24_000, channels: 1, durationMs: 10 }), {
    latencyMs: 176.44,
    inferenceMs: 143.26,
  });

  assert.equal(published[0].type, "reset");
  assert.equal(published[1].stream, "source");
  assert.equal(published[1].startAtMs, 980);
  assert.equal("pcm" in published[1], false);
  assert.equal(published[2].stream, "converted");
  assert.equal(published[2].pipelineLatencyMs, 176.4);
  assert.equal(published[2].inferenceMs, 143.3);
  assert.equal("pcm" in published[2], false);

  telemetry.setActive(false);
  telemetry.acceptSource(source);
  assert.equal(published.length, 3);
});
