/**
 * Opt-in, bounded diagnostics for real Tauri/WebKitGTK gallery scrolling.
 * The module observes the existing pipeline; it does not schedule image work.
 */

export type DiagnosticState = 'off' | 'recording' | 'stopped' | 'exported';
export type DiagnosticPageKind = 'refresh' | 'cursor';
export type DiagnosticPageOutcome =
  | 'success'
  | 'http_failure'
  | 'parse_failure'
  | 'network_failure'
  | 'aborted'
  | 'stale';

type PageStage =
  | 'response'
  | 'json'
  | 'mapped'
  | 'deduped'
  | 'arrays'
  | 'pre_virtualizer_wait'
  | 'virtualizer';

export type DiagnosticPageTrace = {
  generation: number;
  id: number;
  kind: DiagnosticPageKind;
  startedAt: number;
  lastStageAt: number;
  finished: boolean;
  serverDurationMs: number | null;
  stageDurations: Partial<Record<PageStage, number>>;
};

export type DiagnosticCardRef = {
  generation: number;
  lifecycle: number;
  key: string;
};

type DiagnosticConfiguration = {
  captureMountedCards: () => void;
  isGalleryActive: () => boolean;
};

type LatencyAggregate = {
  count: number;
  totalMs: number;
  maxMs: number;
};

type QueueSnapshot = {
  relativeMs: number;
  thumbQueueDepth: number | 'NOT MEASURED';
  thumbRunning: number | 'NOT MEASURED';
  thumbStaleRunning: number | 'NOT MEASURED';
  metadataRunning: number | 'NOT MEASURED';
  requestDurationMs: number;
};

type IntervalAggregate = {
  intervalStartMs: number;
  intervalEndMs: number;
  resolutionMs: number;
  compacted: boolean;
  scrollActivity: number;
  scrollDelta: number;
  scrollDirectionMask: number;
  maximumVisibleIndex: number;
  maximumMountedIndex: number;
  mountedCardsMax: number;
  pageRequestCount: number;
  pageOutcomes: Record<DiagnosticPageOutcome, number>;
  pageLatency: LatencyAggregate;
  pageServerLatency: LatencyAggregate;
  thumbnailRequestCount: number;
  thumbnailResourceLatency: LatencyAggregate;
  newVisibleImages: number;
  visibleImagesNotReady: number;
  visibleWaitLatency: LatencyAggregate;
  fallback202Count: number;
  queueSnapshot: QueueSnapshot | null;
  statusRequestCount: number;
  statusFailureCount: number;
  frameIntervalAnomalies: number;
  maximumFrameIntervalMs: number;
  renderRange: LatencyAggregate;
  virtualizerUpdate: LatencyAggregate;
};

type DiagnosticCard = {
  ref: DiagnosticCardRef;
  mountedAt: number;
  primaryStartedAt: number | null;
  firstVisibleAt: number | null;
  loadedAt: number | null;
  index: number;
  had202: boolean;
  recovered: boolean;
  failed: boolean;
};

type ImportantEvent = {
  relativeMs: number;
  type: string;
  maximumVisibleIndex: number;
  durationMs?: number;
  outcome?: string;
};

type SlowdownMarker = {
  marker: number;
  relativeTimeMs: number;
  intervalStartMs: number;
  maximumVisibleIndex: number;
  loadedMetadataCount: number;
  scrollActivity: number;
  recentPageLatencyMs: number | 'NOT MEASURED';
  recentThumbnailLatencyMs: number | 'NOT MEASURED';
  recentVisibleWaitMs: number | 'NOT MEASURED';
  recentMaximumFrameIntervalMs: number | 'NOT MEASURED';
  latestQueueSnapshot: QueueSnapshot | 'NOT MEASURED';
};

const INTERVAL_MS = 2_000;
const MAX_DETAILED_INTERVALS = 1_800;
const MAX_COARSE_INTERVALS = 720;
const MAX_IMPORTANT_EVENTS = 600;
const MAX_MARKERS = 50;
const QUEUE_SAMPLE_MS = 7_000;
const FRAME_ANOMALY_MS = 50;
const DISTRIBUTION_BOUNDS_MS = [
  1, 2, 4, 8, 12, 16, 20, 25, 33, 40, 50, 67, 80, 100, 125, 150, 200,
  250, 300, 400, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000,
  30_000, 60_000,
];

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function latencyAggregate(): LatencyAggregate {
  return {count: 0, totalMs: 0, maxMs: 0};
}

function addLatency(target: LatencyAggregate, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  target.count += 1;
  target.totalMs += value;
  target.maxMs = Math.max(target.maxMs, value);
}

function mergeLatency(target: LatencyAggregate, source: LatencyAggregate): void {
  target.count += source.count;
  target.totalMs += source.totalMs;
  target.maxMs = Math.max(target.maxMs, source.maxMs);
}

function latencySnapshot(value: LatencyAggregate): object {
  return {
    count: value.count,
    mean_ms: value.count ? rounded(value.totalMs / value.count) : 'NOT MEASURED',
    max_ms: value.count ? rounded(value.maxMs) : 'NOT MEASURED',
  };
}

function pageOutcomes(): Record<DiagnosticPageOutcome, number> {
  return {
    success: 0,
    http_failure: 0,
    parse_failure: 0,
    network_failure: 0,
    aborted: 0,
    stale: 0,
  };
}

function newInterval(start: number, end = start + INTERVAL_MS, compacted = false): IntervalAggregate {
  return {
    intervalStartMs: start,
    intervalEndMs: end,
    resolutionMs: end - start,
    compacted,
    scrollActivity: 0,
    scrollDelta: 0,
    scrollDirectionMask: 0,
    maximumVisibleIndex: -1,
    maximumMountedIndex: -1,
    mountedCardsMax: 0,
    pageRequestCount: 0,
    pageOutcomes: pageOutcomes(),
    pageLatency: latencyAggregate(),
    pageServerLatency: latencyAggregate(),
    thumbnailRequestCount: 0,
    thumbnailResourceLatency: latencyAggregate(),
    newVisibleImages: 0,
    visibleImagesNotReady: 0,
    visibleWaitLatency: latencyAggregate(),
    fallback202Count: 0,
    queueSnapshot: null,
    statusRequestCount: 0,
    statusFailureCount: 0,
    frameIntervalAnomalies: 0,
    maximumFrameIntervalMs: 0,
    renderRange: latencyAggregate(),
    virtualizerUpdate: latencyAggregate(),
  };
}

