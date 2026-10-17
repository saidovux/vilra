import {
  clamp,
  optionalHtml,
  readJsonRecord,
  requireElement,
  type JsonRecord,
} from '../shared/helpers';

export interface PreviewModalOptions {
  modalId: string;
  viewportId: string;
  stageId: string;
  thumbnailId: string;
  imageId: string;
  closeId: string;
  zoomId: string;
  minScale: number;
  maxScale: number;
  messageType: string;
  postToParent: boolean;
}

export interface PreviewImageRequest {
  imageId: string;
  thumbnailUrl: string;
  thumbnailFallbackUrl: string;
  originalUrl: string;
  width: number;
  height: number;
  alt: string;
  onOriginalReady?: () => void;
  onOriginalError?: () => void;
}

/*!
 * PreviewModal standalone lightbox for progressive native images.
 *
 * Required HTML contract:
 * - #preview-modal            (overlay root)
 * - #preview-close            (close button)
 * - #preview-stage-viewport   (fixed Viewer viewport)
 * - #preview-image-stage      (positioned zoom/pan surface inside viewport)
 * - #preview-modal-thumbnail  (temporary thumbnail)
 * - #preview-modal-image      (full-quality original)
 * - #zoom-level               (zoom label, e.g. "100%")
 */
const PREVIEW_MODAL_DEFAULTS: PreviewModalOptions = {
  modalId: "preview-modal",
  viewportId: "preview-stage-viewport",
  stageId: "preview-image-stage",
  thumbnailId: "preview-modal-thumbnail",
  imageId: "preview-modal-image",
  closeId: "preview-close",
  zoomId: "zoom-level",
  minScale: 0.1,
  maxScale: 10,
  messageType: "web-tools:preview-modal",
  postToParent: true
};

export class PreviewModal {
  readonly options: PreviewModalOptions;
  readonly modal: HTMLElement;
  readonly viewport: HTMLElement;
  readonly stage: HTMLElement;
  readonly thumbnail: HTMLImageElement;
  readonly image: HTMLImageElement;
  readonly closeBtn: HTMLElement;
  readonly zoomLevel: HTMLElement;
  readonly onClosed?: () => void;
  isOpen = false;
  fitMode = true;
  scale = 1;
  minScale: number;
  maxScale: number;
  offsetX = 0;
  offsetY = 0;
  isDragging = false;
  hasDragged = false;
  dragStartX = 0;
  dragStartY = 0;
  lastX = 0;
  lastY = 0;
  imageWidth = 0;
  imageHeight = 0;
  containerWidth = 0;
  containerHeight = 0;

  private generation = 0;
  private thumbnailRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private thumbnailObjectUrl: string | null = null;

  private readonly boundWheel = this.handleWheel.bind(this);
  private readonly boundMouseDown = this.handleMouseDown.bind(this);
  private readonly boundMouseMove = this.handleMouseMove.bind(this);
  private readonly boundMouseUp = this.handleMouseUp.bind(this);
  private readonly boundBackdropClick = this.handleBackdropClick.bind(this);
  private readonly boundCloseClick = this.close.bind(this);
  private readonly boundResize = this.handleResize.bind(this);
  private readonly boundDoubleClick = this.handleDoubleClick.bind(this);

  constructor(options: Partial<PreviewModalOptions> = {}, onClosed?: () => void) {
    this.options = {...PREVIEW_MODAL_DEFAULTS, ...options};
    this.modal = requireElement(this.options.modalId, HTMLElement, "Preview modal element is missing");
    this.viewport = requireElement(this.options.viewportId, HTMLElement, "Preview viewport element is missing");
    this.stage = requireElement(this.options.stageId, HTMLElement, "Preview image stage is missing");
    this.thumbnail = requireElement(this.options.thumbnailId, HTMLImageElement, "Preview thumbnail is missing");
    this.image = requireElement(this.options.imageId, HTMLImageElement, "Preview original image is missing");
    this.closeBtn = requireElement(this.options.closeId, HTMLElement, "Preview close button is missing");
    this.zoomLevel = requireElement(this.options.zoomId, HTMLElement, "Preview zoom label is missing");
    this.minScale = Number(this.options.minScale);
    this.maxScale = Number(this.options.maxScale);
    this.onClosed = onClosed;
    if (!Number.isFinite(this.minScale) || this.minScale <= 0) this.minScale = PREVIEW_MODAL_DEFAULTS.minScale;
    if (!Number.isFinite(this.maxScale) || this.maxScale <= this.minScale) this.maxScale = PREVIEW_MODAL_DEFAULTS.maxScale;
    this.initEventListeners();
  }

