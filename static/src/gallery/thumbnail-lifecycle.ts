import type {DiagnosticCardRef} from '../gallery-diagnostics';
import {readJsonRecord, type JsonRecord} from '../shared/helpers';

export type ThumbAdmissionClass = 'visible' | 'near';
type ThumbLifecycleState = 'missing' | 'admitting' | 'polling';
type ThumbnailDecodeResult = 'ready' | 'stale' | 'failed';

export interface ThumbLifecycle {
  imageId: string;
  version: number;
  image: HTMLImageElement;
  primaryUrl: string;
  admissionUrl: string;
  state: ThumbLifecycleState;
  generation: number;
  startedAt: number;
  pollAttempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  objectUrl: string | null;
}

interface ThumbnailLifecycleDiagnostics {
  fallbackAttemptStarted(ref: DiagnosticCardRef | null): number | null;
  fallbackResponse(ref: DiagnosticCardRef | null, status: number, startedAt: number | null): void;
  fallbackNetworkError(ref: DiagnosticCardRef | null): void;
  fallbackImageLoaded(ref: DiagnosticCardRef | null, valid: boolean): void;
  fallbackImageFailed(ref: DiagnosticCardRef | null): void;
  terminalThumbnailError(ref: DiagnosticCardRef | null, reason: string): void;
  terminalThumbnailUnavailable(ref: DiagnosticCardRef | null): void;
}

interface ThumbnailLifecycleDependencies {
  isTerminal(imageId: string): boolean;
  onTerminalUnavailable(imageId: string): void;
  scheduleAdmissionEvaluation(): void;
  diagnosticRef(image: HTMLImageElement | null): DiagnosticCardRef | null;
  diagnostics: ThumbnailLifecycleDiagnostics;
}

const THUMB_POLL_INITIAL_DELAY_MS = 300;
const THUMB_POLL_BACKOFF = 1.5;
const THUMB_POLL_MAX_INTERVAL_MS = 2000;
const THUMB_POLL_MAX_ATTEMPTS = 30;
const THUMB_POLL_MAX_LIFETIME_MS = 45_000;

export async function decodeCurrentThumbnail(
  image: HTMLImageElement,
  expectedSrc: string,
  isCurrent: () => boolean,
): Promise<ThumbnailDecodeResult> {
  try {
    await image.decode();
  } catch {
    return isCurrent() && image.currentSrc === expectedSrc ? 'failed' : 'stale';
  }
  if (!isCurrent() || image.currentSrc !== expectedSrc) return 'stale';
  return image.complete && image.naturalWidth > 0 ? 'ready' : 'failed';
}

export class ThumbnailLifecycleManager {
  private readonly lifecycles = new Map<string, ThumbLifecycle>();
  private generation = 0;

  constructor(private readonly dependencies: ThumbnailLifecycleDependencies) {}

  get(imageId: string): ThumbLifecycle | undefined {
    return this.lifecycles.get(imageId);
  }

  isCurrent(lifecycle: ThumbLifecycle): boolean {
    return this.lifecycles.get(lifecycle.imageId) === lifecycle
      && lifecycle.image.isConnected
      && lifecycle.image.dataset.thumbLifecycleGeneration === String(lifecycle.generation)
      && !this.dependencies.isTerminal(lifecycle.imageId);
  }

  registerMissing(image: HTMLImageElement): void {
    const imageId = String(
      image.dataset.imageId || image.closest<HTMLElement>('.card[data-id]')?.dataset.id || '',
    );
    const primaryUrl = String(image.dataset.primarySrc || '');
    const admissionUrl = String(image.dataset.fallbackSrc || '');
    const version = Number(image.dataset.thumbVersion || 0);
    if (!imageId || !primaryUrl || !admissionUrl || this.dependencies.isTerminal(imageId)) return;
    const existing = this.lifecycles.get(imageId);
    if (existing?.image === image && existing.version === version) return;
    this.cancel(imageId);
    const lifecycle: ThumbLifecycle = {
      imageId,
      version,
      image,
      primaryUrl,
      admissionUrl,
      state: 'missing',
      generation: ++this.generation,
      startedAt: 0,
      pollAttempts: 0,
      timer: null,
      controller: null,
      objectUrl: null,
    };
    image.dataset.thumbLifecycleGeneration = String(lifecycle.generation);
    this.lifecycles.set(imageId, lifecycle);
    this.dependencies.scheduleAdmissionEvaluation();
  }

