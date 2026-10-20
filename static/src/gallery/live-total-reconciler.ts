import {imagePage, pageTotalValue} from './image-data';
import {readJsonRecord} from '../shared/helpers';

const LIVE_TOTAL_DEBOUNCE_MS = 50;

export interface LiveTotalReconcilerPort {
  getActiveRequestId(): number;
  buildCountQueryParams(): URLSearchParams;
  applyCanonicalTotal(total: number): void;
}

export class LiveTotalReconciler {
  private liveTotalTimer: ReturnType<typeof setTimeout> | null = null;
  private liveTotalRevision = 0;
  private liveTotalRequestRunning = false;
  private liveTotalReconcilePending = false;
  private readonly liveImageMembership = new Map<string, {requestId: number; matches: boolean}>();
  private gallerySnapshotRequest = -1;

  constructor(private readonly port: LiveTotalReconcilerPort) {}

  beginGalleryRefresh(_requestId: number): number {
    const revisionAtStart = this.liveTotalRevision;
    this.liveImageMembership.clear();
    return revisionAtStart;
  }

  acceptGallerySnapshot(requestId: number, revisionAtStart: number): boolean {
    const changed = revisionAtStart !== this.liveTotalRevision;
    this.gallerySnapshotRequest = changed ? -1 : requestId;
    if (!changed) this.liveImageMembership.clear();
    return changed;
  }

  knownMembership(imageId: string, existingIndex: number): boolean | null {
    const activeRequestId = this.port.getActiveRequestId();
    const cached = this.liveImageMembership.get(imageId);
    if (cached?.requestId === activeRequestId) return cached.matches;
    if (this.gallerySnapshotRequest === activeRequestId && existingIndex >= 0) return true;
    return null;
  }

  recordMembership(imageId: string, matches: boolean): void {
    this.liveImageMembership.set(imageId, {
      requestId: this.port.getActiveRequestId(),
      matches,
    });
  }

  reconcileMembership(previous: boolean | null, next: boolean): void {
    if (previous === null || previous !== next) this.schedule();
  }

  schedule(): void {
    this.liveTotalRevision += 1;
    this.liveTotalReconcilePending = true;
    this.arm();
  }

  private arm(): void {
    if (
      this.liveTotalTimer
      || this.liveTotalRequestRunning
      || !this.liveTotalReconcilePending
    ) return;
    this.liveTotalTimer = setTimeout(() => {
      this.liveTotalTimer = null;
      void this.reconcile();
    }, LIVE_TOTAL_DEBOUNCE_MS);
  }

  private async reconcile(): Promise<void> {
    if (this.liveTotalRequestRunning || !this.liveTotalReconcilePending) return;
    this.liveTotalReconcilePending = false;
    this.liveTotalRequestRunning = true;
    const revision = this.liveTotalRevision;
    const requestId = this.port.getActiveRequestId();
    const params = this.port.buildCountQueryParams();
    const querySignature = params.toString();
    try {
      const response = await fetch('/api/images?' + querySignature);
      if (!response.ok) return;
      const data = await readJsonRecord(response);
      const total = pageTotalValue(imagePage(data.page));
      if (total === null) return;
      if (
        revision !== this.liveTotalRevision
        || requestId !== this.port.getActiveRequestId()
      ) return;
      if (querySignature !== this.port.buildCountQueryParams().toString()) return;
      this.port.applyCanonicalTotal(total);
    } catch (error) {
      console.warn('Unable to reconcile live gallery total', error);
    } finally {
      this.liveTotalRequestRunning = false;
      this.arm();
    }
  }
}
