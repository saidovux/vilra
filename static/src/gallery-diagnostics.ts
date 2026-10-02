/**
 * Opt-in, memory-bounded diagnostics for real Tauri/WebKitGTK long scrolling.
 * Toggle with Ctrl+Alt+Shift+L. No file paths, tags or image IDs are exported.
 * Not a scheduler or cache; disabled by default.
 */
type DiagnosticCard = {
  mountedAt: number;
  firstVisibleAt: number | null;
  loadedAt: number | null;
  index: number;
};
type DiagnosticEvent = {
  sec: number;
  event: string;
  depth: number;
  ms?: number;
  queue?: number;
};
type QueueSnapshot = {sec: number; queued: number; running: number; stale: number};

const KEEP_SAMPLES = 300;
function keep<T>(array: T[], value: T): void {
  if (array.length === KEEP_SAMPLES) array.shift();
  array.push(value);
}
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const ordered = values.slice().sort((a, b) => a - b);
  return Math.round(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)] * 10) / 10;
}

class GalleryDiagnostics {
  enabled = false;
  private since = 0;
  private panel: HTMLElement | null = null;
  private details: HTMLElement | null = null;
  private resourceObserver: PerformanceObserver | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private animationFrame = 0;
  private lastFrameAt = 0;
  private cards = new Map<string, DiagnosticCard>();
  private events: DiagnosticEvent[] = [];
  private queues: QueueSnapshot[] = [];
  private pageDurations: number[] = [];
  private serverPageDurations: number[] = [];
  private presentationWaits: number[] = [];
  private mountLoadDurations: number[] = [];
  private resourceDurations: number[] = [];
  private frameGaps: number[] = [];
  private pageCount = 0;
  private pagesFailed = 0;
  private depth = 0;
  private mounts = 0;
  private entered = 0;
  private readyAtEntry = 0;
  private unloadedAtEntry = 0;
  private loaded = 0;
  private primaryErrors = 0;
  private fallback200 = 0;
  private fallback202 = 0;
  private fallback422 = 0;
  private fallbackOther = 0;
  private resourceRequests = 0;
  private resourceStatuses: Record<string, number> = {};
  private totalTransferred = 0;
  private resourceBytesSupported = false;
  private resourceTimingSupported = false;
  private frameGapOver50 = 0;
  private maxQueueDepth = 0;

  toggle(): void {
    if (this.enabled) {
      this.stop();
      return;
    }
    this.start();
  }

  private event(event: string, ms?: number, queue?: number): void {
    if (!this.enabled) return;
    keep(this.events, {
      sec: Math.round((performance.now() - this.since) / 100) / 10,
      event,
      depth: this.depth,
      ...(ms === undefined ? {} : {ms: Math.round(ms * 10) / 10}),
      ...(queue === undefined ? {} : {queue}),
    });
  }

  mount(id: string, index: number): void {
    if (!this.enabled) return;
    this.mounts += 1;
    this.depth = Math.max(this.depth, index + 1);
    this.cards.set(id, {mountedAt: performance.now(), firstVisibleAt: null, loadedAt: null, index});
  }

  visible(id: string, index: number, loaded: boolean): void {
    if (!this.enabled) return;
    const card = this.cards.get(id);
    if (!card || card.firstVisibleAt !== null) return;
    card.firstVisibleAt = performance.now();
    card.index = index;
    this.depth = Math.max(this.depth, index + 1);
    this.entered += 1;
    if (loaded || card.loadedAt !== null) this.readyAtEntry += 1;
    else this.unloadedAtEntry += 1;
  }

  loadedImage(id: string): void {
    if (!this.enabled) return;
    const card = this.cards.get(id);
    if (!card || card.loadedAt !== null) return;
    const now = performance.now();
    card.loadedAt = now;
    this.loaded += 1;
    keep(this.mountLoadDurations, now - card.mountedAt);
    if (card.firstVisibleAt !== null && card.firstVisibleAt <= now) {
      const wait = now - card.firstVisibleAt;
      keep(this.presentationWaits, wait);
      if (wait >= 150) this.event('visible-image-wait', wait);
    }
  }

  unmount(id: string): void {
    if (!this.enabled) return;
    this.cards.delete(id);
  }

  primaryFailed(): void {
    if (!this.enabled) return;
    this.primaryErrors += 1;
    this.event('primary-image-error');
  }

  fallback(status: number): void {
    if (!this.enabled) return;
    if (status === 200) this.fallback200 += 1;
    else if (status === 202) this.fallback202 += 1;
    else if (status === 422) this.fallback422 += 1;
    else this.fallbackOther += 1;
    if (status !== 202 && status !== 200) this.event('fallback-http-' + status);
  }

