interface DurationSample {
  name: string;
  durationMs: number;
  at: number;
}

interface FrameSample {
  name: string;
  durationMs: number;
  fps: number;
  slowFramePercent: number;
  worstFrameMs: number;
  at: number;
}

const durations: DurationSample[] = [];
const frameSamples: FrameSample[] = [];
let longTaskCount = 0;
let longTaskTotalMs = 0;
let longestTaskMs = 0;
let started = false;
let samplingFrames = false;
let observer: PerformanceObserver | null = null;

function cap<T>(items: T[], maximum = 30) {
  if (items.length > maximum) items.splice(0, items.length - maximum);
}

export function startPerformanceMonitoring() {
  if (started || typeof window === "undefined") return;
  started = true;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskTotalMs += entry.duration;
        longestTaskMs = Math.max(longestTaskMs, entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    observer = null;
  }
}

export function recordDuration(name: string, durationMs: number) {
  if (!Number.isFinite(durationMs)) return;
  durations.push({ name, durationMs: Math.round(durationMs * 10) / 10, at: Date.now() });
  cap(durations);
}

export function sampleFrameRate(name: string, durationMs = 3_000) {
  if (samplingFrames || typeof requestAnimationFrame === "undefined") return;
  samplingFrames = true;
  const startedAt = performance.now();
  let previous = startedAt;
  const deltas: number[] = [];
  const tick = (now: number) => {
    deltas.push(now - previous);
    previous = now;
    if (now - startedAt < durationMs) {
      requestAnimationFrame(tick);
      return;
    }
    const elapsed = Math.max(1, now - startedAt);
    const slowFrames = deltas.filter((delta) => delta > 20).length;
    frameSamples.push({
      name,
      durationMs: Math.round(elapsed),
      fps: Math.round((deltas.length / elapsed) * 1_000),
      slowFramePercent: Math.round((slowFrames / Math.max(1, deltas.length)) * 1_000) / 10,
      worstFrameMs: Math.round(Math.max(...deltas) * 10) / 10,
      at: Date.now(),
    });
    cap(frameSamples, 10);
    samplingFrames = false;
  };
  requestAnimationFrame(tick);
}

export function getRuntimePerformance() {
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  return {
    navigation: navigation
      ? {
          domInteractiveMs: Math.round(navigation.domInteractive),
          domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
          loadEventMs: Math.round(navigation.loadEventEnd),
        }
      : undefined,
    longTasks: {
      count: longTaskCount,
      totalMs: Math.round(longTaskTotalMs),
      longestMs: Math.round(longestTaskMs),
    },
    memory: memory
      ? {
          usedJsHeapBytes: memory.usedJSHeapSize,
          totalJsHeapBytes: memory.totalJSHeapSize,
          heapLimitBytes: memory.jsHeapSizeLimit,
        }
      : undefined,
    durations: [...durations],
    frameSamples: [...frameSamples],
  };
}