  cancel(imageId: string): void {
    const lifecycle = this.lifecycles.get(imageId);
    if (!lifecycle) return;
    lifecycle.controller?.abort();
    lifecycle.controller = null;
    if (lifecycle.timer) clearTimeout(lifecycle.timer);
    lifecycle.timer = null;
    this.lifecycles.delete(imageId);
  }

  clear(imageId: string, card: HTMLElement): void {
    const lifecycle = this.lifecycles.get(imageId);
    if (lifecycle) {
      lifecycle.controller?.abort();
      lifecycle.controller = null;
      if (lifecycle.timer) clearTimeout(lifecycle.timer);
      lifecycle.timer = null;
      this.lifecycles.delete(imageId);
    }

    const image = card.querySelector('img');
    if (!(image instanceof HTMLImageElement)) return;
    image.onload = null;
    image.onerror = null;
    if (lifecycle?.objectUrl) {
      this.releaseObjectUrl(lifecycle, lifecycle.objectUrl);
    } else {
      const objectUrl = image.dataset.objectUrl;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        delete image.dataset.objectUrl;
      }
    }
    delete image.dataset.thumbLifecycleGeneration;
  }

  async admit(lifecycle: ThumbLifecycle, admissionClass: ThumbAdmissionClass): Promise<void> {
    if (!this.isCurrent(lifecycle) || lifecycle.state !== 'missing') return;
    lifecycle.state = 'admitting';
    lifecycle.startedAt = performance.now();
    const controller = new AbortController();
    lifecycle.controller = controller;
    const diagnosticRef = this.dependencies.diagnosticRef(lifecycle.image);
    const diagnosticStartedAt = this.dependencies.diagnostics.fallbackAttemptStarted(diagnosticRef);
    const url = this.admissionRequestUrl(lifecycle, admissionClass);
    try {
      const response = await fetch(url, {cache: 'no-store', signal: controller.signal});
      this.dependencies.diagnostics.fallbackResponse(
        diagnosticRef,
        response.status,
        diagnosticStartedAt,
      );
      if (!this.isCurrent(lifecycle)) return;
      if (response.status === 200) {
        this.setFromBlob(lifecycle, await response.blob());
        return;
      }
      if (response.status === 202) {
        let initialDelay = THUMB_POLL_INITIAL_DELAY_MS;
        try {
          const payload = await readJsonRecord(response);
          initialDelay = Math.max(initialDelay, Number(payload.retry_after_ms || 0));
        } catch {}
        lifecycle.state = 'polling';
        this.scheduleFilePoll(lifecycle, Math.min(initialDelay, THUMB_POLL_MAX_INTERVAL_MS));
        return;
      }
      if (response.status === 422) {
        const payload = await readJsonRecord(response).catch((): JsonRecord => ({}));
        if (payload.error === 'image_unavailable') {
          this.unavailable(lifecycle);
          return;
        }
      }
      console.warn('Thumbnail admission failed', {url, status: response.status, admissionClass});
      this.fail(lifecycle, `fallback_http_${response.status}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.dependencies.diagnostics.fallbackNetworkError(diagnosticRef);
      console.warn('Thumbnail admission failed', {url, admissionClass, error});
      this.fail(lifecycle, 'fallback_network_error');
    } finally {
      if (lifecycle.controller === controller) lifecycle.controller = null;
    }
  }

  private admissionRequestUrl(
    lifecycle: ThumbLifecycle,
    admissionClass: ThumbAdmissionClass,
  ): string {
    const url = new URL(lifecycle.admissionUrl, window.location.href);
    url.searchParams.set('class', admissionClass);
    return `${url.pathname}${url.search}`;
  }

  private setFromBlob(lifecycle: ThumbLifecycle, blob: Blob): void {
    if (!this.isCurrent(lifecycle)) return;
    const image = lifecycle.image;
    const diagnosticRef = this.dependencies.diagnosticRef(image);
    const objectUrl = URL.createObjectURL(blob);
    lifecycle.objectUrl = objectUrl;
    image.dataset.objectUrl = objectUrl;
    const releaseObjectUrl = () => this.releaseObjectUrl(lifecycle, objectUrl);
    const handleFallbackLoad = () => {
      const expectedSrc = image.currentSrc;
      void decodeCurrentThumbnail(
        image,
        expectedSrc,
        () => this.isCurrent(lifecycle)
          && image.onload === handleFallbackLoad
          && lifecycle.objectUrl === objectUrl,
      ).then(result => {
        if (result === 'stale') {
          releaseObjectUrl();
          return;
        }
        if (result === 'failed') {
          this.dependencies.diagnostics.fallbackImageFailed(diagnosticRef);
          this.fail(lifecycle, 'fallback_decode_error');
          releaseObjectUrl();
          return;
        }
        this.dependencies.diagnostics.fallbackImageLoaded(diagnosticRef, true);
        image.classList.add('loaded');
        releaseObjectUrl();
        this.lifecycles.delete(lifecycle.imageId);
        this.dependencies.scheduleAdmissionEvaluation();
      });
    };
    image.onload = handleFallbackLoad;
    image.onerror = () => {
      this.dependencies.diagnostics.fallbackImageFailed(diagnosticRef);
      this.fail(lifecycle, 'fallback_decode_error');
      releaseObjectUrl();
    };
    image.src = objectUrl;
  }

  private releaseObjectUrl(lifecycle: ThumbLifecycle, objectUrl: string): void {
    const image = lifecycle.image;
    const ownsLifecycleUrl = lifecycle.objectUrl === objectUrl;
    const ownsImageUrl = image.dataset.objectUrl === objectUrl;
    if (!ownsLifecycleUrl && !ownsImageUrl) return;
    if (ownsLifecycleUrl) lifecycle.objectUrl = null;
    if (ownsImageUrl) delete image.dataset.objectUrl;
    URL.revokeObjectURL(objectUrl);
  }

  private fail(lifecycle: ThumbLifecycle, reason: string): void {
    if (!this.isCurrent(lifecycle)) return;
    const image = lifecycle.image;
    this.dependencies.diagnostics.terminalThumbnailError(
      this.dependencies.diagnosticRef(image),
      reason,
    );
    this.cancel(lifecycle.imageId);
    image.classList.add('loaded');
    image.alt = 'Ошибка загрузки';
    this.dependencies.scheduleAdmissionEvaluation();
  }

  private unavailable(lifecycle: ThumbLifecycle): void {
    if (!this.isCurrent(lifecycle)) return;
    this.dependencies.diagnostics.terminalThumbnailUnavailable(
      this.dependencies.diagnosticRef(lifecycle.image),
    );
    this.dependencies.onTerminalUnavailable(lifecycle.imageId);
  }

  private scheduleFilePoll(lifecycle: ThumbLifecycle, delay?: number): void {
    if (!this.isCurrent(lifecycle) || lifecycle.state !== 'polling') return;
    const elapsed = performance.now() - lifecycle.startedAt;
    if (
      lifecycle.pollAttempts >= THUMB_POLL_MAX_ATTEMPTS
      || elapsed >= THUMB_POLL_MAX_LIFETIME_MS
    ) {
      this.fail(lifecycle, 'thumb_file_poll_exhausted');
      return;
    }
    const nextDelay = delay ?? Math.min(
      THUMB_POLL_MAX_INTERVAL_MS,
      THUMB_POLL_INITIAL_DELAY_MS * THUMB_POLL_BACKOFF ** lifecycle.pollAttempts,
    );
    lifecycle.timer = setTimeout(() => {
      lifecycle.timer = null;
      void this.pollFile(lifecycle);
    }, nextDelay);
  }

  private async pollFile(lifecycle: ThumbLifecycle): Promise<void> {
    if (!this.isCurrent(lifecycle) || lifecycle.state !== 'polling') return;
    lifecycle.pollAttempts += 1;
    const controller = new AbortController();
    lifecycle.controller = controller;
    const diagnosticRef = this.dependencies.diagnosticRef(lifecycle.image);
    const diagnosticStartedAt = this.dependencies.diagnostics.fallbackAttemptStarted(diagnosticRef);
    try {
      const response = await fetch(lifecycle.primaryUrl, {
        cache: 'no-store',
        signal: controller.signal,
      });
      this.dependencies.diagnostics.fallbackResponse(
        diagnosticRef,
        response.status,
        diagnosticStartedAt,
      );
      if (!this.isCurrent(lifecycle)) return;
      if (response.status === 200) {
        this.setFromBlob(lifecycle, await response.blob());
        return;
      }
      if (response.status === 404) {
        this.scheduleFilePoll(lifecycle);
        return;
      }
      if (response.status === 422) {
        const payload = await readJsonRecord(response).catch((): JsonRecord => ({}));
        if (payload.error === 'image_unavailable') {
          this.unavailable(lifecycle);
          return;
        }
      }
      console.warn('Thumbnail cache poll failed', {url: lifecycle.primaryUrl, status: response.status});
      this.fail(lifecycle, `thumb_file_http_${response.status}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.dependencies.diagnostics.fallbackNetworkError(diagnosticRef);
      if (this.isCurrent(lifecycle)) this.scheduleFilePoll(lifecycle);
    } finally {
      if (lifecycle.controller === controller) lifecycle.controller = null;
    }
  }
}
