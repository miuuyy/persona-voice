"use strict";

const { EventEmitter } = require("node:events");

const MAX_QUEUED_AUDIO_MS = 6_000;

class PipelineBlockedError extends Error {
  constructor(checks) {
    const blockers = checks.filter((check) => !check.ready);
    super(blockers.map((check) => check.detail).join("; ") || "The voice relay is not ready");
    this.name = "PipelineBlockedError";
    this.code = "pipeline_blocked";
    this.checks = blockers;
  }
}

class PipelineStartupCancelledError extends Error {
  constructor() {
    super("Voice relay startup was cancelled");
    this.name = "PipelineStartupCancelledError";
    this.code = "pipeline_start_cancelled";
  }
}

function normalizeCheck(id, result) {
  return {
    id,
    label: result?.label || id,
    ready: result?.ready === true,
    code: typeof result?.code === "string" ? result.code : result?.ready === true ? "ready" : "unavailable",
    detail: typeof result?.detail === "string" && result.detail.trim()
      ? result.detail.trim()
      : result?.ready === true ? "Ready" : "Unavailable",
  };
}

function normalizeAudioFormat(value, owner = "Audio session") {
  if (!value || value.sampleFormat !== "f32le" ||
      !Number.isInteger(value.sampleRate) || value.sampleRate < 8_000 || value.sampleRate > 192_000 ||
      !Number.isInteger(value.channels) || value.channels < 1 || value.channels > 2) {
    throw new Error(`${owner} did not declare a supported f32le format`);
  }
  return {
    sampleRate: value.sampleRate,
    channels: value.channels,
    sampleFormat: value.sampleFormat,
  };
}

function frameDurationMs(frame) {
  if (!frame || !Number.isInteger(frame.samplesPerChannel) || frame.samplesPerChannel <= 0 ||
      !Number.isInteger(frame.sampleRate) || frame.sampleRate < 8_000 || frame.sampleRate > 192_000) {
    throw new Error("Source emitted audio without valid duration metadata");
  }
  return frame.samplesPerChannel * 1000 / frame.sampleRate;
}

function sameAudioFormat(left, right) {
  return left.sampleRate === right.sampleRate &&
    left.channels === right.channels &&
    left.sampleFormat === right.sampleFormat;
}

function validateAudioFrame(frame, expectedFormat, owner) {
  const actualFormat = normalizeAudioFormat(frame, owner);
  if (!sameAudioFormat(actualFormat, expectedFormat)) {
    throw new Error(`${owner} format changed during the active relay`);
  }
  const durationMs = frameDurationMs(frame);
  if (!Number.isInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffff_ffff) {
    throw new Error(`${owner} sequence must be an unsigned 32-bit integer`);
  }
  const expectedBytes = frame.samplesPerChannel * frame.channels * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expectedBytes) || !Buffer.isBuffer(frame.pcm) || frame.pcm.length !== expectedBytes) {
    throw new Error(`${owner} PCM byte length does not match its metadata`);
  }
  return durationMs;
}

class PipelineRuntime extends EventEmitter {
  constructor({
    source,
    suppression,
    engine,
    output,
    clock = () => new Date(),
    maxQueuedAudioMs = MAX_QUEUED_AUDIO_MS,
    maxOutputFrameMs = 40,
    shutdownDrainTimeoutMs = 5_000,
    now = () => Date.now(),
    onInputFrame = () => {},
    onOutputFrame = async () => {},
  }) {
    super();
    this.adapters = { source, suppression, engine, output };
    this.clock = clock;
    this.state = "stopped";
    this.error = null;
    this.startedAt = null;
    this.checks = [];
    this.sessions = {};
    this.sourceFormat = null;
    this.outputFormat = null;
    this.processingQueue = Promise.resolve();
    this.frameQueue = Promise.resolve();
    this.queuedAudioMs = 0;
    this.maxQueuedAudioMs = maxQueuedAudioMs;
    this.maxOutputFrameMs = maxOutputFrameMs;
    this.shutdownDrainTimeoutMs = shutdownDrainTimeoutMs;
    this.now = now;
    this.onInputFrame = onInputFrame;
    this.onOutputFrame = onOutputFrame;
    this.startupError = null;
    this.faultPromise = null;
    this.config = null;
    this.routeStatus = null;
    this.transitionQueue = Promise.resolve();
    this.inspectGeneration = 0;
    this.startup = null;
    this.stopPromise = null;
    this.suppressionError = null;
  }

