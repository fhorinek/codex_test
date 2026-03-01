/**
 * Module: Lightweight frontend performance monitor for interaction responsiveness.
 */

type MetricAggregate = {
  count: number;
  totalMs: number;
  maxMs: number;
  over16Ms: number;
  over50Ms: number;
  samples: number[];
};

type InteractionAggregate = {
  durationMs: number;
  name: string;
};

export type TaskScriptPerfMetricSummary = {
  name: string;
  count: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  over16Ms: number;
  over50Ms: number;
};

export type TaskScriptPerfReport = {
  enabled: boolean;
  runningForMs: number;
  metricCount: number;
  longTaskCount: number;
  worstInteractionMs: number;
  worstInteractionName: string;
  interactionCount: number;
  metrics: TaskScriptPerfMetricSummary[];
};

type TaskScriptPerfApi = {
  enable: () => void;
  disable: () => void;
  reset: () => void;
  snapshot: () => TaskScriptPerfReport;
  print: () => TaskScriptPerfReport;
};

const METRIC_SAMPLE_LIMIT = 300;
const STORAGE_KEY = "taskScript.perfMonitor.v1";

let initialized = false;
let enabled = false;
let startedAtMs = 0;
let frameLoopId: number | null = null;
let lastFrameTimestampMs: number | null = null;
let longTaskObserver: PerformanceObserver | null = null;
let eventObserver: PerformanceObserver | null = null;

const metrics = new Map<string, MetricAggregate>();
const interactions = new Map<number, InteractionAggregate>();

function toToggleValue(value: string | null): boolean | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  return null;
}

function readStorageToggle(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStorageToggle(active: boolean): void {
  try {
    if (active) {
      localStorage.setItem(STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

function readQueryToggle(): boolean | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    return toToggleValue(params.get("perf"));
  } catch {
    return null;
  }
}

function supportsEntryType(type: string): boolean {
  if (typeof PerformanceObserver === "undefined") {
    return false;
  }
  const supported = (PerformanceObserver as any).supportedEntryTypes;
  return Array.isArray(supported) && supported.includes(type);
}

function ensureMetric(name: string): MetricAggregate {
  let metric = metrics.get(name);
  if (!metric) {
    metric = {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      over16Ms: 0,
      over50Ms: 0,
      samples: [],
    };
    metrics.set(name, metric);
  }
  return metric;
}

function recordDuration(name: string, durationMs: number): void {
  if (!enabled || !Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  const metric = ensureMetric(name);
  metric.count += 1;
  metric.totalMs += durationMs;
  metric.maxMs = Math.max(metric.maxMs, durationMs);
  if (durationMs > 16.7) {
    metric.over16Ms += 1;
  }
  if (durationMs > 50) {
    metric.over50Ms += 1;
  }
  metric.samples.push(durationMs);
  if (metric.samples.length > METRIC_SAMPLE_LIMIT) {
    metric.samples.shift();
  }
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function metricSummary(name: string, metric: MetricAggregate): TaskScriptPerfMetricSummary {
  return {
    name,
    count: metric.count,
    avgMs: metric.count ? metric.totalMs / metric.count : 0,
    p95Ms: percentile(metric.samples, 0.95),
    maxMs: metric.maxMs,
    totalMs: metric.totalMs,
    over16Ms: metric.over16Ms,
    over50Ms: metric.over50Ms,
  };
}

function maybeTrackInteraction(entry: any): void {
  const interactionId = Number(entry?.interactionId || 0);
  const durationMs = Number(entry?.duration || 0);
  if (!interactionId || !Number.isFinite(durationMs) || durationMs <= 0) {
    return;
  }
  const prev = interactions.get(interactionId);
  if (!prev || durationMs > prev.durationMs) {
    interactions.set(interactionId, {
      durationMs,
      name: String(entry?.name || "interaction"),
    });
  }
}

function createReport(): TaskScriptPerfReport {
  let worstInteractionMs = 0;
  let worstInteractionName = "n/a";
  interactions.forEach((entry) => {
    if (entry.durationMs > worstInteractionMs) {
      worstInteractionMs = entry.durationMs;
      worstInteractionName = entry.name;
    }
  });

  const metricList = Array.from(metrics.entries())
    .map(([name, metric]) => metricSummary(name, metric))
    .sort((a, b) => b.totalMs - a.totalMs || b.maxMs - a.maxMs);

  return {
    enabled,
    runningForMs: enabled && startedAtMs > 0 ? Math.max(0, performance.now() - startedAtMs) : 0,
    metricCount: metricList.length,
    longTaskCount: metrics.get("browser.longtask")?.count || 0,
    worstInteractionMs,
    worstInteractionName,
    interactionCount: interactions.size,
    metrics: metricList,
  };
}

function startFrameLoop(): void {
  if (!enabled || typeof requestAnimationFrame !== "function") {
    return;
  }
  if (frameLoopId) {
    cancelAnimationFrame(frameLoopId);
    frameLoopId = null;
  }
  lastFrameTimestampMs = null;
  const tick = (timestampMs: number): void => {
    if (!enabled) {
      frameLoopId = null;
      return;
    }
    if (lastFrameTimestampMs !== null) {
      recordDuration("browser.frameDelta", timestampMs - lastFrameTimestampMs);
    }
    lastFrameTimestampMs = timestampMs;
    frameLoopId = requestAnimationFrame(tick);
  };
  frameLoopId = requestAnimationFrame(tick);
}

function stopFrameLoop(): void {
  if (frameLoopId) {
    cancelAnimationFrame(frameLoopId);
    frameLoopId = null;
  }
  lastFrameTimestampMs = null;
}

function startObservers(): void {
  stopObservers();

  if (supportsEntryType("longtask")) {
    longTaskObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        recordDuration("browser.longtask", entry.duration);
      });
    });
    longTaskObserver.observe({ type: "longtask", buffered: true } as any);
  }

  if (supportsEntryType("event")) {
    eventObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        const eventEntry = entry as any;
        recordDuration(`browser.event.${eventEntry?.name || "unknown"}`, Number(eventEntry?.duration || 0));
        maybeTrackInteraction(eventEntry);
      });
    });
    eventObserver.observe({ type: "event", buffered: true, durationThreshold: 16 } as any);
  }
}

