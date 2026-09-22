import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { formatMessage, useI18n } from "../i18n";
import { formatBytes, sourceLabel } from "../lib/presentation";
import type {
  LauncherSnapshot,
  VoiceBridge,
  WaveformTelemetry,
} from "../types";

const WINDOW_MS = 4_000;
const RETAIN_MS = WINDOW_MS + 1_000;
const APP_ICONS = {
  chatgpt: new URL("../assets/apps/chatgpt.png", import.meta.url).href,
  "grok-bot": new URL("../assets/apps/grok-bot.png", import.meta.url).href,
};

type WaveformPoint = { atMs: number; level: number };
function drawWaveform(
  canvas: HTMLCanvasElement,
  points: WaveformPoint[],
  color: string,
) {
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const scale = Math.max(1, window.devicePixelRatio || 1);
  if (canvas.width !== Math.floor(width * scale) || canvas.height !== Math.floor(height * scale)) {
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);

  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  while (points.length > 0 && points[0].atMs < now - RETAIN_MS) points.shift();

  const center = height / 2;
  const barSpacing = 5;
  const levels = new Float32Array(Math.ceil(width / barSpacing));
  for (const point of points) {
    if (point.atMs < windowStart || point.atMs > now) continue;
    const index = Math.floor((point.atMs - windowStart) / WINDOW_MS * levels.length);
    if (index < levels.length) levels[index] = Math.max(levels[index], point.level);
  }
  context.strokeStyle = color;
  context.lineWidth = 2.5;
  context.lineCap = "round";
  context.beginPath();
  levels.forEach((level, index) => {
    if (level <= 0) return;
    const x = index * barSpacing + barSpacing / 2;
    const amplitude = Math.max(1, level * height * 0.44);
    context.moveTo(x, center - amplitude);
    context.lineTo(x, center + amplitude);
  });
  context.stroke();
}

function WaveformLane({
  ariaLabel,
  points,
}: {
  ariaLabel: string;
  points: MutableRefObject<WaveformPoint[]>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const color = canvas.current ? window.getComputedStyle(canvas.current).color : "#afafaf";
    let animation = 0;
    const render = () => {
      if (canvas.current) drawWaveform(canvas.current, points.current, color);
      animation = window.requestAnimationFrame(render);
    };
    animation = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(animation);
  }, [points]);
  return <canvas aria-label={ariaLabel} className="visualizer-waveform" ref={canvas} role="img" />;
}

function appendFrame(target: WaveformPoint[], frame: Extract<WaveformTelemetry, { type: "frame" }>) {
  frame.samples.forEach((level, index) => {
    if (!Number.isFinite(level)) return;
    target.push({
      atMs: frame.startAtMs + frame.intervalMs * index,
      level: Math.max(0, Math.min(1, level)),
    });
  });
  if (target.length > 2_000) target.splice(0, target.length - 2_000);
}

export function VisualizerPage({
  bridge,
  snapshot,
}: {
  bridge: VoiceBridge;
  snapshot: LauncherSnapshot;
}) {
  const { locale, messages } = useI18n();
  const sourcePoints = useRef<WaveformPoint[]>([]);
  const convertedPoints = useRef<WaveformPoint[]>([]);
  const inferenceRef = useRef<number | null>(null);
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);

  useEffect(() => {
    const clear = () => {
      sourcePoints.current = [];
      convertedPoints.current = [];
      inferenceRef.current = null;
    };
    const unsubscribe = bridge.onVisualizerFrame((frame) => {
      if (frame.type === "reset") {
        clear();
        return;
      }
      appendFrame(frame.stream === "source" ? sourcePoints.current : convertedPoints.current, frame);
      if (frame.stream === "converted") {
        inferenceRef.current = frame.inferenceMs;
      }
    });
    void bridge.setVisualizerActive(true).catch(() => {});
    const metricTimer = window.setInterval(() => setInferenceMs(inferenceRef.current), 200);
    return () => {
      window.clearInterval(metricTimer);
      unsubscribe();
      void bridge.setVisualizerActive(false).catch(() => {});
    };
  }, [bridge]);

  const model = useMemo(
    () => snapshot.models.find((candidate) => candidate.id === snapshot.settings.selectedModelId),
    [snapshot.models, snapshot.settings.selectedModelId],
  );
  const appName = sourceLabel(snapshot.settings, messages);
  const installedSize = model?.installation.status === "ready"
    ? formatBytes(model.installation.installedBytes, locale)
    : null;
  const voiceName = snapshot.settings.selectedVoiceName || messages.home.selectedVoice;
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);

  return (
    <section className="content-surface visualizer-page">
      <div className="visualizer-stage">
        <div className="visualizer-lane">
          <div className="visualizer-lane-heading">
            <small>{messages.visualizer.original}</small>
            <div className="visualizer-app-name">
              {snapshot.settings.sourceMode === "desktop-application" ? (
                <img
                  alt=""
                  className="visualizer-app-icon"
                  draggable={false}
                  height={32}
                  src={APP_ICONS[snapshot.settings.targetApp]}
                  width={32}
                />
              ) : null}
              <strong>{appName}</strong>
            </div>
          </div>
          <WaveformLane ariaLabel={formatMessage(messages.visualizer.source, { app: appName })} points={sourcePoints} />
        </div>

        <div className="visualizer-model">
          <div className="visualizer-model-heading">
            <strong>{model?.name || snapshot.settings.selectedModelId}</strong>
            {installedSize ? (
              <span
                className="visualizer-model-size"
                title={`${messages.settings.voice.enginePackage} · ${formatMessage(messages.settings.voice.installedLocally, { size: installedSize })}`}
              >
                {installedSize}
              </span>
            ) : null}
          </div>
          <span>
            {inferenceMs !== null
              ? formatMessage(messages.visualizer.inference, { milliseconds: number(inferenceMs) })
              : messages.visualizer.waiting}
          </span>
        </div>

        <div className="visualizer-lane">
          <div className="visualizer-lane-heading">
            <small>{messages.visualizer.output}</small>
            <strong>{voiceName}</strong>
          </div>
          <WaveformLane ariaLabel={formatMessage(messages.visualizer.converted, { voice: voiceName })} points={convertedPoints} />
        </div>
      </div>
    </section>
  );
}