  snapshot() {
    return {
      state: this.state,
      error: this.error,
      startedAt: this.startedAt,
      suppressionHeld: (() => {
        try { return this.sessions.suppression?.originalSuppressed === true; }
        catch { return false; }
      })(),
      suppressionUncertain: (() => {
        try { return this.sessions.suppression?.restorationUnproven === true; }
        catch { return true; }
      })(),
      queuedAudioMs: Math.round(this.queuedAudioMs * 10) / 10,
      checks: this.checks.map((check) => ({ ...check })),
      ready: this.checks.length === 4 && this.checks.every((check) => check.ready),
    };
  }

  publish() {
    this.emit("changed", this.snapshot());
  }

  async inspect(config) {
    if (this.state !== "stopped" && this.state !== "starting") return this.snapshot();
    const generation = ++this.inspectGeneration;
    const names = ["source", "suppression", "engine", "output"];
    const checks = await Promise.all(names.map(async (name) => {
      try {
        return normalizeCheck(name, await this.adapters[name].probe(config));
      } catch (error) {
        return normalizeCheck(name, {
          ready: false,
          code: `${name}_probe_failed`,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }));
    if (generation !== this.inspectGeneration || (this.state !== "stopped" && this.state !== "starting")) {
      return this.snapshot();
    }
    this.checks = checks;
    this.publish();
    return this.snapshot();
  }

  async start(config) {
    if (this.state !== "stopped") throw new Error(`Cannot start the relay while it is ${this.state}`);
    const startup = {
      cancelled: false,
      finished: null,
      finish: null,
      controller: new AbortController(),
    };
    startup.finished = new Promise((resolve) => { startup.finish = resolve; });
    this.startup = startup;
    this.state = "starting";
    this.error = null;
    this.startupError = null;
    this.suppressionError = null;
    this.frameQueue = Promise.resolve();
    this.processingQueue = Promise.resolve();
    this.queuedAudioMs = 0;
    this.config = config;
    this.routeStatus = null;
    this.transitionQueue = Promise.resolve();
    this.publish();

    try {
      const readiness = await this.inspect(config);
      this.throwIfStartupCancelled(startup);
      if (!readiness.ready) {
        this.state = "stopped";
        this.config = null;
        this.routeStatus = null;
        this.publish();
        throw new PipelineBlockedError(readiness.checks);
      }

      const sourceFormat = normalizeAudioFormat(await this.adapters.source.describe(config), "Audio source");
      this.throwIfStartupCancelled(startup);
      this.sourceFormat = sourceFormat;
      this.sessions.engine = await this.adapters.engine.prepare(
        config,
        sourceFormat,
        { signal: startup.controller.signal },
      );
      this.throwIfStartupCancelled(startup);
      if (typeof this.sessions.engine?.convert !== "function" ||
          typeof this.sessions.engine?.reset !== "function" ||
          typeof this.sessions.engine?.close !== "function") {
        throw new Error("Voice engine session must implement convert, reset, and close");
      }
      const outputFormat = normalizeAudioFormat(this.sessions.engine.outputFormat, "Voice engine");
      this.outputFormat = outputFormat;
      this.sessions.suppression = await this.adapters.suppression.acquire(
        config,
        (error) => this.handleSuppressionError(error),
        (status) => this.handleRouteStatus(status),
        { signal: startup.controller.signal },
      );
      this.throwIfStartupCancelled(startup);
      if (this.sessions.suppression?.armed !== true) {
        throw new Error("The source backend did not prove that its route is safely armed");
      }
      if (typeof this.sessions.suppression?.close !== "function") {
        throw new Error("Source suppression session must implement close");
      }
      if (!sameAudioFormat(
        normalizeAudioFormat(this.sessions.suppression.format, "Source suppression"),
        sourceFormat,
      )) {
        throw new Error("Source audio format changed while the muted route was being acquired");
      }
      this.sessions.source = await this.adapters.source.open(
        config,
        (frame) => this.enqueueFrame(frame),
        (error) => this.handleAdapterError(error),
      );
      this.throwIfStartupCancelled(startup);
      if (typeof this.sessions.source?.close !== "function") {
        throw new Error("Audio source session must implement close");
      }
      if (!sameAudioFormat(normalizeAudioFormat(this.sessions.source.format, "Audio source"), sourceFormat)) {
        throw new Error("Opened source format does not match the prepared voice engine");
      }
      if (this.startupError) throw this.startupError;
      this.throwIfStartupCancelled(startup);
      this.state = "armed";
      this.startedAt = this.clock().toISOString();
      this.publish();
      if (this.routeStatus?.state === "engaged") {
        this.handleRouteStatus(this.routeStatus);
        await this.transitionQueue;
      }
      if (this.state === "faulted") throw new Error(this.error || "Voice route engagement failed");
      return this.snapshot();
    } catch (caughtError) {
      if (caughtError?.suppressionSession && !this.sessions.suppression) {
        this.sessions.suppression = caughtError.suppressionSession;
      }
      const error = startup.cancelled ? new PipelineStartupCancelledError() : caughtError;
      if (error instanceof PipelineBlockedError) throw error;
      if (this.state === "faulted") throw error;
      const cleanupErrors = await this.rollbackStartup();
      const primary = error instanceof Error ? error.message : String(error);
      this.state = cleanupErrors.length > 0 ? "faulted" : "stopped";
      this.error = cleanupErrors.length > 0
        ? `${primary}; startup rollback failed: ${cleanupErrors.join("; ")}`
        : startup.cancelled ? null : primary;
      if (this.error) this.error = this.errorWithSuppressionTruth(this.error);
      if (cleanupErrors.length === 0) {
        this.startedAt = null;
        this.sourceFormat = null;
        this.outputFormat = null;
        this.config = null;
        this.routeStatus = null;
      }
      this.publish();
      if (cleanupErrors.length > 0) throw new Error(this.error);
      throw error;
    } finally {
      if (this.startup === startup) this.startup = null;
      startup.finish();
    }
  }

  throwIfStartupCancelled(startup) {
    if (startup.cancelled) throw new PipelineStartupCancelledError();
  }

  handleAdapterError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.state === "starting" || this.state === "engaging") {
      if (!this.startupError) this.startupError = normalized;
      return;
    }
    if (this.state === "armed" || this.state === "running") void this.fault(normalized);
  }

  handleSuppressionError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code ||= "source_suppression_lost";
    if (normalized.suppressionHeld !== true) {
      normalized.suppressionHeld = false;
      this.suppressionError = normalized;
    }
    if (this.state === "faulted") {
      this.error = normalized.suppressionHeld === true
        ? this.appendDistinctError(this.error, normalized.message)
        : this.errorWithSuppressionTruth(this.error || normalized.message);
      this.publish();
      return;
    }
    this.handleAdapterError(normalized);
  }