function mergeIntervals(intervals: IntervalAggregate[]): IntervalAggregate {
  const ordered = intervals.slice().sort((left, right) => left.intervalStartMs - right.intervalStartMs);
  const merged = newInterval(
    ordered[0].intervalStartMs,
    ordered[ordered.length - 1].intervalEndMs,
    true,
  );
  for (const interval of ordered) {
    merged.scrollActivity += interval.scrollActivity;
    merged.scrollDelta += interval.scrollDelta;
    merged.scrollDirectionMask |= interval.scrollDirectionMask;
    merged.maximumVisibleIndex = Math.max(merged.maximumVisibleIndex, interval.maximumVisibleIndex);
    merged.maximumMountedIndex = Math.max(merged.maximumMountedIndex, interval.maximumMountedIndex);
    merged.mountedCardsMax = Math.max(merged.mountedCardsMax, interval.mountedCardsMax);
    merged.pageRequestCount += interval.pageRequestCount;
    for (const outcome of Object.keys(merged.pageOutcomes) as DiagnosticPageOutcome[]) {
      merged.pageOutcomes[outcome] += interval.pageOutcomes[outcome];
    }
    mergeLatency(merged.pageLatency, interval.pageLatency);
    mergeLatency(merged.pageServerLatency, interval.pageServerLatency);
    merged.thumbnailRequestCount += interval.thumbnailRequestCount;
    mergeLatency(merged.thumbnailResourceLatency, interval.thumbnailResourceLatency);
    merged.newVisibleImages += interval.newVisibleImages;
    merged.visibleImagesNotReady += interval.visibleImagesNotReady;
    mergeLatency(merged.visibleWaitLatency, interval.visibleWaitLatency);
    merged.fallback202Count += interval.fallback202Count;
    if (interval.queueSnapshot) merged.queueSnapshot = interval.queueSnapshot;
    merged.statusRequestCount += interval.statusRequestCount;
    merged.statusFailureCount += interval.statusFailureCount;
    merged.frameIntervalAnomalies += interval.frameIntervalAnomalies;
    merged.maximumFrameIntervalMs = Math.max(
      merged.maximumFrameIntervalMs,
      interval.maximumFrameIntervalMs,
    );
    mergeLatency(merged.renderRange, interval.renderRange);
    mergeLatency(merged.virtualizerUpdate, interval.virtualizerUpdate);
  }
  return merged;
}

function directionLabel(mask: number): string {
  if (mask === 1) return 'down';
  if (mask === 2) return 'up';
  if (mask === 3) return 'mixed';
  return 'none';
}

function intervalSnapshot(interval: IntervalAggregate): object {
  return {
    interval_start_ms: rounded(interval.intervalStartMs),
    interval_end_ms: rounded(interval.intervalEndMs),
    resolution_ms: rounded(interval.resolutionMs),
    compacted: interval.compacted,
    scroll_activity: interval.scrollActivity,
    scroll_delta: rounded(interval.scrollDelta),
    scroll_direction: directionLabel(interval.scrollDirectionMask),
    maximum_visible_index: interval.maximumVisibleIndex,
    maximum_mounted_index: interval.maximumMountedIndex,
    mounted_cards_max: interval.mountedCardsMax,
    page_request_count: interval.pageRequestCount,
    page_outcomes: interval.pageOutcomes,
    page_latency: latencySnapshot(interval.pageLatency),
    page_server_latency: latencySnapshot(interval.pageServerLatency),
    thumbnail_request_count: interval.thumbnailRequestCount,
    thumbnail_latency: latencySnapshot(interval.thumbnailResourceLatency),
    new_visible_images: interval.newVisibleImages,
    visible_images_not_ready: interval.visibleImagesNotReady,
    visible_wait: latencySnapshot(interval.visibleWaitLatency),
    fallback_202_count: interval.fallback202Count,
    thumb_queue_snapshot: interval.queueSnapshot || 'NOT MEASURED',
    status_request_count: interval.statusRequestCount,
    status_failure_count: interval.statusFailureCount,
    frame_interval_anomalies: interval.frameIntervalAnomalies,
    maximum_frame_interval_ms: interval.maximumFrameIntervalMs
      ? rounded(interval.maximumFrameIntervalMs)
      : 'NOT MEASURED',
    render_virtual_gallery_range: latencySnapshot(interval.renderRange),
    update_virtual_gallery_count: latencySnapshot(interval.virtualizerUpdate),
  };
}

class StreamingDistribution {
  private buckets = new Array<number>(DISTRIBUTION_BOUNDS_MS.length + 1).fill(0);
  count = 0;
  total = 0;
  min = Number.POSITIVE_INFINITY;
  max = 0;

  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.total += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    const index = DISTRIBUTION_BOUNDS_MS.findIndex(bound => value <= bound);
    this.buckets[index < 0 ? this.buckets.length - 1 : index] += 1;
  }

  percentile(percentile: number): number | 'NOT MEASURED' {
    if (!this.count) return 'NOT MEASURED';
    const target = Math.max(1, Math.ceil(this.count * percentile));
    let seen = 0;
    for (let index = 0; index < this.buckets.length; index += 1) {
      seen += this.buckets[index];
      if (seen >= target) {
        return index < DISTRIBUTION_BOUNDS_MS.length
          ? DISTRIBUTION_BOUNDS_MS[index]
          : rounded(this.max);
      }
    }
    return rounded(this.max);
  }

  snapshot(): object {
    return {
      count: this.count,
      min_ms: this.count ? rounded(this.min) : 'NOT MEASURED',
      mean_ms: this.count ? rounded(this.total / this.count) : 'NOT MEASURED',
      p50_ms_approx: this.percentile(0.5),
      p95_ms_approx: this.percentile(0.95),
      max_ms: this.count ? rounded(this.max) : 'NOT MEASURED',
      method: 'fixed histogram over the complete session',
      bounds_ms: DISTRIBUTION_BOUNDS_MS,
    };
  }
}

class GalleryDiagnostics {
  private currentState: DiagnosticState = 'off';
  private generation = 0;
  private nextPageId = 0;
  private nextLifecycle = 0;
  private startedAt = 0;
  private endedAt = 0;
  private startedAtUtc = '';
  private configuration: DiagnosticConfiguration | null = null;
  private installed = false;

  private panel: HTMLElement | null = null;
  private details: HTMLElement | null = null;
  private fallbackText: HTMLTextAreaElement | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private queueAbortController: AbortController | null = null;
  private queueRequestPending = false;
  private queueRequestsStarted = 0;
  private queueRequestsFailed = 0;
  private queueRequestsSkipped = 0;
  private latestQueue: QueueSnapshot | null = null;

  private resourceObserver: PerformanceObserver | null = null;
  private resourceObserverSupport: 'SUPPORTED' | 'UNSUPPORTED' = 'UNSUPPORTED';
  private responseStatusSupport: 'SUPPORTED' | 'UNSUPPORTED' = 'UNSUPPORTED';
  private resourceSizeSupport: 'SUPPORTED' | 'UNSUPPORTED' = 'UNSUPPORTED';
  private resourceBufferFullEvents = 0;
  private observerDroppedEntries: number | 'NOT MEASURED' = 'NOT MEASURED';
  private resourceEntries = 0;
  private resourceStatusCounts: Record<string, number> = {};
  private resourceTransferBytes = 0;
  private resourceEncodedBytes = 0;
  private zeroTransferEntries = 0;

