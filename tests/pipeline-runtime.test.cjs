"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_QUEUED_AUDIO_MS,
  PipelineBlockedError,
  PipelineRuntime,
  PipelineStartupCancelledError,
} = require("../electron/pipeline-runtime.cjs");

function adapters({
  blocked = null,
  armed = true,
  initialRouteState = "engaged",
  convertError = null,
  log = [],
} = {}) {
  let onFrame = null;
  let onStatus = null;
  let onRouteError = null;
  let routeState = initialRouteState;
  const probe = (name) => async () => ({
    label: name,
    ready: blocked !== name,
    code: blocked === name ? `${name}_missing` : "ready",
    detail: blocked === name ? `${name} unavailable` : `${name} ready`,
  });
  return {
    emitFrame: (frame) => onFrame?.(frame),
    emitStatus: (state) => {
      routeState = state;
      onStatus?.({
        type: "status",
        state,
        originalSuppressed: state === "engaged",
      });
    },
    emitRouteError: (error) => {
      routeState = "lost";
      onRouteError?.(error);
    },
    value: {
      source: {
        probe: probe("source"),
        describe: async () => ({
          sampleRate: 48_000,
          channels: 2,
          sampleFormat: "f32le",
        }),
        open: async (_config, callback) => {
          log.push("source.open");
          onFrame = callback;
          return {
            format: { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
            close: async () => {
              log.push("source.close");
              onFrame = null;
            },
          };
        },
      },
      suppression: {
        probe: probe("suppression"),
        acquire: async (_config, routeErrorCallback, statusCallback) => {
          log.push("suppression.acquire");
          onRouteError = routeErrorCallback;
          onStatus = statusCallback;
          statusCallback({
            type: "status",
            state: routeState,
            originalSuppressed: routeState === "engaged",
          });
          return {
            armed,
            get originalSuppressed() {
              return routeState === "engaged";
            },
            format: { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
            close: async () => {
              log.push("suppression.close");
              onRouteError = null;
              onStatus = null;
            },
          };
        },
      },
      engine: {
        probe: probe("engine"),
        prepare: async (_config, sourceFormat) => {
          assert.deepEqual(sourceFormat, {
            sampleRate: 48_000,
            channels: 2,
            sampleFormat: "f32le",
          });
          log.push("engine.prepare");
          return {
            outputFormat: {
              sampleRate: 24_000,
              channels: 1,
              sampleFormat: "f32le",
            },
            convert: async (frame) => {
              log.push("engine.convert");
              if (convertError) throw convertError;
              return {
                sequence: frame.sequence,
                sampleRate: 24_000,
                channels: 1,
                sampleFormat: "f32le",
                samplesPerChannel: 240,
                pcm: Buffer.alloc(240 * 4),
                converted: true,
              };
            },
            reset: async () => {
              log.push("engine.reset");
            },
            close: async () => {
              log.push("engine.close");
            },
          };
        },
      },
      output: {
        probe: probe("output"),
        prepare: async (_config, format) => {
          assert.deepEqual(format, {
            sampleRate: 24_000,
            channels: 1,
            sampleFormat: "f32le",
          });
          log.push("output.prepare");
          return {
            write: async (frame) => {
              log.push(`output.write:${frame.converted}`);
            },
            close: async () => {
              log.push("output.close");
            },
          };
        },
      },
    },
  };
}

function sourceFrame(sequence = 1, samplesPerChannel = 480) {
  return {
    sequence,
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
    samplesPerChannel,
    pcm: Buffer.alloc(samplesPerChannel * 2 * 4),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("a blocked stage prevents every resource from opening", async () => {
  const log = [];
  const fixture = adapters({ blocked: "engine", log });
  const runtime = new PipelineRuntime(fixture.value);
  await assert.rejects(() => runtime.start({}), PipelineBlockedError);
  assert.deepEqual(log, []);
  assert.equal(runtime.snapshot().state, "stopped");
  assert.equal(runtime.snapshot().ready, false);
});

test("Stop cancels a readiness startup, rejects a concurrent restart, and leaves no late relay", async () => {
  const log = [];
  const fixture = adapters({ log });
  const sourceProbe = deferred();
  fixture.value.source.probe = async () => sourceProbe.promise;
  const runtime = new PipelineRuntime(fixture.value);
  const states = [];
  runtime.on("changed", (snapshot) => states.push(snapshot.state));

  const firstStart = runtime.start({});
  await new Promise((resolve) => setImmediate(resolve));
  const stop = runtime.stop();
  assert.equal(runtime.snapshot().state, "stopping");
  await assert.rejects(
    () => runtime.start({}),
    /Cannot start the relay while it is stopping/,
  );

  sourceProbe.resolve({
    label: "source",
    ready: true,
    code: "ready",
    detail: "source ready",
  });
  await assert.rejects(firstStart, PipelineStartupCancelledError);
  const stopped = await stop;

  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.error, null);
  assert.deepEqual(log, []);
  assert.equal(states.includes("armed"), false);
  assert.equal(states.includes("running"), false);

  await runtime.start({});
  assert.equal(runtime.snapshot().state, "running");
  await runtime.stop();
});

test("Stop during resource startup waits for and rolls back late resources", async () => {
  const log = [];
  const fixture = adapters({ log });
  const enteredAcquire = deferred();
  const releaseAcquire = deferred();
  const acquire = fixture.value.suppression.acquire;
  fixture.value.suppression.acquire = async (...args) => {
    enteredAcquire.resolve();
    await releaseAcquire.promise;
    return acquire(...args);
  };
  const runtime = new PipelineRuntime(fixture.value);
  const states = [];
  runtime.on("changed", (snapshot) => states.push(snapshot.state));

  const start = runtime.start({});
  await enteredAcquire.promise;
  const stop = runtime.stop();
  releaseAcquire.resolve();

  await assert.rejects(start, PipelineStartupCancelledError);
  await stop;
  assert.deepEqual(log, [
    "engine.prepare",
    "suppression.acquire",
    "engine.close",
    "suppression.close",
  ]);
  assert.equal(runtime.snapshot().state, "stopped");
  assert.equal(states.includes("armed"), false);
  assert.equal(states.includes("running"), false);
});

test("Stop aborts engine loading instead of waiting for its startup timeout", async () => {
  const fixture = adapters();
  const enteredPrepare = deferred();
  let observedSignal = null;
  fixture.value.engine.prepare = async (_config, _format, { signal }) => {
    observedSignal = signal;
    enteredPrepare.resolve();
    await new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  const runtime = new PipelineRuntime(fixture.value);
  const start = runtime.start({});
  await enteredPrepare.promise;
  const stop = runtime.stop();
  assert.equal(observedSignal.aborted, true);
  await assert.rejects(start, PipelineStartupCancelledError);
  assert.equal((await stop).state, "stopped");
});

test("a slower stale readiness probe cannot overwrite a newer result", async () => {
  const fixture = adapters();
  let releaseFirst;
  let sourceProbeCount = 0;
  fixture.value.source.probe = async () => {
    sourceProbeCount += 1;
    if (sourceProbeCount === 1) {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
      return {
        label: "source",
        ready: false,
        code: "old",
        detail: "old blocked result",
      };
    }
    return {
      label: "source",
      ready: true,
      code: "ready",
      detail: "new ready result",
    };
  };
  const runtime = new PipelineRuntime(fixture.value);
  const first = runtime.inspect({ generation: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = runtime.inspect({ generation: 2 });
  await second;
  assert.equal(runtime.snapshot().ready, true);
  assert.equal(runtime.snapshot().checks[0].detail, "new ready result");
  releaseFirst();
  await first;
  assert.equal(runtime.snapshot().ready, true);
  assert.equal(runtime.snapshot().checks[0].detail, "new ready result");
});

test("readiness inspection does not probe or mutate an active relay", async () => {
  const fixture = adapters();
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});
  const before = runtime.snapshot();
  let probes = 0;
  fixture.value.source.probe = async () => {
    probes += 1;
    return { ready: false };
  };
  const inspected = await runtime.inspect({});
  assert.equal(probes, 0);
  assert.deepEqual(inspected.checks, before.checks);
  assert.equal(inspected.state, "running");
  await runtime.stop();
});

test("startup warms conversion, arms capture, then opens output only after engagement", async () => {
  const log = [];
  const fixture = adapters({ log });
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});
  assert.deepEqual(log, [
    "engine.prepare",
    "suppression.acquire",
    "source.open",
    "output.prepare",
  ]);
  fixture.emitFrame(sourceFrame());
  await runtime.frameQueue;
  assert.deepEqual(log.slice(-2), ["engine.convert", "output.write:true"]);
  await runtime.stop();
  assert.deepEqual(log.slice(-5), [
    "source.close",
    "engine.reset",
    "output.close",
    "engine.close",
    "suppression.close",
  ]);
  assert.equal(runtime.snapshot().state, "stopped");
});

test("accepted source and converted output expose real timing to non-audio observers", async () => {
  const fixture = adapters();
  const observations = [];
  let now = 1_000;
  const originalPrepare = fixture.value.engine.prepare;
  fixture.value.engine.prepare = async (...args) => {
    const session = await originalPrepare(...args);
    const convert = session.convert;
    session.convert = async (frame) => {
      now += 143;
      return convert(frame);
    };
    return session;
  };
  const runtime = new PipelineRuntime({
    ...fixture.value,
    now: () => now,
    onInputFrame: (frame, context) => observations.push({ kind: "source", frame, context }),
    onOutputFrame: (frame, source, context) => observations.push({ kind: "output", frame, source, context }),
  });
  await runtime.start({});
  const input = sourceFrame(41);
  fixture.emitFrame(input);
  await runtime.frameQueue;

  assert.equal(observations.length, 2);
  assert.equal(observations[0].kind, "source");
  assert.equal(observations[0].frame, input);
  assert.equal(observations[0].context.acceptedAtMs, 1_000);
  assert.equal(observations[0].context.durationMs, 10);
  assert.equal(observations[1].kind, "output");
  assert.equal(observations[1].source, input);
  assert.equal(observations[1].context.latencyMs, 143);
  await runtime.stop();
});

test("armed passthrough does not start playback and can follow repeated voice sessions", async () => {
  const log = [];
  const fixture = adapters({ initialRouteState: "armed", log });
  const runtime = new PipelineRuntime(fixture.value);

  await runtime.start({});
  assert.equal(runtime.snapshot().state, "armed");
  assert.equal(runtime.snapshot().suppressionHeld, false);
  assert.deepEqual(log, [
    "engine.prepare",
    "suppression.acquire",
    "source.open",
  ]);

  fixture.emitStatus("engaged");
  await runtime.transitionQueue;
  assert.equal(runtime.snapshot().state, "running");
  assert.equal(runtime.snapshot().suppressionHeld, true);
  assert.equal(log.at(-1), "output.prepare");

  fixture.emitStatus("armed");
  await runtime.transitionQueue;
  assert.equal(runtime.snapshot().state, "armed");
  assert.equal(runtime.snapshot().suppressionHeld, false);
  assert.deepEqual(log.slice(-2), ["engine.reset", "output.close"]);

  fixture.emitStatus("engaged");
  await runtime.transitionQueue;
  assert.equal(runtime.snapshot().state, "running");
  assert.equal(log.filter((entry) => entry === "output.prepare").length, 2);
  await runtime.stop();
});

test("an engine session is re-primed after route engagement and before output opens", async () => {
  const log = [];
  const fixture = adapters({ initialRouteState: "armed", log });
  const prepare = fixture.value.engine.prepare;
  fixture.value.engine.prepare = async (...args) => ({
    ...(await prepare(...args)),
    prime: async () => {
      log.push("engine.prime");
    },
  });
  const runtime = new PipelineRuntime(fixture.value);

  await runtime.start({});
  fixture.emitStatus("engaged");
  await runtime.transitionQueue;

  assert.equal(runtime.snapshot().state, "running");
  assert.deepEqual(log.slice(-2), ["engine.prime", "output.prepare"]);
  await runtime.stop();
});

test("a pausable source releases handoff audio only after conversion output is ready", async () => {
  const log = [];
  const fixture = adapters({ initialRouteState: "armed", log });
  const sourceOpen = fixture.value.source.open;
  fixture.value.source.open = async (config, onFrame, onError) => {
    let active = false;
    let pending = [];
    const session = await sourceOpen(config, (frame) => {
      if (active) onFrame(frame);
      else pending.push(frame);
    }, onError);
    return {
      ...session,
      activate: async () => {
        log.push("source.activate");
        const queued = pending;
        pending = [];
        active = true;
        for (const frame of queued) onFrame(frame);
      },
      pause: async () => {
        log.push("source.pause");
        active = false;
      },
    };
  };
  const enginePrepare = fixture.value.engine.prepare;
  const priming = deferred();
  fixture.value.engine.prepare = async (...args) => ({
    ...(await enginePrepare(...args)),
    prime: async () => {
      log.push("engine.prime");
      await priming.promise;
    },
  });
  const runtime = new PipelineRuntime(fixture.value);

  await runtime.start({});
  fixture.emitStatus("engaged");
  await new Promise((resolve) => setImmediate(resolve));
  fixture.emitFrame(sourceFrame(30));
  fixture.emitFrame(sourceFrame(31));
  assert.equal(log.includes("engine.convert"), false);
  priming.resolve();
  await runtime.transitionQueue;
  await runtime.frameQueue;

  assert.equal(runtime.snapshot().state, "running");
  assert.deepEqual(
    log.filter((entry) => ["engine.prime", "output.prepare", "source.activate"].includes(entry)),
    ["engine.prime", "output.prepare", "source.activate"],
  );
  assert.equal(log.filter((entry) => entry === "engine.convert").length, 2);

  fixture.emitStatus("armed");
  await runtime.transitionQueue;
  assert.ok(log.indexOf("source.pause") < log.lastIndexOf("engine.reset"));
  await runtime.stop();
});

test("coalesced armed and engaged statuses still reset the engine between voice sessions", async () => {
  const log = [];
  const fixture = adapters({ log });
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});
  assert.equal(runtime.snapshot().state, "running");

  fixture.emitStatus("armed");
  fixture.emitStatus("engaged");
  await runtime.transitionQueue;

  assert.equal(runtime.snapshot().state, "running");
  assert.equal(log.filter((entry) => entry === "engine.reset").length, 1);
  assert.equal(log.filter((entry) => entry === "output.close").length, 1);
  assert.equal(log.filter((entry) => entry === "output.prepare").length, 2);
  await runtime.stop();
});