  handleRouteStatus(status) {
    if (!status || (status.state !== "armed" && status.state !== "engaged") ||
        status.originalSuppressed !== (status.state === "engaged")) {
      this.handleAdapterError(new Error("Audio source emitted an invalid route lifecycle state"));
      return;
    }
    const nextStatus = { ...status };
    this.routeStatus = nextStatus;
    if (this.state === "starting") return;
    if (this.state === "faulted") {
      this.publish();
      return;
    }
    this.transitionQueue = this.transitionQueue
      .then(() => this.applyRouteStatus(nextStatus))
      .catch((error) => this.fault(error));
  }

  async applyRouteStatus(status) {
    if (!status || this.state === "stopped" || this.state === "starting" ||
        this.state === "stopping" || this.state === "faulted") return;
    if (status.state === "engaged") {
      if (this.state !== "armed" || this.sessions.suppression?.originalSuppressed !== true) return;
      this.state = "engaging";
      this.startupError = null;
      this.publish();
      if (typeof this.sessions.engine.prime === "function") {
        await this.sessions.engine.prime();
      }
      if (this.startupError) throw this.startupError;
      if (this.state !== "engaging" || this.sessions.suppression?.originalSuppressed !== true) {
        if (this.state === "engaging") {
          this.state = "armed";
          this.publish();
        }
        return;
      }
      let output;
      try {
        output = await this.adapters.output.prepare(
          this.config,
          this.outputFormat,
          (error) => this.handleAdapterError(error),
        );
      } catch (error) {
        if (error?.outputSession && !this.sessions.output) this.sessions.output = error.outputSession;
        throw error;
      }
      if (typeof output?.write !== "function" || typeof output?.close !== "function") {
        await output?.close?.();
        throw new Error("Converted output session must implement write and close");
      }
      this.sessions.output = output;
      if (this.startupError) throw this.startupError;
      if (this.state !== "engaging" || this.sessions.suppression?.originalSuppressed !== true) {
        const errors = [];
        await this.closeSession("output", errors);
        if (errors.length > 0) throw new Error(errors.join("; "));
        if (this.state === "engaging") {
          this.state = "armed";
          this.publish();
        }
        return;
      }
      this.state = "running";
      if (typeof this.sessions.source?.activate === "function") {
        await this.sessions.source.activate();
      }
      this.publish();
      return;
    }

    if (this.state === "running" || this.state === "engaging") {
      if (typeof this.sessions.source?.pause === "function") {
        await this.sessions.source.pause();
      }
      this.state = "armed";
      this.publish();
      const errors = await this.suspendProcessing();
      if (errors.length > 0) {
        throw new Error(`Voice-session cleanup failed: ${errors.join("; ")}`);
      }
    }
  }

