import type {VirtualItem, Virtualizer} from '@tanstack/virtual-core';

import type {DiagnosticCardRef} from '../gallery-diagnostics';
import {
  calculateVirtualCardLayout,
  virtualItemIsVisible,
  type GalleryGeometry,
} from './geometry';
import type {ImageItem} from './image-data';

export interface MountedGalleryCard {
  slot: HTMLDivElement;
  card: HTMLElement;
  signature: string;
}

interface VirtualGalleryDiagnostics {
  readonly recording: boolean;
  cardMounted(key: string, index: number, alreadyReady?: boolean): DiagnosticCardRef | null;
  cardUnmounted(ref: DiagnosticCardRef | null): void;
  cardVisible(ref: DiagnosticCardRef | null, index: number, ready: boolean): void;
  virtualRange(maximumMountedIndex: number, maximumVisibleIndex: number, mountedCards: number): void;
  measureRenderRange(durationMs: number): void;
}

interface VirtualGalleryViewDependencies {
  getContainer(): HTMLElement;
  makeCard(
    image: ImageItem,
    highPriority: boolean,
    diagnosticRef: DiagnosticCardRef | null,
  ): HTMLElement;
  clearThumbnailLifecycle(imageId: string, card: HTMLElement): void;
  diagnosticCardRef(image: HTMLImageElement | null): DiagnosticCardRef | null;
  diagnostics: VirtualGalleryDiagnostics;
}

function cardRenderSignature(image: ImageItem): string {
  return JSON.stringify([
    image.path,
    image.thumb_url || '',
    Number(image.mtime || 0),
    Number(image.width || 0),
    Number(image.height || 0),
    image.auto_tags || image.folder_tags || [],
    image.user_tags || [],
  ]);
}

export class VirtualGalleryView {
  private readonly mountedCards = new Map<string, MountedGalleryCard>();

  constructor(private readonly dependencies: VirtualGalleryViewDependencies) {}

  getMounted(imageId: string): MountedGalleryCard | undefined {
    return this.mountedCards.get(imageId);
  }

  forEachMounted(
    callback: (mounted: MountedGalleryCard, imageId: string) => void,
  ): void {
    this.mountedCards.forEach((mounted, imageId) => callback(mounted, imageId));
  }

  clear(): void {
    [...this.mountedCards.keys()].forEach(imageId => this.unmount(imageId));
  }

  render(
    instance: Virtualizer<Window, HTMLDivElement>,
    geometry: GalleryGeometry,
    images: readonly ImageItem[],
  ): void {
    const diagnosticsRecording = this.dependencies.diagnostics.recording;
    const diagnosticStartedAt = diagnosticsRecording ? performance.now() : 0;
    const gallery = this.dependencies.getContainer();
    const virtualItems = instance.getVirtualItems();
    const viewport = {scrollY: window.scrollY, height: window.innerHeight};
    const desiredIds = new Set<string>();
    let maximumMountedIndex = -1;
    let maximumVisibleIndex = -1;
    gallery.style.height = `${Math.max(0, instance.getTotalSize())}px`;

    for (const item of virtualItems) {
      const image = images[item.index];
      if (!image) continue;
      desiredIds.add(image.id);
      const signature = cardRenderSignature(image);
      let mounted = this.mountedCards.get(image.id);
      const visible = diagnosticsRecording || !mounted || mounted.signature !== signature
        ? virtualItemIsVisible(item, geometry, viewport)
        : false;
      if (diagnosticsRecording) {
        maximumMountedIndex = Math.max(maximumMountedIndex, item.index);
        if (visible) maximumVisibleIndex = Math.max(maximumVisibleIndex, item.index);
      }
      if (!mounted) {
        mounted = this.mount(item.index, image, visible, gallery);
      } else if (mounted.signature !== signature) {
        this.dependencies.diagnostics.cardUnmounted(
          this.dependencies.diagnosticCardRef(
            mounted.card.querySelector<HTMLImageElement>('img'),
          ),
        );
        this.dependencies.clearThumbnailLifecycle(image.id, mounted.card);
        const diagnosticRef = this.dependencies.diagnostics.cardMounted(image.id, item.index);
        const card = this.dependencies.makeCard(image, visible, diagnosticRef);
        mounted.slot.replaceChildren(card);
        mounted.card = card;
        mounted.signature = signature;
      }
      this.position(mounted, item, geometry);
      const cardImage = diagnosticsRecording
        ? mounted.card.querySelector<HTMLImageElement>('img')
        : null;
      if (diagnosticsRecording && visible) {
        this.dependencies.diagnostics.cardVisible(
          this.dependencies.diagnosticCardRef(cardImage),
          item.index,
          Boolean(cardImage?.complete && cardImage.naturalWidth > 0),
        );
      }
    }

    for (const imageId of [...this.mountedCards.keys()]) {
      if (!desiredIds.has(imageId)) this.unmount(imageId);
    }
    if (diagnosticsRecording) {
      this.dependencies.diagnostics.virtualRange(
        maximumMountedIndex,
        maximumVisibleIndex,
        this.mountedCards.size,
      );
    }
    instance._willUpdate();
    if (diagnosticsRecording) {
      this.dependencies.diagnostics.measureRenderRange(performance.now() - diagnosticStartedAt);
    }
  }

  private mount(
    index: number,
    image: ImageItem,
    visible: boolean,
    gallery: HTMLElement,
  ): MountedGalleryCard {
    const slot = document.createElement('div');
    slot.className = 'virtual-card-slot';
    slot.dataset.id = image.id;
    const diagnosticRef = this.dependencies.diagnostics.cardMounted(image.id, index);
    const card = this.dependencies.makeCard(image, visible, diagnosticRef);
    slot.appendChild(card);
    gallery.appendChild(slot);
    const mounted = {slot, card, signature: cardRenderSignature(image)};
    this.mountedCards.set(image.id, mounted);
    return mounted;
  }

  private position(
    mounted: MountedGalleryCard,
    item: VirtualItem,
    geometry: GalleryGeometry,
  ): void {
    const layout = calculateVirtualCardLayout(item, geometry);
    mounted.slot.dataset.index = String(layout.index);
    mounted.slot.dataset.lane = String(layout.lane);
    mounted.slot.style.width = `${layout.width}px`;
    mounted.slot.style.height = `${layout.height}px`;
    mounted.slot.style.transform = `translate(${layout.x}px, ${layout.y}px)`;
  }

  private unmount(imageId: string): void {
    const mounted = this.mountedCards.get(imageId);
    if (!mounted) return;
    this.dependencies.diagnostics.cardUnmounted(
      this.dependencies.diagnosticCardRef(
        mounted.card.querySelector<HTMLImageElement>('img'),
      ),
    );
    this.dependencies.clearThumbnailLifecycle(imageId, mounted.card);
    mounted.slot.remove();
    this.mountedCards.delete(imageId);
  }
}