test("a voice session that ends during output startup never reaches running", async () => {
  const log = [];
  const fixture = adapters({ initialRouteState: "armed", log });
  let finishOutput;
  fixture.value.output.prepare = async () =>
    new Promise((resolve) => {
      finishOutput = () =>
        resolve({
          write: async () => {},
          close: async () => {
            log.push("output.close");
          },
        });
    });
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});

  fixture.emitStatus("engaged");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.snapshot().state, "engaging");
  fixture.emitStatus("armed");
  finishOutput();
  await runtime.transitionQueue;

  assert.equal(runtime.snapshot().state, "armed");
  assert.equal(runtime.snapshot().suppressionHeld, false);
  assert.equal(log.at(-1), "output.close");
  await runtime.stop();
});

test("a source that cannot prove safe arming is rolled back and never runs", async () => {
  const log = [];
  const fixture = adapters({ armed: false, log });
  const runtime = new PipelineRuntime(fixture.value);
  await assert.rejects(() => runtime.start({}), /safely armed/);
  assert.equal(runtime.snapshot().state, "stopped");
  assert.deepEqual(log, [
    "engine.prepare",
    "suppression.acquire",
    "engine.close",
    "suppression.close",
  ]);
});

test("conversion faults retain and publish the latest route-suppression truth", async () => {
  {
    const log = [];
    const fixture = adapters({
      convertError: new Error("inference failed"),
      log,
    });
    const runtime = new PipelineRuntime(fixture.value);
    await runtime.start({});
    fixture.emitFrame(sourceFrame());
    await runtime.frameQueue;
    assert.equal(runtime.snapshot().state, "faulted");
    assert.match(runtime.snapshot().error, /inference failed/);
    assert.equal(log.includes("suppression.close"), false);
    assert.deepEqual(log.slice(-5), [
      "engine.convert",
      "source.close",
      "engine.reset",
      "output.close",
      "engine.close",
    ]);
    await runtime.stop();
    assert.equal(log.at(-1), "suppression.close");
    assert.equal(runtime.snapshot().state, "stopped");
  }

  {
    const fixture = adapters({ convertError: new Error("inference failed") });
    const runtime = new PipelineRuntime(fixture.value);
    const snapshots = [];
    runtime.on("changed", (value) => snapshots.push(value));
    await runtime.start({});
    fixture.emitFrame(sourceFrame());
    await runtime.frameQueue;
    assert.equal(runtime.snapshot().state, "faulted");
    assert.equal(runtime.snapshot().suppressionHeld, true);

    const routeError = new Error(
      "Capture helper exited; the original route is no longer suppressed",
    );
    routeError.code = "source_suppression_lost";
    routeError.suppressionHeld = false;
    fixture.emitRouteError(routeError);
    assert.equal(runtime.snapshot().state, "faulted");
    assert.equal(runtime.snapshot().suppressionHeld, false);
    assert.match(runtime.snapshot().error, /may now be audible/);
    assert.equal(snapshots.at(-1).suppressionHeld, false);
    await runtime.stop();
  }

  {
    const fixture = adapters({ convertError: new Error("inference failed") });
    const runtime = new PipelineRuntime(fixture.value);
    const snapshots = [];
    runtime.on("changed", (value) => snapshots.push(value));
    await runtime.start({});
    fixture.emitFrame(sourceFrame());
    await runtime.frameQueue;
    assert.equal(runtime.snapshot().suppressionHeld, true);

    fixture.emitStatus("armed");
    assert.equal(runtime.snapshot().state, "faulted");
    assert.equal(runtime.snapshot().suppressionHeld, false);
    assert.equal(snapshots.at(-1).suppressionHeld, false);
    assert.doesNotMatch(runtime.snapshot().error, /may now be audible/);
    await runtime.stop();
  }

  {
    const fixture = adapters({ convertError: new Error("inference failed") });
    const resetEntered = deferred();
    const finishReset = deferred();
    const originalPrepare = fixture.value.engine.prepare;
    fixture.value.engine.prepare = async (...args) => {
      const session = await originalPrepare(...args);
      return {
        ...session,
        reset: async () => {
          resetEntered.resolve();
          await finishReset.promise;
        },
      };
    };
    const runtime = new PipelineRuntime(fixture.value);
    await runtime.start({});
    fixture.emitFrame(sourceFrame());
    await resetEntered.promise;
    const routeError = new Error("capture route disappeared");
    routeError.suppressionHeld = false;
    fixture.emitRouteError(routeError);
    finishReset.resolve();
    await runtime.frameQueue;

    assert.equal(runtime.snapshot().suppressionHeld, false);
    assert.match(runtime.snapshot().error, /inference failed/);
    assert.match(runtime.snapshot().error, /capture route disappeared/);
    assert.match(runtime.snapshot().error, /may now be audible/);
    await runtime.stop();
  }
});

