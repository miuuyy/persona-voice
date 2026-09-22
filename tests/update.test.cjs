"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  buildJob,
  compareVersions,
  createUpdateController,
  expectedChecksum,
  macApplicationPath,
  releaseAssetName,
  validateReleaseAssetUrl,
  verifyChecksumSignature,
} = require("../electron/update.cjs");

test("release selection binds strict versions, platform assets, checksums, signatures, and URLs", () => {
  assert.equal(compareVersions("1.1.5", "1.1.4"), 1);
  assert.equal(compareVersions("1.1.4", "1.1.4"), 0);
  assert.equal(compareVersions("1.1.3", "1.1.4"), -1);
  assert.equal(compareVersions("1.2.0", "1.1.99"), 1);
  assert.equal(releaseAssetName("1.2.0", "darwin", "arm64"), "codex-persona-voice-1.2.0-mac-arm64.zip");
  assert.equal(releaseAssetName("1.2.0", "darwin", "x64"), "codex-persona-voice-1.2.0-mac-x64.zip");
  assert.equal(releaseAssetName("1.2.0", "win32", "x64"), null);
  assert.equal(releaseAssetName("1.2.0", "linux", "x64"), "codex-persona-voice-1.2.0-linux-x64.AppImage");
  assert.equal(releaseAssetName("1.2.0", "linux", "arm64"), null);
  const hash = "a".repeat(64);
  const checksums = `${hash}  launcher.zip\n`;
  assert.equal(expectedChecksum(checksums, "launcher.zip"), hash);
  assert.throws(() => expectedChecksum(`${hash}  other.zip\n`, "launcher.zip"), /no entry/);
  const url = "https://github.com/miuuyy/persona-voice/releases/download/v1.2.0/launcher.zip";
  assert.equal(validateReleaseAssetUrl(url, "1.2.0", "launcher.zip"), url);
  assert.throws(
    () => validateReleaseAssetUrl("https://example.com/launcher.zip", "1.2.0", "launcher.zip"),
    /unexpected release asset URL/,
  );
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const signature = crypto.sign(null, Buffer.from(checksums), privateKey).toString("base64");
  assert.equal(verifyChecksumSignature(checksums, signature, publicKey), true);
  assert.throws(
    () => verifyChecksumSignature(`${checksums}tampered`, signature, publicKey),
    /signature verification failed/,
  );
});