  enqueueFrame(frame) {
    if (this.state !== "running") return;
    let durationMs;
    try { durationMs = validateAudioFrame(frame, this.sourceFormat, "Audio source frame"); }
    catch (error) { void this.fault(error); return; }
    if (this.queuedAudioMs + durationMs > this.maxQueuedAudioMs) {
      void this.fault(new Error(
        `Conversion queue exceeded ${this.maxQueuedAudioMs} ms; original audio remains suppressed`,
      ));
      return;
    }
    this.queuedAudioMs += durationMs;
    const acceptedAtMs = this.now();
    this.onInputFrame(frame, { acceptedAtMs, durationMs });
    let failure = null;
    this.processingQueue = this.processingQueue
      .then(async () => {
        if (this.state !== "running") return;
        const converted = await this.sessions.engine.convert(frame);
        const frames = Array.isArray(converted) ? converted : converted ? [converted] : [];
        for (const outputFrame of frames) {
          if (this.state !== "running") return;
          const outputDurationMs = validateAudioFrame(
            outputFrame,
            this.outputFormat,
            "Voice engine output frame",
          );
          if (outputDurationMs > this.maxOutputFrameMs) {
            throw new Error(
              `Voice engine output frame exceeded ${this.maxOutputFrameMs} ms`,
            );
          }
          await this.sessions.output.write(outputFrame);
          await this.onOutputFrame(outputFrame, frame, {
            latencyMs: Math.max(0, this.now() - acceptedAtMs),
          });
        }
      })
      .catch((error) => { failure = error; })
      .finally(() => {
        this.queuedAudioMs = Math.max(0, this.queuedAudioMs - durationMs);
      });
    this.frameQueue = this.processingQueue.then(async () => {
      if (failure) await this.fault(failure);
      else if (this.faultPromise) await this.faultPromise;
    });
  }

  async fault(error) {
    if (this.faultPromise) return this.faultPromise;
    if (this.state !== "armed" && this.state !== "engaging" && this.state !== "running") return;
    this.state = "faulted";
    const primary = error instanceof Error ? error.message : String(error);
    this.error = primary;
    this.publish();
    this.faultPromise = (async () => {
      const cleanupErrors = await this.closeProcessingSessions();
      const failure = cleanupErrors.length > 0
        ? `${primary}; fault cleanup failed: ${cleanupErrors.join("; ")}`
        : primary;
      this.error = this.errorWithSuppressionTruth(failure);
      // The suppression session remains held until an explicit stop. This is intentional.
      this.publish();
    })();
    try { await this.faultPromise; }
    finally { this.faultPromise = null; }
  }

  errorWithSuppressionTruth(message) {
    if (!this.suppressionError) return message;
    const routeMessage = this.suppressionError.message;
    const parts = [message];
    if (routeMessage && !message.includes(routeMessage)) parts.push(routeMessage);
    const combined = parts.join("; ");
    return /original audio may now be audible/i.test(combined)
      ? combined
      : `${combined}. Original audio may now be audible.`;
  }