  page(elapsed: number, serverTiming: string | null, depth: number): void {
    if (!this.enabled) return;
    this.pageCount += 1;
    this.depth = Math.max(this.depth, depth);
    keep(this.pageDurations, elapsed);
    const match = /api-images;dur=([0-9.]+)/.exec(serverTiming || '');
    if (match) keep(this.serverPageDurations, Number(match[1]));
    if (elapsed >= 180) this.event('slow-page', elapsed);
  }

  pageFailed(): void {
    if (!this.enabled) return;
    this.pagesFailed += 1;
    this.event('page-failed');
  }

  private onResource(entry: PerformanceResourceTiming): void {
    if (!this.enabled) return;
    let name: string;
    try { name = new URL(entry.name).pathname; }
    catch { return; }
    if (!name.startsWith('/thumb-file/') && !name.startsWith('/thumb/')) return;
    this.resourceRequests += 1;
    keep(this.resourceDurations, entry.duration);
    if ('responseStatus' in entry) {
      const status = Number((entry as PerformanceResourceTiming & {responseStatus?: number}).responseStatus || 0);
      if (status) this.resourceStatuses[String(status)] = (this.resourceStatuses[String(status)] || 0) + 1;
    }
    if (Number.isFinite(entry.transferSize)) {
      this.resourceBytesSupported = true;
      this.totalTransferred += entry.transferSize;
    }
    if (entry.duration >= 250) this.event('slow-thumb-resource', entry.duration);
  }

  private frame = (now: number): void => {
    if (!this.enabled) return;
    if (this.lastFrameAt) {
      const gap = now - this.lastFrameAt;
      keep(this.frameGaps, gap);
      if (gap >= 50) {
        this.frameGapOver50 += 1;
        if (gap >= 100) this.event('long-frame-gap', gap);
      }
    }
    this.lastFrameAt = now;
    this.animationFrame = requestAnimationFrame(this.frame);
  };

  private async sampleQueue(): Promise<void> {
    try {
      const response = await fetch('/api/status', {cache: 'no-store'});
      if (!this.enabled || !response.ok) return;
      const data = await response.json() as {
        queues?: {thumb_queue_depth?: number; thumb_running?: number; thumb_stale_running?: number};
      };
      const queued = Number(data.queues?.thumb_queue_depth || 0);
      const running = Number(data.queues?.thumb_running || 0);
      const stale = Number(data.queues?.thumb_stale_running || 0);
      if (Number.isFinite(queued) && Number.isFinite(running) && Number.isFinite(stale)) {
        this.maxQueueDepth = Math.max(this.maxQueueDepth, queued);
        keep(this.queues, {
          sec: Math.round((performance.now() - this.since) / 100) / 10,
          queued, running, stale,
        });
        if (queued > 0 && (!this.queues.length || this.queues.length % 5 === 0)) {
          this.event('thumb-queue', undefined, queued);
        }
      }
    } catch {
      if (this.enabled) this.event('status-sample-failed');
    }
  }

  private report(): object {
    return {
      description: 'Vilra opt-in long-scroll diagnosis; no file paths, tags or image IDs',
      startedAt: this.startedAt,
      durationSeconds: Math.round((performance.now() - this.since) / 100) / 10,
      userAgent: navigator.userAgent,
      maximumImageIndexReached: this.depth,
      mountedNow: this.cards.size,
      cardMounts: this.mounts,
      firstVisibleEntries: this.entered,
      readyOnFirstVisibility: this.readyAtEntry,
      notReadyOnFirstVisibility: this.unloadedAtEntry,
      imagesLoadedDuringTrace: this.loaded,
      primaryImageErrors: this.primaryErrors,
      fallback: {http200: this.fallback200, http202: this.fallback202, http422: this.fallback422, other: this.fallbackOther},
      pages: {count: this.pageCount, failed: this.pagesFailed, p50ms: percentile(this.pageDurations, .5), p95ms: percentile(this.pageDurations, .95), serverP95ms: percentile(this.serverPageDurations, .95)},
      images: {visibleWaitP95ms: percentile(this.presentationWaits, .95), mountToLoadP95ms: percentile(this.mountLoadDurations, .95)},
      resources: {
        observerSupported: this.resourceTimingSupported,
        entries: this.resourceRequests,
        durationP95ms: percentile(this.resourceDurations, .95),
        responseStatusesIfSupported: this.resourceStatuses,
        transferSizeAvailable: this.resourceBytesSupported,
        observedTransferSizeBytes: this.resourceBytesSupported ? this.totalTransferred : null,
        caveat: 'Timing/status/bytes availability depends on WebKit; zero transfer bytes do NOT prove a cache hit.',
      },
      animation: {frameGapP95ms: percentile(this.frameGaps, .95), gapsOver50ms: this.frameGapOver50},
      thumbnailQueue: {peakQueued: this.maxQueueDepth, samples: this.queues},
      slowEventTimeline: this.events,
      limitations: ['Image load is not a guaranteed paint timestamp.', 'PSS/CPU and actual disk reads are not measured.', 'The opt-in status sample performs a read-only API request every 5s.', 'Only the latest 300 samples of each metric are retained.'],
    };
  }
  private startedAt = '';