test("macOS bundle resolution and updater jobs require the atomic swap helper", (t) => {
  assert.equal(
    macApplicationPath("/Applications/Codex Persona Voice.app/Contents/MacOS/Codex Persona Voice"),
    "/Applications/Codex Persona Voice.app",
  );
  assert.throws(() => macApplicationPath("/tmp/Codex Persona Voice"), /Could not resolve/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-mac-update-job-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = path.join(root, "stage");
  const stagedExecutable = path.join(
    staging,
    "Codex Persona Voice.app",
    "Contents",
    "MacOS",
    "Codex Persona Voice",
  );
  fs.mkdirSync(path.dirname(stagedExecutable), { recursive: true });
  fs.writeFileSync(stagedExecutable, "fixture");
  const input = {
    version: "1.2.0",
    platform: "darwin",
    executablePath: "/Applications/Codex Persona Voice.app/Contents/MacOS/Codex Persona Voice",
    atomicSwapExecutable: "/Applications/Codex Persona Voice.app/Contents/Resources/native/darwin/cpv-atomic-swap",
    assetPath: path.join(root, "update.zip"),
    stagingRoot: staging,
    tempRoot: root,
    logPath: path.join(root, "update.log"),
  };
  assert.equal(buildJob(input).atomicSwapExecutable, input.atomicSwapExecutable);
  assert.throws(
    () => buildJob({ ...input, atomicSwapExecutable: null }),
    /atomic updater helper is unavailable/,
  );
});

test("development and packages without a worker runtime keep updates disabled", async () => {
  const development = createUpdateController({
    currentVersion: "1.1.4",
    platform: "darwin",
    arch: "arm64",
    packaged: false,
    executablePath: "/tmp/launcher",
    runtimeExecutable: "/tmp/bun",
    logsDirectory: "/tmp/logs",
  });
  const missingRuntime = createUpdateController({
    currentVersion: "1.1.4",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    executablePath: "/tmp/launcher",
    runtimeExecutable: null,
    logsDirectory: "/tmp/logs",
  });
  const missingAtomicSwap = createUpdateController({
    currentVersion: "1.1.4",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    executablePath: "/tmp/launcher",
    runtimeExecutable: "/tmp/bun",
    logsDirectory: "/tmp/logs",
  });
  assert.deepEqual(await development.checkOnce(), { status: "disabled" });
  assert.deepEqual(await missingRuntime.checkOnce(), { status: "disabled" });
  assert.deepEqual(await missingAtomicSwap.checkOnce(), { status: "disabled" });
});

test("startup check runs once and exposes only a newer complete release", async () => {
  let calls = 0;
  const published = [];
  const controller = createUpdateController({
    currentVersion: "1.1.4",
    platform: "linux",
    arch: "x64",
    packaged: true,
    executablePath: "/tmp/launcher",
    runtimeExecutable: "/tmp/bun",
    logsDirectory: "/tmp/logs",
    publish: (state) => published.push(state),
    dependencies: {
      fetchRelease: async () => {
        calls += 1;
        return {
          tag_name: "v1.2.0",
          assets: [
            {
              name: "codex-persona-voice-1.2.0-linux-x64.AppImage",
              browser_download_url: "https://github.com/miuuyy/persona-voice/releases/download/v1.2.0/codex-persona-voice-1.2.0-linux-x64.AppImage",
            },
            {
              name: "SHA256SUMS",
              browser_download_url: "https://github.com/miuuyy/persona-voice/releases/download/v1.2.0/SHA256SUMS",
            },
            {
              name: "SHA256SUMS.sig",
              browser_download_url: "https://github.com/miuuyy/persona-voice/releases/download/v1.2.0/SHA256SUMS.sig",
            },
          ],
        };
      },
    },
  });
  assert.deepEqual(await controller.checkOnce(), { status: "available", version: "1.2.0" });
  assert.deepEqual(await controller.checkOnce(), { status: "available", version: "1.2.0" });
  assert.equal(calls, 1);
  assert.deepEqual(published.map((state) => state.status), ["checking", "available"]);
});

test("verified update is handed to one detached worker", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-update-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldAppImage = path.join(root, "Codex Persona Voice.AppImage");
  fs.mkdirSync(path.dirname(oldAppImage), { recursive: true });
  fs.writeFileSync(oldAppImage, "old");
  const assetBody = Buffer.from("new appimage");
  const hash = crypto.createHash("sha256").update(assetBody).digest("hex");
  let spawned = null;
  const previousAppImage = process.env.APPIMAGE;
  process.env.APPIMAGE = oldAppImage;
  t.after(() => {
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  const controller = createUpdateController({
    currentVersion: "1.1.4",
    platform: "linux",
    arch: "x64",
    packaged: true,
    executablePath: "/tmp/launcher",
    runtimeExecutable: "/durable/bun",
    logsDirectory: path.join(root, "logs"),
    dependencies: {
      fetchRelease: async () => ({
        tag_name: "v1.2.0",
        assets: [
          {
            name: "codex-persona-voice-1.2.0-linux-x64.AppImage",
            browser_download_url: "https://github.com/miuuyy/persona-voice/releases/download/v1.2.0/codex-persona-voice-1.2.0-linux-x64.AppImage",
          },
          {
            name: "SHA256SUMS",
            browser_download_url: "https://github.com/miuuyy/persona-voice/releases/download/v1.2.0/SHA256SUMS",
          },
          {
            name: "SHA256SUMS.sig",
            browser_download_url: "https://github.com/miuuyy/persona-voice/releases/download/v1.2.0/SHA256SUMS.sig",
          },
        ],
      }),
      downloadText: async (url) => url.endsWith(".sig")
        ? "signed-fixture"
        : `${hash}  codex-persona-voice-1.2.0-linux-x64.AppImage\n`,
      verifyChecksumSignature: (contents, signature) => {
        assert.match(contents, /codex-persona-voice-1\.2\.0-linux-x64\.AppImage/);
        assert.equal(signature, "signed-fixture");
        return true;
      },
      downloadFile: async (_url, destination) => fs.writeFileSync(destination, assetBody),
      sha256: (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
      spawnWorker: (runtime, worker, job) => {
        spawned = { runtime, worker, job, data: JSON.parse(fs.readFileSync(job, "utf8")) };
        return { pid: 123, unref() {}, kill() {} };
      },
    },
  });
  await controller.checkOnce();
  const launch = await controller.beginInstall();
  assert.equal(spawned.runtime, "/durable/bun");
  assert.equal(spawned.data.version, "1.2.0");
  assert.equal(spawned.data.target, oldAppImage);
  assert.equal("wrapper" in spawned.data, false);
  assert.equal(controller.getState().status, "installing");
  controller.cancelInstall(launch);
  assert.equal(fs.existsSync(launch.tempRoot), false);
  assert.deepEqual(controller.getState(), { status: "available", version: "1.2.0" });
});

test("detached worker atomically replaces only the installed Linux AppImage", {
  skip: process.platform === "win32" ? "Linux AppImage execution is not meaningful on Windows" : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-worker-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobRoot = path.join(root, "job");
  const oldTarget = path.join(root, "Codex Persona Voice.AppImage");
  const marker = path.join(root, "launched");
  const source = path.join(jobRoot, "update.AppImage");
  const logPath = path.join(root, "logs", "update-worker.log");
  fs.mkdirSync(path.dirname(oldTarget), { recursive: true });
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.writeFileSync(oldTarget, "old", { mode: 0o755 });
  fs.writeFileSync(source, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const jobPath = path.join(jobRoot, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify({
    version: "1.2.0",
    platform: "linux",
    parentPid: 2_147_483_647,
    tempRoot: jobRoot,
    logPath,
    source,
    target: oldTarget,
  }));
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "electron", "update-worker.cjs"), jobPath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(oldTarget, "utf8"), /printf launched/);
  assert.equal(fs.existsSync(path.join(root, "unrelated")), false);
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.equal(fs.readFileSync(marker, "utf8"), "launched");
  assert.match(fs.readFileSync(logPath, "utf8"), /installed and relaunched/);
});