test("bounded conversion queue faults before unbounded latency can accumulate", async () => {
  let releaseConversion;
  const fixture = adapters();
  fixture.value.engine.prepare = async () => ({
    outputFormat: { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    convert: () =>
      new Promise((resolve) => {
        releaseConversion = resolve;
      }),
    reset: async () => {
      releaseConversion?.([]);
    },
    close: async () => {},
  });
  const runtime = new PipelineRuntime({
    ...fixture.value,
    maxQueuedAudioMs: 30,
  });
  await runtime.start({});
  fixture.emitFrame(sourceFrame(1, 960));
  fixture.emitFrame(sourceFrame(2, 960));
  await runtime.faultPromise;
  assert.equal(runtime.snapshot().state, "faulted");
  assert.equal(runtime.snapshot().suppressionHeld, true);
  assert.match(runtime.snapshot().error, /exceeded 30 ms/);
  releaseConversion?.([]);
  await runtime.stop();
});

test("default conversion queue preserves a bounded multi-second transient backlog", async () => {
  const releaseFirstConversion = deferred();
  let first = true;
  const fixture = adapters();
  fixture.value.engine.prepare = async () => ({
    outputFormat: { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    convert: async () => {
      if (first) {
        first = false;
        await releaseFirstConversion.promise;
      }
      return [];
    },
    reset: async () => {
      releaseFirstConversion.resolve();
    },
    close: async () => {},
  });
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});

  for (let sequence = 1; sequence <= 250; sequence += 1) {
    fixture.emitFrame(sourceFrame(sequence, 960));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(MAX_QUEUED_AUDIO_MS, 6_000);
  assert.equal(runtime.snapshot().state, "running");
  assert.equal(runtime.snapshot().queuedAudioMs, 5_000);
  releaseFirstConversion.resolve();
  await runtime.frameQueue;
  assert.equal(runtime.snapshot().state, "running");
  assert.equal(runtime.snapshot().queuedAudioMs, 0);
  await runtime.stop();
});

test("failed suppression release stays faulted and can be retried", async () => {
  let attempts = 0;
  const fixture = adapters();
  fixture.value.suppression.acquire = async () => ({
    armed: true,
    originalSuppressed: true,
    format: { sampleRate: 48_000, channels: 2, sampleFormat: "f32le" },
    close: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("route still owned");
    },
  });
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});
  await assert.rejects(() => runtime.stop(), /route still owned/);
  assert.equal(runtime.snapshot().state, "faulted");
  await runtime.stop();
  assert.equal(attempts, 2);
  assert.equal(runtime.snapshot().state, "stopped");
});