  appendDistinctError(current, next) {
    if (!current) return next;
    if (!next || current.includes(next)) return current;
    return `${current}; ${next}`;
  }

  async rollbackStartup() {
    const errors = [];
    await this.closeSession("source", errors);
    await this.closeSession("output", errors);
    await this.closeSession("engine", errors);
    if (errors.length === 0) {
      await this.closeSession("suppression", errors);
    }
    return errors;
  }

  async suspendProcessing() {
    const errors = [];
    let engineQuiesced = true;
    if (this.sessions.engine) {
      try {
        await this.sessions.engine.reset(null);
      } catch (error) {
        engineQuiesced = false;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`engine reset: ${message}`);
      }
    }
    if (engineQuiesced) {
      try { await this.waitForProcessingQueue(); }
      catch (error) {
        engineQuiesced = false;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`conversion queue: ${message}`);
      }
    }
    if (engineQuiesced) await this.closeSession("output", errors);
    if (errors.length === 0) {
      this.processingQueue = Promise.resolve();
      this.frameQueue = Promise.resolve();
      this.queuedAudioMs = 0;
    }
    return errors;
  }

  async closeSession(name, errors) {
    const session = this.sessions[name];
    if (!session) return;
    try {
      await session.close();
      if (this.sessions[name] === session) this.sessions[name] = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${name}: ${message}`);
    }
  }

  async waitForProcessingQueue() {
    let timer;
    try {
      await Promise.race([
        this.processingQueue,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            `Voice engine did not quiesce within ${this.shutdownDrainTimeoutMs} ms`,
          )), this.shutdownDrainTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async closeProcessingSessions() {
    const errors = [];
    await this.closeSession("source", errors);

    let engineQuiesced = true;
    if (this.sessions.engine) {
      try {
        await this.sessions.engine.reset(null);
      } catch (error) {
        engineQuiesced = false;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`engine reset: ${message}`);
      }
    }
    if (engineQuiesced) {
      try { await this.waitForProcessingQueue(); }
      catch (error) {
        engineQuiesced = false;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`conversion queue: ${message}`);
      }
    }
    if (engineQuiesced) {
      await this.closeSession("output", errors);
      await this.closeSession("engine", errors);
    }
    return errors;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    const stopPromise = this.state === "starting"
      ? this.cancelStartup(this.startup)
      : this.stopActiveRelay();
    this.stopPromise = stopPromise;
    try { return await stopPromise; }
    finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }
  }

  async cancelStartup(startup) {
    if (!startup) throw new Error("Startup cancellation could not find an active startup operation");
    startup.cancelled = true;
    startup.controller.abort(new PipelineStartupCancelledError());
    this.inspectGeneration += 1;
    this.state = "stopping";
    this.publish();
    await startup.finished;
    if (this.state === "stopped") return this.snapshot();
    throw new Error(this.error || "Startup cancellation did not complete cleanly");
  }

  async stopActiveRelay() {
    if (this.faultPromise) await this.faultPromise;
    if (this.state === "stopped") return this.snapshot();
    if (this.state === "stopping") {
      throw new Error(`Cannot stop the relay while it is ${this.state}`);
    }
    this.state = "stopping";
    this.publish();
    await this.transitionQueue;
    const errors = await this.closeProcessingSessions();
    if (errors.length === 0) {
      await this.closeSession("suppression", errors);
    }
    if (errors.length > 0) {
      this.state = "faulted";
      this.error = `Shutdown could not restore every resource: ${errors.join("; ")}`;
      this.publish();
      throw new Error(this.error);
    }
    this.state = "stopped";
    this.error = null;
    this.startedAt = null;
    this.queuedAudioMs = 0;
    this.sourceFormat = null;
    this.outputFormat = null;
    this.config = null;
    this.routeStatus = null;
    this.suppressionError = null;
    this.publish();
    return this.snapshot();
  }
}

module.exports = {
  MAX_QUEUED_AUDIO_MS,
  PipelineBlockedError,
  PipelineStartupCancelledError,
  PipelineRuntime,
  frameDurationMs,
  normalizeAudioFormat,
  normalizeCheck,
  sameAudioFormat,
  validateAudioFrame,
};
