import {type ImageItem} from '../gallery/image-data';
import {type PreviewImageRequest} from './preview-modal';

export type PreviewSourceMode = 'gallery' | 'fixed';

export interface ViewerModal {
  readonly modal: HTMLElement;
  readonly isOpen: boolean;
  open(source: PreviewImageRequest): void;
  close(): void;
}

export interface ViewerGalleryPort {
  getVisibleImages(): ImageItem[];
  getAllImages(): ImageItem[];
  hasMorePages(): boolean;
  loadNextPage(): Promise<void>;
  clearPendingAnchor(): void;
  scheduleAnchorRestore(imageId: string): void;
}

export interface ViewerSessionPort {
  getLastImageId(): string | null;
  setLastImageId(imageId: string | null): void;
  hasTabs(): boolean;
  saveSessionSoon(): void;
  isGalleryActive(): boolean;
}

export interface ViewerUiPort {
  resetUiState(): void;
  resetNearbyCapacity(): void;
  resetFilmMode(): void;
  closeTransientUi(): void;
  cancelFilmstripLayoutRefresh(): void;
  renderImage(image: ImageItem, loading: boolean): void;
  refreshSourceUi(): void;
  setBodyLocked(locked: boolean): void;
  scheduleFilmstripLayoutRefresh(): void;
  thumbnailUrls(image: ImageItem): {primary: string; fallback: string};
  fileName(path: string): string;
  diagnoseOriginalFailure(image: ImageItem, isCurrent: () => boolean): Promise<void>;
}

export interface ViewerCoordinatorOptions {
  modal: ViewerModal;
  gallery: ViewerGalleryPort;
  session: ViewerSessionPort;
  ui: ViewerUiPort;
}

export class ViewerCoordinator {
  private readonly modal: ViewerModal;
  private readonly gallery: ViewerGalleryPort;
  private readonly session: ViewerSessionPort;
  private readonly ui: ViewerUiPort;

  private previewSourceMode: PreviewSourceMode = 'gallery';
  private previewCurrentImageId: string | null = null;
  private lightboxImages: ImageItem[] = [];
  private previewPageNavigationBusy = false;
  private previewPendingDirection: -1 | 1 | null = null;
  private previewNavigationGeneration = 0;
  private previewRequestToken = 0;
  private suppressPreviewCloseClear = false;
  private suppressPreviewGalleryReturn = false;
  private suppressedPreviewRestoreId: string | null = null;