test("Stop resets and drains an in-flight conversion before closing output or engine", async () => {
  const log = [];
  let releaseConversion;
  const fixture = adapters({ log });
  fixture.value.engine.prepare = async () => ({
    outputFormat: { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    convert: async () => {
      log.push("engine.convert");
      await new Promise((resolve) => {
        releaseConversion = resolve;
      });
      log.push("engine.convert.settled");
      return [];
    },
    reset: async () => {
      log.push("engine.reset");
      releaseConversion();
    },
    close: async () => {
      log.push("engine.close");
    },
  });
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});
  fixture.emitFrame(sourceFrame());
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop();
  assert.deepEqual(log.slice(-6), [
    "source.close",
    "engine.reset",
    "engine.convert.settled",
    "output.close",
    "engine.close",
    "suppression.close",
  ]);
});

test("processing cleanup failure retains suppression until a successful retry", async () => {
  const log = [];
  let outputCloseAttempts = 0;
  const fixture = adapters({ log });
  fixture.value.output.prepare = async () => ({
    write: async () => {},
    close: async () => {
      outputCloseAttempts += 1;
      log.push("output.close");
      if (outputCloseAttempts === 1)
        throw new Error("sink still owns hardware");
    },
  });
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});
  await assert.rejects(() => runtime.stop(), /sink still owns hardware/);
  assert.equal(runtime.snapshot().state, "faulted");
  assert.equal(runtime.snapshot().suppressionHeld, true);
  assert.equal(log.includes("suppression.close"), false);
  await runtime.stop();
  assert.equal(runtime.snapshot().state, "stopped");
  assert.equal(log.at(-1), "suppression.close");
});