  private notifyShell(open: boolean): void {
    if (!this.options.postToParent) return;
    if (!window.parent || window.parent === window) return;
    window.parent.postMessage({ type: this.options.messageType, open: Boolean(open) }, "*");
  }

  private initEventListeners(): void {
    this.closeBtn.addEventListener("click", this.boundCloseClick);
    this.modal.addEventListener("click", this.boundBackdropClick);
    this.stage.addEventListener("wheel", this.boundWheel, { passive: false });
    this.stage.addEventListener("mousedown", this.boundMouseDown);
    this.stage.addEventListener("mousemove", this.boundMouseMove);
    this.stage.addEventListener("mouseup", this.boundMouseUp);
    this.stage.addEventListener("mouseleave", this.boundMouseUp);
    this.stage.addEventListener("dblclick", this.boundDoubleClick);
    window.addEventListener("resize", this.boundResize);
  }

  private handleBackdropClick(event: MouseEvent): void {
    if (event.target === this.modal) this.close();
  }

  open(source: PreviewImageRequest): void {
    this.releaseMedia(false);
    const generation = this.generation;
    this.imageWidth = Math.max(1, source.width);
    this.imageHeight = Math.max(1, source.height);
    this.modal.style.display = "block";
    this.modal.setAttribute("aria-hidden", "false");
    this.isOpen = true;
    this.fit();
    this.modal.dataset.imageId = source.imageId;
    this.stage.dataset.imageId = source.imageId;
    this.stage.dataset.originalState = "loading";
    this.stage.classList.remove("original-ready");
    this.thumbnail.dataset.state = "loading";
    this.thumbnail.alt = source.alt;
    this.image.dataset.state = "loading";
    this.image.alt = source.alt;
    this.notifyShell(true);
    this.render();

    this.thumbnail.onload = () => {
      if (!this.isCurrent(generation, source.imageId)) return;
      this.thumbnail.dataset.state = "ready";
    };
    this.thumbnail.onerror = () => {
      if (!this.isCurrent(generation, source.imageId)) return;
      this.thumbnail.onload = null;
      this.thumbnail.onerror = null;
      void this.loadFallbackThumbnail(source, generation);
    };
    this.thumbnail.src = source.thumbnailUrl;

    this.image.onload = () => {
      if (!this.isCurrent(generation, source.imageId)) return;
      const naturalWidth = this.image.naturalWidth || this.imageWidth;
      const naturalHeight = this.image.naturalHeight || this.imageHeight;
      this.adoptNaturalDimensions(naturalWidth, naturalHeight);
      this.image.dataset.state = "ready";
      this.stage.dataset.originalState = "ready";
      this.stage.classList.add("original-ready");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (this.isCurrent(generation, source.imageId)) source.onOriginalReady?.();
      }));
    };
    this.image.onerror = () => {
      if (!this.isCurrent(generation, source.imageId)) return;
      this.image.dataset.state = "error";
      this.stage.dataset.originalState = "error";
      source.onOriginalError?.();
    };
    this.image.src = source.originalUrl;
  }

  close(): void {
    const wasOpen = this.isOpen;
    this.modal.style.display = "none";
    this.modal.setAttribute("aria-hidden", "true");
    this.modal.classList.remove("preview-focus-mode", "preview-inspector-hidden");
    this.isOpen = false;
    this.isDragging = false;
    this.hasDragged = false;
    const generation = this.releaseMedia(false);
    this.releaseSourcesAfterPaint(generation);
    this.notifyShell(false);
    if (wasOpen) this.onClosed?.();
  }

  private isCurrent(generation: number, imageId: string): boolean {
    return this.isOpen && this.generation === generation && this.modal.dataset.imageId === imageId;
  }

  private releaseMedia(removeSources = true): number {
    this.generation += 1;
    if (this.thumbnailRetryTimer) clearTimeout(this.thumbnailRetryTimer);
    this.thumbnailRetryTimer = null;
    if (this.thumbnailObjectUrl) URL.revokeObjectURL(this.thumbnailObjectUrl);
    this.thumbnailObjectUrl = null;
    this.thumbnail.onload = null;
    this.thumbnail.onerror = null;
    this.image.onload = null;
    this.image.onerror = null;
    if (removeSources) {
      this.thumbnail.removeAttribute("src");
      this.image.removeAttribute("src");
    }
    this.thumbnail.dataset.state = "idle";
    this.image.dataset.state = "idle";
    this.stage.dataset.originalState = "idle";
    this.stage.classList.remove("original-ready");
    delete this.modal.dataset.imageId;
    delete this.stage.dataset.imageId;
    return this.generation;
  }

  private releaseSourcesAfterPaint(generation: number): void {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      if (this.generation !== generation || this.isOpen) return;
      this.thumbnail.removeAttribute("src");
      this.image.removeAttribute("src");
    }, 0)));
  }

  private async loadFallbackThumbnail(source: PreviewImageRequest, generation: number, attempt = 0): Promise<void> {
    try {
      const response = await fetch(source.thumbnailFallbackUrl, {cache: "no-store"});
      if (!this.isCurrent(generation, source.imageId)) return;
      if (response.status === 200) {
        const objectUrl = URL.createObjectURL(await response.blob());
        if (!this.isCurrent(generation, source.imageId)) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        this.thumbnailObjectUrl = objectUrl;
        this.thumbnail.onload = () => {
          if (!this.isCurrent(generation, source.imageId)) return;
          this.thumbnail.dataset.state = "ready";
          URL.revokeObjectURL(objectUrl);
          if (this.thumbnailObjectUrl === objectUrl) this.thumbnailObjectUrl = null;
        };
        this.thumbnail.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          if (this.thumbnailObjectUrl === objectUrl) this.thumbnailObjectUrl = null;
          if (this.isCurrent(generation, source.imageId)) this.thumbnail.dataset.state = "error";
        };
        this.thumbnail.src = objectUrl;
        return;
      }
      if (response.status === 202 && attempt < 120) {
        const payload = await readJsonRecord(response).catch((): JsonRecord => ({}));
        const delay = Math.min(1500, Math.max(80, Number(payload.retry_after_ms || 180)));
        this.thumbnailRetryTimer = setTimeout(() => {
          this.thumbnailRetryTimer = null;
          if (this.isCurrent(generation, source.imageId)) {
            void this.loadFallbackThumbnail(source, generation, attempt + 1);
          }
        }, delay);
        return;
      }
    } catch (error) {
      console.warn("Preview thumbnail request failed", {imageId: source.imageId, attempt, error});
    }
    if (this.isCurrent(generation, source.imageId)) this.thumbnail.dataset.state = "error";
  }

  private measureViewport(): void {
    const rect = this.viewport.getBoundingClientRect();
    this.containerWidth = Math.max(1, rect.width);
    this.containerHeight = Math.max(1, rect.height);
  }

  fit(): void {
    if (!this.isOpen) return;
    this.measureViewport();
    const scaleX = this.containerWidth / this.imageWidth;
    const scaleY = this.containerHeight / this.imageHeight;
    const fitScale = Math.min(scaleX, scaleY, this.maxScale);
    this.minScale = Math.min(Number(this.options.minScale), fitScale);
    this.scale = clamp(fitScale, this.minScale, this.maxScale);
    this.fitMode = true;
    this.offsetX = (this.containerWidth - this.imageWidth * this.scale) / 2;
    this.offsetY = (this.containerHeight - this.imageHeight * this.scale) / 2;
    this.render();
  }

  oneToOne(): void {
    if (!this.isOpen) return;
    this.measureViewport();
    this.fitMode = false;
    this.scale = clamp(1, this.minScale, this.maxScale);
    this.offsetX = (this.containerWidth - this.imageWidth * this.scale) / 2;
    this.offsetY = (this.containerHeight - this.imageHeight * this.scale) / 2;
    this.constrainOffset();
    this.render();
  }

  zoomBy(factor: number): void {
    if (!this.isOpen || !Number.isFinite(factor) || factor <= 0) return;
    this.measureViewport();
    this.zoomAt(this.containerWidth / 2, this.containerHeight / 2, factor);
  }

  panBy(dx: number, dy: number): void {
    if (!this.isOpen || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.offsetX += dx;
    this.offsetY += dy;
    this.constrainOffset();
    this.render();
  }

  refreshLayout(): void {
    if (!this.isOpen) return;
    if (this.fitMode) {
      this.fit();
      return;
    }
    this.handleResize();
  }

  private adoptNaturalDimensions(width: number, height: number): void {
    if (width <= 0 || height <= 0 || (width === this.imageWidth && height === this.imageHeight)) return;
    if (this.fitMode) {
      this.imageWidth = width;
      this.imageHeight = height;
      this.fit();
      return;
    }
    const centerX = (this.containerWidth / 2 - this.offsetX) / (this.imageWidth * this.scale);
    const centerY = (this.containerHeight / 2 - this.offsetY) / (this.imageHeight * this.scale);
    this.imageWidth = width;
    this.imageHeight = height;
    this.offsetX = this.containerWidth / 2 - centerX * this.imageWidth * this.scale;
    this.offsetY = this.containerHeight / 2 - centerY * this.imageHeight * this.scale;
    this.constrainOffset();
    this.render();
  }

  private zoomAt(mouseX: number, mouseY: number, factor: number): void {
    const newScale = clamp(this.scale * factor, this.minScale, this.maxScale);
    if (Math.abs(newScale - this.scale) < 0.0001) return;
    const canvasX = (mouseX - this.offsetX) / this.scale;
    const canvasY = (mouseY - this.offsetY) / this.scale;
    this.scale = newScale;
    this.fitMode = false;
    this.offsetX = mouseX - canvasX * this.scale;
    this.offsetY = mouseY - canvasY * this.scale;
    this.constrainOffset();
    this.render();
  }

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    const viewportRect = this.viewport.getBoundingClientRect();
    const mouseX = event.clientX - viewportRect.left;
    const mouseY = event.clientY - viewportRect.top;
    this.zoomAt(mouseX, mouseY, event.deltaY > 0 ? 0.9 : 1.1);
  }

  private handleDoubleClick(event: MouseEvent): void {
    event.preventDefault();
    if (this.fitMode) this.oneToOne();
    else this.fit();
  }

  private handleMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const scaledWidth = this.imageWidth * this.scale;
    const scaledHeight = this.imageHeight * this.scale;
    if (scaledWidth <= this.containerWidth && scaledHeight <= this.containerHeight) return;
    this.isDragging = true;
    this.hasDragged = false;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.stage.style.cursor = "grabbing";
  }

  private handleMouseMove(event: MouseEvent): void {
    if (!this.isDragging) return;
    const deltaX = event.clientX - this.lastX;
    const deltaY = event.clientY - this.lastY;
    const totalDx = event.clientX - this.dragStartX;
    const totalDy = event.clientY - this.dragStartY;
    if (!this.hasDragged && (Math.abs(totalDx) > 3 || Math.abs(totalDy) > 3)) this.hasDragged = true;
    if (this.hasDragged) {
      this.offsetX += deltaX;
      this.offsetY += deltaY;
      this.constrainOffset();
      this.render();
    }
    this.lastX = event.clientX;
    this.lastY = event.clientY;
  }

  private handleMouseUp(): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.hasDragged = false;
    this.render();
  }

  private handleResize(): void {
    if (!this.isOpen) return;
    if (this.fitMode) {
      this.fit();
      return;
    }
    const oldWidth = this.containerWidth;
    const oldHeight = this.containerHeight;
    const centerX = (oldWidth / 2 - this.offsetX) / (this.imageWidth * this.scale);
    const centerY = (oldHeight / 2 - this.offsetY) / (this.imageHeight * this.scale);
    this.measureViewport();
    this.offsetX = this.containerWidth / 2 - centerX * this.imageWidth * this.scale;
    this.offsetY = this.containerHeight / 2 - centerY * this.imageHeight * this.scale;
    this.constrainOffset();
    this.render();
  }

  private constrainOffset(): void {
    const scaledWidth = this.imageWidth * this.scale;
    const scaledHeight = this.imageHeight * this.scale;
    const minOffsetX = this.containerWidth - scaledWidth;
    const maxOffsetX = 0;
    const minOffsetY = this.containerHeight - scaledHeight;
    const maxOffsetY = 0;
    if (scaledWidth < this.containerWidth) this.offsetX = (this.containerWidth - scaledWidth) / 2;
    else this.offsetX = Math.max(minOffsetX, Math.min(maxOffsetX, this.offsetX));
    if (scaledHeight < this.containerHeight) this.offsetY = (this.containerHeight - scaledHeight) / 2;
    else this.offsetY = Math.max(minOffsetY, Math.min(maxOffsetY, this.offsetY));
  }

  private render(): void {
    if (!this.isOpen) return;
    const scaledWidth = this.imageWidth * this.scale;
    const scaledHeight = this.imageHeight * this.scale;
    this.stage.style.width = `${scaledWidth}px`;
    this.stage.style.height = `${scaledHeight}px`;
    this.stage.style.left = `${this.offsetX}px`;
    this.stage.style.top = `${this.offsetY}px`;
    const zoomText = this.fitMode ? "FIT" : `${Math.round(this.scale * 100)}%`;
    this.zoomLevel.textContent = zoomText;
    const hudMode = optionalHtml("preview-hud-mode");
    if (hudMode) hudMode.textContent = zoomText;
    const canPan = scaledWidth > this.containerWidth || scaledHeight > this.containerHeight;
    this.stage.style.cursor = this.isDragging ? "grabbing" : (canPan ? "grab" : "default");
  }
}