  constructor(options: ViewerCoordinatorOptions) {
    this.modal = options.modal;
    this.gallery = options.gallery;
    this.session = options.session;
    this.ui = options.ui;
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  get currentImageId(): string | null {
    return this.previewCurrentImageId;
  }

  get currentImage(): ImageItem | null {
    const source = this.source();
    const index = this.currentIndex;
    return index >= 0 ? source[index] : null;
  }

  get currentIndex(): number {
    if (!this.previewCurrentImageId) return -1;
    return this.source().findIndex(image => image.id === this.previewCurrentImageId);
  }

  get sourceMode(): PreviewSourceMode {
    return this.previewSourceMode;
  }

  source(): ImageItem[] {
    return this.previewSourceMode === 'gallery'
      ? this.gallery.getVisibleImages()
      : this.lightboxImages;
  }

  openById(imageId: string, persist = true): void {
    const visibleImages = this.gallery.getVisibleImages();
    const allImages = this.gallery.getAllImages();
    const sourceList = visibleImages.find(image => image.id === imageId) ? visibleImages : allImages;
    const index = sourceList.findIndex(image => image.id === imageId);
    if (index < 0) {
      console.warn('openLightboxById: image not found in current gallery state', {
        imageId,
        visibleCount: visibleImages.length,
        allCount: allImages.length,
        renderedCardCount: document.querySelectorAll('.card[data-id]').length,
      });
      return;
    }
    this.openAt(index, persist, sourceList, 'gallery');
  }

  openAt(
    index: number,
    persist = true,
    sourceList: ImageItem[] = this.gallery.getVisibleImages(),
    sourceMode: PreviewSourceMode = 'gallery',
  ): void {
    const visibleImages = this.gallery.getVisibleImages();
    const nextSource = Array.isArray(sourceList) && sourceList.length ? sourceList : visibleImages;
    if (!Number.isInteger(index) || index < 0 || index >= nextSource.length) {
      console.warn('openLightbox: invalid image index', {
        idx: index,
        sourceLength: nextSource.length,
      });
      return;
    }
    const nextImageId = nextSource[index].id;
    const activeSource = sourceMode === 'gallery' ? visibleImages : nextSource;
    const currentIndex = activeSource.findIndex(image => image.id === nextImageId);
    if (currentIndex < 0) {
      console.warn('openLightbox: image is missing from active preview source', {
        imageId: nextImageId,
        sourceMode,
        sourceLength: activeSource.length,
      });
      return;
    }

    const navigatingOpenViewer = this.modal.isOpen;
    if (!navigatingOpenViewer || this.previewSourceMode !== sourceMode) {
      this.invalidateNavigation();
    }
    if (!navigatingOpenViewer) {
      this.gallery.clearPendingAnchor();
      this.ui.resetUiState();
      this.ui.resetNearbyCapacity();
    }
    this.previewSourceMode = sourceMode;
    this.lightboxImages = sourceMode === 'fixed' ? nextSource : [];
    this.previewCurrentImageId = nextImageId;
    if (persist) this.suppressedPreviewRestoreId = null;
    this.ui.closeTransientUi();
    this.ui.resetFilmMode();

    const image = this.source()[currentIndex];
    this.session.setLastImageId(image.id);
    this.ui.renderImage(image, true);
    this.ui.setBodyLocked(true);
    const token = ++this.previewRequestToken;
    const sources = this.ui.thumbnailUrls(image);
    this.modal.open({
      imageId: image.id,
      thumbnailUrl: sources.primary,
      thumbnailFallbackUrl: sources.fallback,
      originalUrl: `/file/${image.id}`,
      width: Number(image.width || 1),
      height: Number(image.height || 1),
      alt: this.ui.fileName(image.path),
      onOriginalReady: () => {
        if (!this.isCurrentOriginalRequest(image.id, token)) return;
        this.ui.renderImage(image, false);
      },
      onOriginalError: () => {
        if (!this.isCurrentOriginalRequest(image.id, token)) return;
        void this.ui.diagnoseOriginalFailure(
          image,
          () => this.isCurrentOriginalRequest(image.id, token),
        );
      },
    });
    this.ui.scheduleFilmstripLayoutRefresh();
    if (persist) this.session.saveSessionSoon();
  }

  close(clearLast = true, restoreGalleryAnchor = clearLast): void {
    this.previewRequestToken += 1;
    this.suppressPreviewCloseClear = !clearLast;
    this.suppressPreviewGalleryReturn = !restoreGalleryAnchor;
    if (this.modal.isOpen) this.modal.close();
    this.suppressPreviewCloseClear = false;
    this.suppressPreviewGalleryReturn = false;
    if (clearLast) {
      this.session.setLastImageId(null);
      this.session.saveSessionSoon();
    }
  }

  navigate(directionValue: number): void {
    const direction: -1 | 1 = directionValue < 0 ? -1 : 1;
    if (this.previewPageNavigationBusy) {
      this.previewPendingDirection = direction;
      return;
    }
    const source = this.source();
    if (!source.length) return;
    const currentIndex = this.currentIndex;
    if (currentIndex < 0) return;
    if (this.previewSourceMode === 'fixed') {
      this.openAt((currentIndex + direction + source.length) % source.length, true, source, 'fixed');
      return;
    }
    const desiredIndex = currentIndex + direction;
    if (desiredIndex >= 0 && desiredIndex < source.length) {
      this.openAt(desiredIndex, true, source, 'gallery');
      return;
    }
    if (direction < 0) {
      if (!this.gallery.hasMorePages()) this.openAt(source.length - 1, true, source, 'gallery');
      return;
    }
    if (!this.gallery.hasMorePages()) {
      this.openAt(0, true, source, 'gallery');
      return;
    }
    void this.navigateAcrossPageBoundary();
  }

  restoreIfNeeded(): void {
    if (!this.session.isGalleryActive()) return;
    const imageId = this.session.getLastImageId();
    if (!imageId || imageId === this.suppressedPreviewRestoreId) return;
    if (!this.modal.isOpen) this.openById(imageId, false);
  }

  suppressRestoreFromActiveTab(): void {
    this.suppressedPreviewRestoreId = this.session.getLastImageId();
  }

  invalidateOriginalRequest(): void {
    this.previewRequestToken += 1;
  }

  refreshGallerySource(): void {
    if (!this.modal.isOpen || this.currentIndex < 0) return;
    this.ui.refreshSourceUi();
  }

  updateFixedImage(image: ImageItem): void {
    if (this.previewSourceMode !== 'fixed') return;
    const index = this.lightboxImages.findIndex(item => item.id === image.id);
    if (index >= 0) this.lightboxImages[index] = image;
  }

  handleModalClosed(): void {
    const closingImageId = this.previewCurrentImageId;
    const shouldRestoreGallery = !this.suppressPreviewGalleryReturn
      && this.previewSourceMode === 'gallery'
      && Boolean(closingImageId);
    this.previewRequestToken += 1;
    this.invalidateNavigation();
    this.ui.cancelFilmstripLayoutRefresh();
    this.ui.setBodyLocked(false);
    this.ui.closeTransientUi();
    this.ui.resetUiState();
    this.lightboxImages = [];
    this.previewCurrentImageId = null;
    this.previewSourceMode = 'gallery';
    if (!this.suppressPreviewCloseClear && this.session.hasTabs() && this.session.getLastImageId()) {
      this.session.setLastImageId(null);
      this.session.saveSessionSoon();
    }
    if (shouldRestoreGallery && closingImageId) {
      this.gallery.scheduleAnchorRestore(closingImageId);
    }
  }

  private invalidateNavigation(): void {
    this.previewNavigationGeneration += 1;
    this.previewPageNavigationBusy = false;
    this.previewPendingDirection = null;
  }

  private isCurrentOriginalRequest(imageId: string, token: number): boolean {
    return token === this.previewRequestToken
      && this.modal.isOpen
      && this.modal.modal.dataset.imageId === imageId
      && this.previewCurrentImageId === imageId;
  }

  private async navigateAcrossPageBoundary(): Promise<void> {
    if (
      this.previewPageNavigationBusy
      || this.previewSourceMode !== 'gallery'
      || !this.previewCurrentImageId
    ) return;
    this.previewPageNavigationBusy = true;
    const generation = this.previewNavigationGeneration;
    const currentImageId = this.previewCurrentImageId;
    try {
      await this.gallery.loadNextPage();
      if (
        generation !== this.previewNavigationGeneration
        || !this.modal.isOpen
        || this.previewSourceMode !== 'gallery'
        || this.previewCurrentImageId !== currentImageId
      ) return;
      const source = this.source();
      const currentIndex = source.findIndex(image => image.id === currentImageId);
      if (currentIndex >= 0 && currentIndex + 1 < source.length) {
        this.openAt(currentIndex + 1, true, source, 'gallery');
      }
    } finally {
      if (generation !== this.previewNavigationGeneration) return;
      this.previewPageNavigationBusy = false;
      const pendingDirection = this.previewPendingDirection;
      this.previewPendingDirection = null;
      if (pendingDirection && this.modal.isOpen) this.navigate(pendingDirection);
    }
  }
}