test("startup rollback owns processing and partially acquired suppression until cleanup succeeds", async () => {
  {
    const log = [];
    const fixture = adapters({ log });
    fixture.value.source.open = async () => ({
      format: { sampleRate: 44_100, channels: 2, sampleFormat: "f32le" },
      close: async () => {
        log.push("source.close");
      },
    });
    const runtime = new PipelineRuntime(fixture.value);
    await assert.rejects(() => runtime.start({}), /does not match/);
    assert.deepEqual(log.slice(-3), [
      "source.close",
      "engine.close",
      "suppression.close",
    ]);
  }

  {
    let closeAttempts = 0;
    const fixture = adapters();
    const prepareEngine = fixture.value.engine.prepare;
    fixture.value.engine.prepare = async (...args) => {
      const session = await prepareEngine(...args);
      return {
        ...session,
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("engine rollback failed");
        },
      };
    };
    fixture.value.source.open = async () => ({
      format: { sampleRate: 44_100, channels: 2, sampleFormat: "f32le" },
      close: async () => {},
    });
    const runtime = new PipelineRuntime(fixture.value);
    await assert.rejects(() => runtime.start({}), /startup rollback failed/);
    assert.equal(runtime.snapshot().state, "faulted");
    assert.equal(runtime.snapshot().suppressionHeld, true);
    await runtime.stop();
    assert.equal(runtime.snapshot().state, "stopped");
  }

  {
    const fixture = adapters();
    let closes = 0;
    const retained = {
      get originalSuppressed() {
        return true;
      },
      close: async () => {
        closes += 1;
        if (closes === 1) throw new Error("capture helper still owned");
      },
    };
    fixture.value.suppression.acquire = async () => {
      const error = new Error("route acquisition failed");
      error.suppressionSession = retained;
      throw error;
    };
    const runtime = new PipelineRuntime(fixture.value);
    await assert.rejects(() => runtime.start({}), /capture helper still owned/);
    assert.equal(runtime.snapshot().state, "faulted");
    assert.equal(runtime.snapshot().suppressionHeld, true);
    await runtime.stop();
    assert.equal(closes, 2);
    assert.equal(runtime.snapshot().state, "stopped");
  }
});