  private render(): void {
    if (!this.details || !this.enabled) return;
    const last = this.queues[this.queues.length - 1];
    const total = this.entered;
    const ready = total ? (100 * this.readyAtEntry / total).toFixed(1) + '%' : 'n/a';
    this.details.textContent =
      'Глубина: ' + this.depth + ' · карточек: ' + this.cards.size +
      '\nГотовы при входе: ' + ready + ' (' + total + ')' +
      '\nОжидание видимых p95: ' + String(percentile(this.presentationWaits, .95)) + ' мс' +
      '\nСтраницы /api/images p95: ' + String(percentile(this.pageDurations, .95)) + ' мс' +
      '\nРесурсы миниатюр p95: ' + String(percentile(this.resourceDurations, .95)) + ' мс' +
      '\nFallback 202: ' + this.fallback202 + ' · ошибки primary: ' + this.primaryErrors +
      '\nОчередь миниатюр: ' + (last ? String(last.queued) + ' (running ' + last.running + ')' : 'ещё нет данных') +
      '\nПробелы кадров >50 мс: ' + this.frameGapOver50 +
      '\nPSS: не измеряется этой панелью';
  }

  private async copyReport(): Promise<void> {
    const report = JSON.stringify(this.report(), null, 2);
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        copied = true;
      }
    } catch {}
    if (!copied) {
      const input = document.createElement('textarea');
      input.value = report;
      input.style.cssText = 'position:fixed;top:20px;left:20px;z-index:2147483647;width:70vw;height:70vh;';
      document.body.appendChild(input);
      input.select();
      try { copied = document.execCommand('copy'); } catch {}
      if (copied) input.remove();
    }
    if (this.details) this.details.textContent += copied ? '\nОтчёт скопирован.' : '\nСкопируй выделенный текст из окна.';
  }

  private start(): void {
    this.enabled = true;
    this.since = performance.now();
    this.startedAt = new Date().toISOString();
    this.panel = document.createElement('aside');
    this.panel.setAttribute('aria-label', 'Vilra scroll diagnostics');
    this.panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483646;width:290px;max-width:calc(100vw - 24px);padding:12px;background:#111;color:#eee;border:1px solid #f79646;border-radius:10px;font:12px/1.45 monospace;box-shadow:0 5px 20px #000a;';
    const title = document.createElement('div');
    title.textContent = 'Vilra · диагностика прокрутки';
    title.style.cssText = 'font-weight:bold;color:#f79646;margin-bottom:8px;';
    this.details = document.createElement('div');
    this.details.style.whiteSpace = 'pre-wrap';
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
    const copy = document.createElement('button');
    copy.textContent = 'Копировать JSON';
    copy.type = 'button';
    copy.onclick = () => { void this.copyReport(); };
    const close = document.createElement('button');
    close.textContent = 'Закрыть';
    close.type = 'button';
    close.onclick = () => this.stop();
    for (const control of [copy, close]) {
      control.style.cssText = 'background:#292929;color:#eee;border:1px solid #555;padding:5px 7px;border-radius:4px;cursor:pointer;';
      controls.appendChild(control);
    }
    this.panel.append(title, this.details, controls);
    document.body.appendChild(this.panel);
    try {
      this.resourceObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) this.onResource(entry as PerformanceResourceTiming);
      });
      this.resourceObserver.observe({type: 'resource'});
      this.resourceTimingSupported = true;
    } catch {
      this.resourceObserver = null;
    }
    this.animationFrame = requestAnimationFrame(this.frame);
    this.refreshTimer = setInterval(() => this.render(), 1200);
    this.queueTimer = setInterval(() => { void this.sampleQueue(); }, 5000);
    void this.sampleQueue();
    this.event('diagnostics-started');
    this.render();
  }

  private stop(): void {
    this.enabled = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    cancelAnimationFrame(this.animationFrame);
    this.resourceObserver?.disconnect();
    this.resourceObserver = null;
    this.panel?.remove();
    this.panel = null;
    this.details = null;
    this.cards.clear();
  }
}

export const galleryDiagnostics = new GalleryDiagnostics();