  private animationFrame = 0;
  private frameActiveUntil = 0;
  private lastFrameAt = 0;
  private previousScrollOffset: number | null = null;

  private cards = new Map<string, DiagnosticCard>();
  private activePages = new Set<DiagnosticPageTrace>();
  private intervals = new Map<number, IntervalAggregate>();
  private coarseIntervals: IntervalAggregate[] = [];
  private protectedIntervals = new Set<number>();
  private importantEvents: ImportantEvent[] = [];
  private markers: SlowdownMarker[] = [];
  private compactedDetailedIntervals = 0;
  private compactedCoarseIntervals = 0;

  private maximumVisibleIndex = -1;
  private maximumMountedIndex = -1;
  private loadedMetadataCount = 0;
  private maximumMountedCards = 0;
  private cardMounts = 0;
  private cardUnmounts = 0;
  private firstVisibleEntries = 0;
  private readyOnFirstVisibility = 0;
  private notReadyOnFirstVisibility = 0;
  private primaryStarted = 0;
  private primarySuccess = 0;
  private primaryErrors = 0;
  private fallbackAttempts = 0;
  private fallback200 = 0;
  private fallback202 = 0;
  private fallback422 = 0;
  private fallbackOther = 0;
  private fallbackNetworkErrors = 0;
  private mountLifecyclesWith202 = 0;
  private mountLifecyclesRecovered = 0;
  private mountLifecyclesFailed = 0;
  private frameGapOverThreshold = 0;

  private pageOutcomes = pageOutcomes();
  private pageRequestsByKind: Record<DiagnosticPageKind, number> = {refresh: 0, cursor: 0};
  private pageOutcomesByKind: Record<DiagnosticPageKind, Record<DiagnosticPageOutcome, number>> = {
    refresh: pageOutcomes(),
    cursor: pageOutcomes(),
  };
  private pageTotalLatency = new StreamingDistribution();
  private pageServerLatency = new StreamingDistribution();
  private pageStages: Record<PageStage, StreamingDistribution> = this.newPageStages();
  private imageLoadLatency = new StreamingDistribution();
  private visibleToLoadLatency = new StreamingDistribution();
  private resourceLatency = new StreamingDistribution();
  private fallbackHttpLatency = new StreamingDistribution();
  private frameIntervals = new StreamingDistribution();
  private renderRangeLatency = new StreamingDistribution();
  private virtualizerUpdateLatency = new StreamingDistribution();
  private statusRequestLatency = new StreamingDistribution();

  private snapshotJson: string | null = null;
  private exportMethod: 'clipboard' | 'textarea' | null = null;

  get state(): DiagnosticState {
    return this.currentState;
  }

  get recording(): boolean {
    return this.currentState === 'recording';
  }

  install(configuration: DiagnosticConfiguration): void {
    this.configuration = configuration;
    if (this.installed) return;
    this.installed = true;
    document.addEventListener('keydown', event => {
      if (
        event.code === 'KeyL'
        && event.ctrlKey
        && event.altKey
        && event.shiftKey
        && !this.isTextEntry(event.target)
      ) {
        event.preventDefault();
        this.togglePanel();
      }
    });
    window.__vilraGalleryDiagnostics = {
      open: () => this.openPanel(),
      hide: () => this.hidePanel(),
      start: () => this.startRecording(),
      stop: () => this.stopRecording(),
      mark: () => this.markSlowdown(),
      copy: () => this.copyReport(),
      state: () => this.state,
      report: () => this.reportSnapshot(),
      reportJson: () => this.snapshotJson,
      debugState: () => ({
        state: this.state,
        queueTimerActive: this.queueTimer !== null,
        queueRequestPending: this.queueRequestPending,
        refreshTimerActive: this.refreshTimer !== null,
        animationFrameActive: this.animationFrame !== 0,
        resourceObserverActive: this.resourceObserver !== null,
      }),
    };
  }

  openPanel(): void {
    this.ensurePanel();
    if (this.panel) this.panel.hidden = false;
    this.renderPanel();
  }

  hidePanel(): void {
    if (this.panel) this.panel.hidden = true;
  }