test("a partially prepared output session is adopted and retried before suppression release", async () => {
  const fixture = adapters({ initialRouteState: "armed" });
  let closes = 0;
  const retained = {
    write: async () => {},
    close: async () => {
      closes += 1;
      if (closes === 1) throw new Error("output helper still active");
    },
  };
  fixture.value.output.prepare = async () => {
    const error = new Error("output startup failed");
    error.outputSession = retained;
    throw error;
  };
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});
  fixture.emitStatus("engaged");
  await runtime.transitionQueue;
  assert.equal(runtime.snapshot().state, "faulted");
  assert.equal(runtime.snapshot().suppressionHeld, true);
  assert.match(runtime.snapshot().error, /output helper still active/);
  await runtime.stop();
  assert.equal(closes, 2);
  assert.equal(runtime.snapshot().state, "stopped");
});

test("a conversion drain timeout returns faulted without releasing suppression", async () => {
  let releaseConversion;
  const fixture = adapters();
  fixture.value.engine.prepare = async () => ({
    outputFormat: { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    convert: async () =>
      new Promise((resolve) => {
        releaseConversion = resolve;
      }),
    reset: async () => {},
    close: async () => {},
  });
  const runtime = new PipelineRuntime({
    ...fixture.value,
    shutdownDrainTimeoutMs: 5,
  });
  await runtime.start({});
  fixture.emitFrame(sourceFrame());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => runtime.stop(), /did not quiesce/);
  assert.equal(runtime.snapshot().state, "faulted");
  assert.equal(runtime.snapshot().suppressionHeld, true);
  releaseConversion([]);
  await runtime.processingQueue;
  await runtime.stop();
  assert.equal(runtime.snapshot().state, "stopped");
});