function stopObservers(): void {
  if (longTaskObserver) {
    longTaskObserver.disconnect();
    longTaskObserver = null;
  }
  if (eventObserver) {
    eventObserver.disconnect();
    eventObserver = null;
  }
}

function attachWindowApi(): void {
  if (typeof window === "undefined") {
    return;
  }
  const api: TaskScriptPerfApi = {
    enable: () => enablePerformanceMonitoring(true),
    disable: () => disablePerformanceMonitoring(true),
    reset: () => resetPerformanceMonitoring(),
    snapshot: () => createReport(),
    print: () => printPerformanceReport(),
  };
  window.__taskScriptPerf = api;
}

export function initPerformanceMonitoring(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  attachWindowApi();

  const queryToggle = readQueryToggle();
  if (queryToggle === true) {
    enablePerformanceMonitoring(false);
    return;
  }
  if (queryToggle === false) {
    disablePerformanceMonitoring(false);
    return;
  }
  if (readStorageToggle()) {
    enablePerformanceMonitoring(false);
  }
}

export function enablePerformanceMonitoring(persist = false): void {
  if (persist) {
    writeStorageToggle(true);
  }
  if (enabled) {
    return;
  }
  enabled = true;
  if (!startedAtMs && typeof performance !== "undefined") {
    startedAtMs = performance.now();
  }
  startObservers();
  startFrameLoop();
}

export function disablePerformanceMonitoring(persist = false): void {
  if (persist) {
    writeStorageToggle(false);
  }
  if (!enabled) {
    return;
  }
  enabled = false;
  stopObservers();
  stopFrameLoop();
}

export function resetPerformanceMonitoring(): void {
  metrics.clear();
  interactions.clear();
  startedAtMs = enabled && typeof performance !== "undefined" ? performance.now() : 0;
}

export function measurePerformanceSync<T>(name: string, fn: () => T): T {
  if (!enabled || typeof performance === "undefined" || typeof performance.now !== "function") {
    return fn();
  }
  const startMs = performance.now();
  try {
    return fn();
  } finally {
    recordDuration(name, performance.now() - startMs);
  }
}

export function getPerformanceReport(): TaskScriptPerfReport {
  return createReport();
}

export function printPerformanceReport(): TaskScriptPerfReport {
  const report = createReport();
  if (typeof console !== "undefined") {
    console.groupCollapsed(
      `[taskscript-perf] ${report.enabled ? "enabled" : "disabled"} | long tasks: ${report.longTaskCount} | worst interaction: ${report.worstInteractionMs.toFixed(1)}ms`
    );
    console.log("summary", {
      runningForMs: Number(report.runningForMs.toFixed(1)),
      longTaskCount: report.longTaskCount,
      worstInteractionMs: Number(report.worstInteractionMs.toFixed(1)),
      worstInteractionName: report.worstInteractionName,
      interactionCount: report.interactionCount,
    });
    console.table(
      report.metrics.slice(0, 25).map((metric) => ({
        metric: metric.name,
        count: metric.count,
        avgMs: Number(metric.avgMs.toFixed(2)),
        p95Ms: Number(metric.p95Ms.toFixed(2)),
        maxMs: Number(metric.maxMs.toFixed(2)),
        totalMs: Number(metric.totalMs.toFixed(2)),
        over16Ms: metric.over16Ms,
        over50Ms: metric.over50Ms,
      }))
    );
    console.groupEnd();
  }
  return report;
}