  togglePanel(): void {
    this.ensurePanel();
    if (!this.panel) return;
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) this.renderPanel();
  }

  startRecording(): void {
    this.cleanupRuntime();
    this.generation += 1;
    this.resetSession();
    this.currentState = 'recording';
    this.startedAt = performance.now();
    this.startedAtUtc = new Date().toISOString();
    this.attachResourceObserver();
    this.refreshTimer = setInterval(() => this.renderPanel(), 1_000);
    this.queueTimer = setInterval(() => { void this.sampleQueue(this.generation); }, QUEUE_SAMPLE_MS);
    this.configuration?.captureMountedCards();
    this.recordImportant('diagnostics_started');
    void this.sampleQueue(this.generation);
    this.openPanel();
  }

  stopRecording(): void {
    if (this.currentState !== 'recording') return;
    this.endedAt = performance.now();
    if (this.resourceObserver) {
      for (const entry of this.resourceObserver.takeRecords()) {
        this.onResource(entry as PerformanceResourceTiming, this.endedAt);
      }
    }
    const pendingAtStop = {
      pages: this.activePages.size,
      status_requests: this.queueRequestPending ? 1 : 0,
      mounted_cards: this.cards.size,
    };
    this.recordImportant('diagnostics_stopped');
    this.currentState = 'stopped';
    this.cleanupRuntime();
    const snapshot = this.buildSnapshot(pendingAtStop);
    this.snapshotJson = JSON.stringify(snapshot, null, 2);
    this.cards.clear();
    this.activePages.clear();
    this.renderPanel();
  }

  markSlowdown(): void {
    if (this.currentState !== 'recording' || this.markers.length >= MAX_MARKERS) return;
    const relativeTimeMs = this.relativeNow();
    const intervalStart = Math.floor(relativeTimeMs / INTERVAL_MS) * INTERVAL_MS;
    for (let offset = -3; offset <= 3; offset += 1) {
      if (intervalStart + offset * INTERVAL_MS >= 0) {
        this.protectedIntervals.add(intervalStart + offset * INTERVAL_MS);
      }
    }
    const recent = this.recentIntervals(relativeTimeMs, 2);
    const pageMax = Math.max(0, ...recent.map(interval => interval.pageLatency.maxMs));
    const thumbMax = Math.max(0, ...recent.map(interval => interval.thumbnailResourceLatency.maxMs));
    const visibleMax = Math.max(0, ...recent.map(interval => interval.visibleWaitLatency.maxMs));
    const frameMax = Math.max(0, ...recent.map(interval => interval.maximumFrameIntervalMs));
    this.markers.push({
      marker: this.markers.length + 1,
      relativeTimeMs: rounded(relativeTimeMs),
      intervalStartMs: intervalStart,
      maximumVisibleIndex: this.maximumVisibleIndex,
      loadedMetadataCount: this.loadedMetadataCount,
      scrollActivity: recent.reduce((total, interval) => total + interval.scrollActivity, 0),
      recentPageLatencyMs: pageMax || 'NOT MEASURED',
      recentThumbnailLatencyMs: thumbMax || 'NOT MEASURED',
      recentVisibleWaitMs: visibleMax || 'NOT MEASURED',
      recentMaximumFrameIntervalMs: frameMax || 'NOT MEASURED',
      latestQueueSnapshot: this.latestQueue || 'NOT MEASURED',
    });
    this.recordImportant('manual_slowdown_marker');
    this.renderPanel();
  }

  async copyReport(): Promise<void> {
    if (!this.snapshotJson || !['stopped', 'exported'].includes(this.currentState)) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(this.snapshotJson);
        copied = true;
        this.exportMethod = 'clipboard';
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      this.ensurePanel();
      if (this.fallbackText) {
        this.fallbackText.hidden = false;
        this.fallbackText.value = this.snapshotJson;
        this.fallbackText.focus();
        this.fallbackText.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
        this.exportMethod = copied ? 'clipboard' : 'textarea';
      }
    }
    this.currentState = 'exported';
    this.renderPanel(copied ? 'JSON скопирован.' : 'JSON доступен в поле для ручного копирования.');
  }

  beginPage(kind: DiagnosticPageKind, loadedMetadataCount: number): DiagnosticPageTrace | null {
    if (this.currentState !== 'recording') return null;
    const now = performance.now();
    const trace: DiagnosticPageTrace = {
      generation: this.generation,
      id: ++this.nextPageId,
      kind,
      startedAt: now,
      lastStageAt: now,
      finished: false,
      serverDurationMs: null,
      stageDurations: {},
    };
    this.pageRequestsByKind[kind] += 1;
    this.loadedMetadataCount = Math.max(this.loadedMetadataCount, loadedMetadataCount);
    this.activePages.add(trace);
    this.intervalAt(now).pageRequestCount += 1;
    return trace;
  }

  pageResponse(trace: DiagnosticPageTrace | null, response: Response): void {
    if (!this.validPage(trace)) return;
    const serverTiming = response.headers.get('server-timing') || '';
    const match = /(?:^|,)\s*api-images;dur=([0-9.]+)/.exec(serverTiming);
    if (match) trace.serverDurationMs = finiteNumber(match[1]);
    this.pageStage(trace, 'response');
  }

  pageStage(trace: DiagnosticPageTrace | null, stage: PageStage): void {
    if (!this.validPage(trace)) return;
    const now = performance.now();
    trace.stageDurations[stage] = now - trace.lastStageAt;
    trace.lastStageAt = now;
  }

  finishPage(
    trace: DiagnosticPageTrace | null,
    outcome: DiagnosticPageOutcome,
    loadedMetadataCount: number,
  ): void {
    if (!this.validPage(trace)) return;
    const now = performance.now();
    trace.finished = true;
    this.activePages.delete(trace);
    this.loadedMetadataCount = Math.max(this.loadedMetadataCount, loadedMetadataCount);
    this.pageOutcomes[outcome] += 1;
    this.pageOutcomesByKind[trace.kind][outcome] += 1;
    const interval = this.intervalAt(now);
    interval.pageOutcomes[outcome] += 1;
    const elapsed = now - trace.startedAt;
    if (outcome === 'success') {
      for (const [stage, duration] of Object.entries(trace.stageDurations)) {
        this.pageStages[stage as PageStage].add(duration);
      }
      this.pageTotalLatency.add(elapsed);
      addLatency(interval.pageLatency, elapsed);
      if (trace.serverDurationMs !== null) {
        this.pageServerLatency.add(trace.serverDurationMs);
        addLatency(interval.pageServerLatency, trace.serverDurationMs);
      }
      if (elapsed >= 180) this.recordImportant('slow_page', elapsed);
    } else {
      this.recordImportant('page_' + outcome, elapsed, outcome);
    }
  }

  measureVirtualizerUpdate(durationMs: number): void {
    if (this.currentState !== 'recording') return;
    this.virtualizerUpdateLatency.add(durationMs);
    addLatency(this.intervalAt(performance.now()).virtualizerUpdate, durationMs);
  }

  setLoadedMetadataCount(count: number): void {
    if (this.currentState === 'recording' && Number.isFinite(count)) {
      this.loadedMetadataCount = Math.max(this.loadedMetadataCount, Math.max(0, count));
    }
  }

  measureRenderRange(durationMs: number): void {
    if (this.currentState !== 'recording') return;
    this.renderRangeLatency.add(durationMs);
    addLatency(this.intervalAt(performance.now()).renderRange, durationMs);
  }

  virtualizerChanged(
    sync: boolean,
    scrollOffset: number | null,
    direction: 'forward' | 'backward' | null,
  ): void {
    if (this.currentState !== 'recording') return;
    const now = performance.now();
    if (sync) {
      const interval = this.intervalAt(now);
      interval.scrollActivity += 1;
      if (scrollOffset !== null && this.previousScrollOffset !== null) {
        interval.scrollDelta += Math.abs(scrollOffset - this.previousScrollOffset);
      }
      if (direction === 'forward') interval.scrollDirectionMask |= 1;
      else if (direction === 'backward') interval.scrollDirectionMask |= 2;
      this.previousScrollOffset = scrollOffset;
      this.frameActiveUntil = now + 300;
      this.ensureFrameLoop();
    } else {
      this.frameActiveUntil = Math.max(this.frameActiveUntil, now + 120);
    }
  }

  virtualRange(maximumMountedIndex: number, maximumVisibleIndex: number, mountedCards: number): void {
    if (this.currentState !== 'recording') return;
    this.maximumMountedIndex = Math.max(this.maximumMountedIndex, maximumMountedIndex);
    this.maximumVisibleIndex = Math.max(this.maximumVisibleIndex, maximumVisibleIndex);
    this.maximumMountedCards = Math.max(this.maximumMountedCards, mountedCards);
    const interval = this.intervalAt(performance.now());
    interval.maximumMountedIndex = Math.max(interval.maximumMountedIndex, maximumMountedIndex);
    interval.maximumVisibleIndex = Math.max(interval.maximumVisibleIndex, maximumVisibleIndex);
    interval.mountedCardsMax = Math.max(interval.mountedCardsMax, mountedCards);
  }

  cardMounted(key: string, index: number, alreadyReady = false): DiagnosticCardRef | null {
    if (this.currentState !== 'recording') return null;
    const existing = this.cards.get(key);
    if (existing) this.cards.delete(key);
    const ref = {generation: this.generation, lifecycle: ++this.nextLifecycle, key};
    const now = performance.now();
    this.cards.set(key, {
      ref,
      mountedAt: now,
      primaryStartedAt: null,
      firstVisibleAt: null,
      loadedAt: alreadyReady ? now : null,
      index,
      had202: false,
      recovered: false,
      failed: false,
    });
    this.cardMounts += 1;
    return ref;
  }

  cardVisible(ref: DiagnosticCardRef | null, index: number, ready: boolean): void {
    const card = this.cardFor(ref);
    if (!card || card.firstVisibleAt !== null) return;
    const now = performance.now();
    card.firstVisibleAt = now;
    card.index = index;
    this.maximumVisibleIndex = Math.max(this.maximumVisibleIndex, index);
    this.firstVisibleEntries += 1;
    const isReady = ready || card.loadedAt !== null;
    if (isReady) this.readyOnFirstVisibility += 1;
    else this.notReadyOnFirstVisibility += 1;
    const interval = this.intervalAt(now);
    interval.newVisibleImages += 1;
    if (!isReady) interval.visibleImagesNotReady += 1;
  }

  cardUnmounted(ref: DiagnosticCardRef | null): void {
    const card = this.cardFor(ref);
    if (!card) return;
    this.cards.delete(card.ref.key);
    this.cardUnmounts += 1;
  }

  primaryRequestStarted(ref: DiagnosticCardRef | null): void {
    const card = this.cardFor(ref);
    if (!card) return;
    card.primaryStartedAt = performance.now();
    this.primaryStarted += 1;
    this.intervalAt(card.primaryStartedAt).thumbnailRequestCount += 1;
  }

  primaryLoaded(ref: DiagnosticCardRef | null, valid: boolean): void {
    const card = this.cardFor(ref);
    if (!card || !valid) return;
    this.primarySuccess += 1;
    this.completeImageLoad(card, card.primaryStartedAt);
  }

  primaryFailed(ref: DiagnosticCardRef | null): void {
    const card = this.cardFor(ref);
    if (!card) return;
    this.primaryErrors += 1;
    this.recordImportant('primary_image_error');
  }

  fallbackAttemptStarted(ref: DiagnosticCardRef | null): number | null {
    const card = this.cardFor(ref);
    if (!card) return null;
    this.fallbackAttempts += 1;
    const now = performance.now();
    this.intervalAt(now).thumbnailRequestCount += 1;
    return now;
  }

  fallbackResponse(ref: DiagnosticCardRef | null, status: number, startedAt: number | null): void {
    const card = this.cardFor(ref);
    if (!card) return;
    const now = performance.now();
    if (startedAt !== null) this.fallbackHttpLatency.add(now - startedAt);
    if (status === 200) this.fallback200 += 1;
    else if (status === 202) {
      this.fallback202 += 1;
      this.intervalAt(now).fallback202Count += 1;
      if (!card.had202) {
        card.had202 = true;
        this.mountLifecyclesWith202 += 1;
      }
    } else if (status === 422) {
      this.fallback422 += 1;
      this.failLifecycle(card);
    } else {
      this.fallbackOther += 1;
      this.failLifecycle(card);
      this.recordImportant('fallback_http_other', undefined, String(status));
    }
  }

  fallbackNetworkError(ref: DiagnosticCardRef | null): void {
    const card = this.cardFor(ref);
    if (!card) return;
    this.fallbackNetworkErrors += 1;
    this.failLifecycle(card);
    this.recordImportant('fallback_network_error');
  }

  fallbackImageLoaded(ref: DiagnosticCardRef | null, valid: boolean): void {
    const card = this.cardFor(ref);
    if (!card || !valid) return;
    if (card.had202 && !card.recovered) {
      card.recovered = true;
      this.mountLifecyclesRecovered += 1;
    }
    this.completeImageLoad(card, null);
  }

  fallbackImageFailed(ref: DiagnosticCardRef | null): void {
    const card = this.cardFor(ref);
    if (card) this.failLifecycle(card);
  }

  reportSnapshot(): object | null {
    return this.snapshotJson ? JSON.parse(this.snapshotJson) as object : null;
  }

  private newPageStages(): Record<PageStage, StreamingDistribution> {
    return {
      response: new StreamingDistribution(),
      json: new StreamingDistribution(),
      mapped: new StreamingDistribution(),
      deduped: new StreamingDistribution(),
      arrays: new StreamingDistribution(),
      pre_virtualizer_wait: new StreamingDistribution(),
      virtualizer: new StreamingDistribution(),
    };
  }

  private resetSession(): void {
    this.endedAt = 0;
    this.startedAtUtc = '';
    this.nextPageId = 0;
    this.nextLifecycle = 0;
    this.queueRequestPending = false;
    this.queueRequestsStarted = 0;
    this.queueRequestsFailed = 0;
    this.queueRequestsSkipped = 0;
    this.latestQueue = null;
    this.resourceObserverSupport = 'UNSUPPORTED';
    this.responseStatusSupport = 'UNSUPPORTED';
    this.resourceSizeSupport = 'UNSUPPORTED';
    this.resourceBufferFullEvents = 0;
    this.observerDroppedEntries = 'NOT MEASURED';
    this.resourceEntries = 0;
    this.resourceStatusCounts = {};
    this.resourceTransferBytes = 0;
    this.resourceEncodedBytes = 0;
    this.zeroTransferEntries = 0;
    this.animationFrame = 0;
    this.frameActiveUntil = 0;
    this.lastFrameAt = 0;
    this.previousScrollOffset = null;
    this.cards.clear();
    this.activePages.clear();
    this.intervals.clear();
    this.coarseIntervals = [];
    this.protectedIntervals.clear();
    this.importantEvents = [];
    this.markers = [];
    this.compactedDetailedIntervals = 0;
    this.compactedCoarseIntervals = 0;
    this.maximumVisibleIndex = -1;
    this.maximumMountedIndex = -1;
    this.loadedMetadataCount = 0;
    this.maximumMountedCards = 0;
    this.cardMounts = 0;
    this.cardUnmounts = 0;
    this.firstVisibleEntries = 0;
    this.readyOnFirstVisibility = 0;
    this.notReadyOnFirstVisibility = 0;
    this.primaryStarted = 0;
    this.primarySuccess = 0;
    this.primaryErrors = 0;
    this.fallbackAttempts = 0;
    this.fallback200 = 0;
    this.fallback202 = 0;
    this.fallback422 = 0;
    this.fallbackOther = 0;
    this.fallbackNetworkErrors = 0;
    this.mountLifecyclesWith202 = 0;
    this.mountLifecyclesRecovered = 0;
    this.mountLifecyclesFailed = 0;
    this.frameGapOverThreshold = 0;
    this.pageOutcomes = pageOutcomes();
    this.pageRequestsByKind = {refresh: 0, cursor: 0};
    this.pageOutcomesByKind = {refresh: pageOutcomes(), cursor: pageOutcomes()};
    this.pageTotalLatency = new StreamingDistribution();
    this.pageServerLatency = new StreamingDistribution();
    this.pageStages = this.newPageStages();
    this.imageLoadLatency = new StreamingDistribution();
    this.visibleToLoadLatency = new StreamingDistribution();
    this.resourceLatency = new StreamingDistribution();
    this.fallbackHttpLatency = new StreamingDistribution();
    this.frameIntervals = new StreamingDistribution();
    this.renderRangeLatency = new StreamingDistribution();
    this.virtualizerUpdateLatency = new StreamingDistribution();
    this.statusRequestLatency = new StreamingDistribution();
    this.snapshotJson = null;
    this.exportMethod = null;
    if (this.fallbackText) {
      this.fallbackText.hidden = true;
      this.fallbackText.value = '';
    }
  }

  private relativeNow(now = performance.now()): number {
    return Math.max(0, now - this.startedAt);
  }

  private intervalAt(now: number): IntervalAggregate {
    const relative = this.relativeNow(now);
    const start = Math.floor(relative / INTERVAL_MS) * INTERVAL_MS;
    let interval = this.intervals.get(start);
    if (!interval) {
      interval = newInterval(start);
      this.intervals.set(start, interval);
      this.compactIntervals();
    }
    return interval;
  }

  private recentIntervals(relativeTimeMs: number, count: number): IntervalAggregate[] {
    const currentStart = Math.floor(relativeTimeMs / INTERVAL_MS) * INTERVAL_MS;
    const result: IntervalAggregate[] = [];
    for (let index = count - 1; index >= 0; index -= 1) {
      const interval = this.intervals.get(currentStart - index * INTERVAL_MS);
      if (interval) result.push(interval);
    }
    return result;
  }

  private compactIntervals(): void {
    while (this.intervals.size > MAX_DETAILED_INTERVALS + this.protectedIntervals.size) {
      const candidates = [...this.intervals.keys()]
        .sort((left, right) => left - right)
        .filter(start => !this.protectedIntervals.has(start))
        .slice(0, 5);
      if (candidates.length < 2) break;
      const merged = mergeIntervals(candidates.map(start => this.intervals.get(start)!));
      candidates.forEach(start => this.intervals.delete(start));
      this.coarseIntervals.push(merged);
      this.compactedDetailedIntervals += candidates.length;
    }
    while (this.coarseIntervals.length > MAX_COARSE_INTERVALS) {
      const group = this.coarseIntervals.splice(0, 5);
      this.coarseIntervals.unshift(mergeIntervals(group));
      this.compactedCoarseIntervals += group.length;
    }
  }

  private validPage(trace: DiagnosticPageTrace | null): trace is DiagnosticPageTrace {
    return Boolean(
      trace
      && this.currentState === 'recording'
      && trace.generation === this.generation
      && !trace.finished
      && this.activePages.has(trace),
    );
  }

  private cardFor(ref: DiagnosticCardRef | null): DiagnosticCard | null {
    if (!ref || this.currentState !== 'recording' || ref.generation !== this.generation) return null;
    const card = this.cards.get(ref.key);
    return card?.ref.lifecycle === ref.lifecycle ? card : null;
  }

  private completeImageLoad(card: DiagnosticCard, requestStartedAt: number | null): void {
    if (card.loadedAt !== null) return;
    const now = performance.now();
    card.loadedAt = now;
    if (requestStartedAt !== null) this.imageLoadLatency.add(now - requestStartedAt);
    if (card.firstVisibleAt !== null && card.firstVisibleAt <= now) {
      const wait = now - card.firstVisibleAt;
      this.visibleToLoadLatency.add(wait);
      addLatency(this.intervalAt(now).visibleWaitLatency, wait);
      if (wait >= 150) this.recordImportant('visible_image_wait', wait);
    }
  }

  private failLifecycle(card: DiagnosticCard): void {
    if (card.failed || card.loadedAt !== null) return;
    card.failed = true;
    this.mountLifecyclesFailed += 1;
  }

  private ensureFrameLoop(): void {
    if (this.animationFrame || this.currentState !== 'recording') return;
    this.lastFrameAt = 0;
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.animationFrame = 0;
    if (this.currentState !== 'recording' || now > this.frameActiveUntil) {
      this.lastFrameAt = 0;
      return;
    }
    const active = document.visibilityState === 'visible'
      && (this.configuration?.isGalleryActive() ?? false);
    if (active) {
      if (this.lastFrameAt) {
        const gap = now - this.lastFrameAt;
        this.frameIntervals.add(gap);
        if (gap >= FRAME_ANOMALY_MS) {
          this.frameGapOverThreshold += 1;
          const interval = this.intervalAt(now);
          interval.frameIntervalAnomalies += 1;
          interval.maximumFrameIntervalMs = Math.max(interval.maximumFrameIntervalMs, gap);
          if (gap >= 100) this.recordImportant('long_frame_interval_proxy', gap);
        }
      }
      this.lastFrameAt = now;
    } else {
      this.lastFrameAt = 0;
    }
    this.animationFrame = requestAnimationFrame(this.frame);
  };

  private attachResourceObserver(): void {
    const supported = typeof PerformanceObserver !== 'undefined'
      && Array.isArray(PerformanceObserver.supportedEntryTypes)
      && PerformanceObserver.supportedEntryTypes.includes('resource');
    if (!supported) {
      this.resourceObserverSupport = 'UNSUPPORTED';
      return;
    }
    try {
      this.resourceObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) this.onResource(entry as PerformanceResourceTiming);
      });
      this.resourceObserver.observe({type: 'resource'});
      performance.addEventListener('resourcetimingbufferfull', this.onResourceBufferFull);
      this.resourceObserverSupport = 'SUPPORTED';
    } catch {
      this.resourceObserver = null;
      this.resourceObserverSupport = 'UNSUPPORTED';
    }
  }

  private onResourceBufferFull = (): void => {
    if (this.currentState === 'recording') this.resourceBufferFullEvents += 1;
  };

  private onResource(entry: PerformanceResourceTiming, sessionEnd = Number.POSITIVE_INFINITY): void {
    if (this.currentState !== 'recording') return;
    const relativeStart = entry.startTime - this.startedAt;
    if (relativeStart < 0 || entry.startTime > sessionEnd) return;
    let pathname = '';
    try {
      const url = new URL(entry.name);
      if (url.protocol === 'blob:') return;
      pathname = url.pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith('/thumb-file/') && !pathname.startsWith('/thumb/')) return;
    const duration = Math.max(0, entry.duration);
    this.resourceEntries += 1;
    this.resourceLatency.add(duration);
    addLatency(this.intervalAt(this.startedAt + relativeStart).thumbnailResourceLatency, duration);
    const resource = entry as PerformanceResourceTiming & {responseStatus?: number};
    if ('responseStatus' in resource) {
      this.responseStatusSupport = 'SUPPORTED';
      const status = finiteNumber(resource.responseStatus);
      if (status !== null && status > 0) {
        const key = String(status);
        this.resourceStatusCounts[key] = (this.resourceStatusCounts[key] || 0) + 1;
      }
    }
    if ('transferSize' in entry && 'encodedBodySize' in entry) {
      this.resourceSizeSupport = 'SUPPORTED';
      const transfer = finiteNumber(entry.transferSize);
      const encoded = finiteNumber(entry.encodedBodySize);
      if (transfer !== null) {
        this.resourceTransferBytes += transfer;
        if (transfer === 0) this.zeroTransferEntries += 1;
      }
      if (encoded !== null) this.resourceEncodedBytes += encoded;
    }
    if (duration >= 250) this.recordImportant('slow_thumbnail_resource', duration);
  }

  private async sampleQueue(generation: number): Promise<void> {
    if (this.currentState !== 'recording' || generation !== this.generation) return;
    if (this.queueRequestPending) {
      this.queueRequestsSkipped += 1;
      return;
    }
    this.queueRequestPending = true;
    const controller = new AbortController();
    this.queueAbortController = controller;
    this.queueRequestsStarted += 1;
    const startedAt = performance.now();
    this.intervalAt(startedAt).statusRequestCount += 1;
    try {
      const response = await fetch('/api/status', {
        cache: 'no-store',
        headers: {'X-Vilra-Diagnostics': 'long-scroll'},
        signal: controller.signal,
      });
      const value: unknown = response.ok ? await response.json() : null;
      if (this.currentState !== 'recording' || generation !== this.generation) return;
      const duration = performance.now() - startedAt;
      this.statusRequestLatency.add(duration);
      if (!response.ok || typeof value !== 'object' || value === null) {
        this.queueRequestsFailed += 1;
        this.intervalAt(performance.now()).statusFailureCount += 1;
        this.recordImportant('status_sample_failed', duration, String(response.status));
        return;
      }
      const queues = (value as {queues?: Record<string, unknown>}).queues || {};
      const queued = finiteNumber(queues.thumb_queue_depth);
      const running = finiteNumber(queues.thumb_running);
      const stale = finiteNumber(queues.thumb_stale_running);
      const metadata = finiteNumber(queues.metadata_running);
      const snapshot: QueueSnapshot = {
        relativeMs: rounded(this.relativeNow()),
        thumbQueueDepth: queued ?? 'NOT MEASURED',
        thumbRunning: running ?? 'NOT MEASURED',
        thumbStaleRunning: stale ?? 'NOT MEASURED',
        metadataRunning: metadata ?? 'NOT MEASURED',
        requestDurationMs: rounded(duration),
      };
      this.latestQueue = snapshot;
      this.intervalAt(performance.now()).queueSnapshot = snapshot;
    } catch {
      if (this.currentState === 'recording' && generation === this.generation) {
        this.queueRequestsFailed += 1;
        this.intervalAt(performance.now()).statusFailureCount += 1;
        this.recordImportant('status_sample_failed');
      }
    } finally {
      if (this.queueAbortController === controller) this.queueAbortController = null;
      if (generation === this.generation) this.queueRequestPending = false;
    }
  }

  private recordImportant(type: string, durationMs?: number, outcome?: string): void {
    if (this.currentState !== 'recording') return;
    const event: ImportantEvent = {
      relativeMs: rounded(this.relativeNow()),
      type,
      maximumVisibleIndex: this.maximumVisibleIndex,
      ...(durationMs === undefined ? {} : {durationMs: rounded(durationMs)}),
      ...(outcome === undefined ? {} : {outcome}),
    };
    if (this.importantEvents.length >= MAX_IMPORTANT_EVENTS) this.importantEvents.shift();
    this.importantEvents.push(event);
  }

  private buildSnapshot(pendingAtStop: object): object {
    const intervals = [...this.coarseIntervals, ...this.intervals.values()]
      .sort((left, right) => left.intervalStartMs - right.intervalStartMs)
      .map(intervalSnapshot);
    const durationMs = Math.max(0, this.endedAt - this.startedAt);
    const resourceCoverage = this.resourceObserverSupport === 'UNSUPPORTED'
      ? 'UNSUPPORTED'
      : 'PARTIAL';
    return {
      schema_version: 1,
      description: 'Vilra opt-in long-scroll diagnostics; no paths, names, IDs, tags or request URLs',
      session: {
        generation: this.generation,
        state: 'stopped',
        started_at_utc: this.startedAtUtc,
        duration_ms: rounded(durationMs),
        interval_target_ms: INTERVAL_MS,
        viewport: {width: window.innerWidth, height: window.innerHeight},
        runtime: isTauriRuntime() ? 'Tauri/WebKitGTK' : 'browser',
      },
      depth: {
        loaded_metadata_count: this.loadedMetadataCount,
        maximum_mounted_index: this.maximumMountedIndex,
        maximum_visible_index: this.maximumVisibleIndex,
        maximum_mounted_cards: this.maximumMountedCards,
      },
      pagination: {
        requests_by_kind: this.pageRequestsByKind,
        outcomes: this.pageOutcomes,
        outcomes_by_kind: this.pageOutcomesByKind,
        end_to_end: this.pageTotalLatency.snapshot(),
        server_timing_api_images: this.pageServerLatency.snapshot(),
        stages: Object.fromEntries(
          Object.entries(this.pageStages).map(([stage, distribution]) => [stage, distribution.snapshot()]),
        ),
      },
      thumbnails: {
        card_mounts: this.cardMounts,
        card_unmounts: this.cardUnmounts,
        first_visible_entries: this.firstVisibleEntries,
        ready_on_first_visibility: this.readyOnFirstVisibility,
        not_ready_on_first_visibility: this.notReadyOnFirstVisibility,
        primary_request_started: this.primaryStarted,
        primary_load_success: this.primarySuccess,
        primary_load_error: this.primaryErrors,
        fallback_http_200: this.fallback200,
        fallback_http_202: this.fallback202,
        fallback_http_422: this.fallback422,
        fallback_other: this.fallbackOther,
        fallback_network_errors: this.fallbackNetworkErrors,
        fallback_attempts: this.fallbackAttempts,
        mount_lifecycles_with_202: this.mountLifecyclesWith202,
        mount_lifecycles_recovered: this.mountLifecyclesRecovered,
        mount_lifecycles_failed: this.mountLifecyclesFailed,
        pending_mount_lifecycles: this.cards.size,
        image_load_latency: this.imageLoadLatency.snapshot(),
        visible_to_load_latency: this.visibleToLoadLatency.snapshot(),
        fallback_http_latency: this.fallbackHttpLatency.snapshot(),
      },
      resources: {
        observer_support: this.resourceObserverSupport,
        coverage: resourceCoverage,
        observed_entries: this.resourceEntries,
        duration: this.resourceLatency.snapshot(),
        response_status_support: this.responseStatusSupport,
        response_status_counts: this.responseStatusSupport === 'SUPPORTED'
          ? this.resourceStatusCounts
          : 'UNSUPPORTED',
        size_fields_support: this.resourceSizeSupport,
        observed_transfer_size_bytes: this.resourceSizeSupport === 'SUPPORTED'
          ? this.resourceTransferBytes
          : 'UNSUPPORTED',
        observed_encoded_body_size_bytes: this.resourceSizeSupport === 'SUPPORTED'
          ? this.resourceEncodedBytes
          : 'UNSUPPORTED',
        zero_transfer_entries: this.resourceSizeSupport === 'SUPPORTED'
          ? this.zeroTransferEntries
          : 'UNSUPPORTED',
        resource_timing_buffer_full_events: this.resourceBufferFullEvents,
        observer_reported_dropped_entries: this.observerDroppedEntries,
        caveat: 'Zero transfer size does not prove a cache hit; HTTP completion is not decode or paint.',
      },
      frame_intervals: {
        active_scroll_only: true,
        proxy_not_paint_timing: true,
        distribution: this.frameIntervals.snapshot(),
        intervals_over_50_ms: this.frameGapOverThreshold,
      },
      rendering: {
        render_virtual_gallery_range: this.renderRangeLatency.snapshot(),
        update_virtual_gallery_count: this.virtualizerUpdateLatency.snapshot(),
      },
      queue_sampling: {
        interval_ms: QUEUE_SAMPLE_MS,
        requests_started: this.queueRequestsStarted,
        requests_failed: this.queueRequestsFailed,
        overlapping_samples_skipped: this.queueRequestsSkipped,
        request_latency: this.statusRequestLatency.snapshot(),
        latest_snapshot: this.latestQueue || 'NOT MEASURED',
      },
      manual_slowdown_markers: this.markers,
      intervals,
      important_event_tail: this.importantEvents,
      retention: {
        detailed_interval_limit: MAX_DETAILED_INTERVALS,
        coarse_interval_limit: MAX_COARSE_INTERVALS,
        detailed_intervals_compacted: this.compactedDetailedIntervals,
        coarse_intervals_compacted: this.compactedCoarseIntervals,
        marker_windows_protected: true,
        important_event_tail_limit: MAX_IMPORTANT_EVENTS,
        distribution_scope: 'complete session histogram, not a last-N sample',
      },
      pending_at_stop: pendingAtStop,
      limitations: [
        'Image load is not a physical paint timestamp.',
        'Frame intervals are a main-loop proxy and do not identify JavaScript, layout or compositor work.',
        'PSS, CPU and physical disk reads are not measured.',
        'Resource Timing field availability depends on the production WebKitGTK build.',
        'Queue samples are sparse read-only status observations.',
      ],
    };
  }

  private cleanupRuntime(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    if (this.queueTimer !== null) clearInterval(this.queueTimer);
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.queueAbortController?.abort();
    this.queueAbortController = null;
    this.queueRequestPending = false;
    this.refreshTimer = null;
    this.queueTimer = null;
    this.animationFrame = 0;
    this.lastFrameAt = 0;
    if (this.resourceObserver) {
      this.resourceObserver.disconnect();
      this.resourceObserver = null;
    }
    performance.removeEventListener('resourcetimingbufferfull', this.onResourceBufferFull);
  }

  private ensurePanel(): void {
    if (this.panel?.isConnected) return;
    const panel = document.createElement('aside');
    panel.id = 'gallery-diagnostics-panel';
    panel.className = 'gallery-diagnostics-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Диагностика длительной прокрутки');

    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'Диагностика прокрутки';
    const hide = this.button('×', 'Скрыть панель', () => this.hidePanel());
    hide.classList.add('gallery-diagnostics-hide');
    header.append(title, hide);

    this.details = document.createElement('pre');
    this.details.id = 'gallery-diagnostics-details';

    const controls = document.createElement('div');
    controls.className = 'gallery-diagnostics-controls';
    controls.append(
      this.button('Начать новую запись', 'Начать новую запись', () => this.startRecording(), 'diagnostics-start'),
      this.button('Сейчас тормозит', 'Отметить замедление', () => this.markSlowdown(), 'diagnostics-mark'),
      this.button('Остановить', 'Остановить запись', () => this.stopRecording(), 'diagnostics-stop'),
      this.button('Копировать JSON', 'Копировать JSON', () => { void this.copyReport(); }, 'diagnostics-copy'),
    );

    this.fallbackText = document.createElement('textarea');
    this.fallbackText.id = 'gallery-diagnostics-json';
    this.fallbackText.readOnly = true;
    this.fallbackText.hidden = true;
    this.fallbackText.setAttribute('aria-label', 'JSON диагностики');
    panel.append(header, this.details, controls, this.fallbackText);
    document.body.appendChild(panel);
    this.panel = panel;
  }

  private button(text: string, title: string, action: () => void, id?: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    if (id) button.id = id;
    button.addEventListener('click', action);
    return button;
  }

  private renderPanel(notice = ''): void {
    if (!this.details) return;
    const currentInterval = this.currentState === 'recording'
      ? this.intervalAt(performance.now())
      : null;
    const queue = this.latestQueue?.thumbQueueDepth ?? 'нет данных';
    const readyPercent = this.firstVisibleEntries
      ? rounded(100 * this.readyOnFirstVisibility / this.firstVisibleEntries) + '%'
      : 'нет данных';
    this.details.textContent = [
      `Состояние: ${this.currentState.toUpperCase()}`,
      `Видимая глубина: ${Math.max(0, this.maximumVisibleIndex + 1)} · метаданных: ${this.loadedMetadataCount}`,
      `Готовы при входе: ${readyPercent} (${this.firstVisibleEntries})`,
      `Страницы p95: ${String(this.pageTotalLatency.percentile(0.95))} мс`,
      `Visible-to-load p95: ${String(this.visibleToLoadLatency.percentile(0.95))} мс`,
      `Frame proxy p95: ${String(this.frameIntervals.percentile(0.95))} мс`,
      `Fallback 202: ${this.fallback202} · lifecycle: ${this.mountLifecyclesWith202}`,
      `Очередь thumbnails: ${String(queue)}`,
      `Отметки: ${this.markers.length} · интервал scroll: ${currentInterval?.scrollActivity ?? 0}`,
      notice,
    ].filter(Boolean).join('\n');
    const start = document.getElementById('diagnostics-start') as HTMLButtonElement | null;
    const mark = document.getElementById('diagnostics-mark') as HTMLButtonElement | null;
    const stop = document.getElementById('diagnostics-stop') as HTMLButtonElement | null;
    const copy = document.getElementById('diagnostics-copy') as HTMLButtonElement | null;
    if (start) start.disabled = this.currentState === 'recording';
    if (mark) mark.disabled = this.currentState !== 'recording';
    if (stop) stop.disabled = this.currentState !== 'recording';
    if (copy) copy.disabled = !this.snapshotJson;
  }

  private isTextEntry(target: EventTarget | null): boolean {
    return target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  }
}

function isTauriRuntime(): boolean {
  return Boolean((window as Window & {__TAURI_INTERNALS__?: unknown}).__TAURI_INTERNALS__);
}

declare global {
  interface Window {
    __vilraGalleryDiagnostics?: {
      open: () => void;
      hide: () => void;
      start: () => void;
      stop: () => void;
      mark: () => void;
      copy: () => Promise<void>;
      state: () => DiagnosticState;
      report: () => object | null;
      reportJson: () => string | null;
      debugState: () => object;
    };
  }
}

export const galleryDiagnostics = new GalleryDiagnostics();