test("source and engine frame format drift are terminal", async () => {
  const sourceFixture = adapters();
  const sourceRuntime = new PipelineRuntime(sourceFixture.value);
  await sourceRuntime.start({});
  sourceFixture.emitFrame({ ...sourceFrame(), sampleRate: 44_100 });
  await sourceRuntime.faultPromise;
  assert.equal(sourceRuntime.snapshot().state, "faulted");
  assert.match(
    sourceRuntime.snapshot().error,
    /Audio source frame format changed/,
  );
  assert.equal(sourceRuntime.snapshot().suppressionHeld, true);
  await sourceRuntime.stop();

  const engineFixture = adapters();
  engineFixture.value.engine.prepare = async () => ({
    outputFormat: { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    convert: async () => ({
      sequence: 1,
      sampleRate: 48_000,
      channels: 1,
      sampleFormat: "f32le",
      samplesPerChannel: 480,
      pcm: Buffer.alloc(480 * 4),
    }),
    reset: async () => {},
    close: async () => {},
  });
  const engineRuntime = new PipelineRuntime(engineFixture.value);
  await engineRuntime.start({});
  engineFixture.emitFrame(sourceFrame());
  await engineRuntime.frameQueue;
  assert.equal(engineRuntime.snapshot().state, "faulted");
  assert.match(
    engineRuntime.snapshot().error,
    /Voice engine output frame format changed/,
  );
  assert.equal(engineRuntime.snapshot().suppressionHeld, true);
  await engineRuntime.stop();
});

test("oversized engine output frames fault before reaching the native sink", async () => {
  let outputWrites = 0;
  const fixture = adapters();
  fixture.value.engine.prepare = async () => ({
    outputFormat: { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    convert: async () => ({
      sequence: 1,
      sampleRate: 24_000,
      channels: 1,
      sampleFormat: "f32le",
      samplesPerChannel: 1_200,
      pcm: Buffer.alloc(1_200 * 4),
    }),
    reset: async () => {},
    close: async () => {},
  });
  fixture.value.output.prepare = async () => ({
    write: async () => {
      outputWrites += 1;
    },
    close: async () => {},
  });
  const runtime = new PipelineRuntime(fixture.value);
  await runtime.start({});
  fixture.emitFrame(sourceFrame());
  await runtime.frameQueue;
  assert.equal(runtime.snapshot().state, "faulted");
  assert.match(runtime.snapshot().error, /exceeded 40 ms/);
  assert.equal(outputWrites, 0);
  await runtime.stop();
});
