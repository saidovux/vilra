import {
  Virtualizer,
  observeWindowOffset,
  observeWindowRect,
  windowScroll,
  type VirtualizerOptions,
} from '@tanstack/virtual-core';

import {estimateVirtualCardSize, type GalleryGeometry} from './geometry';
import type {ImageItem} from './image-data';

export type GalleryVirtualizer = Virtualizer<Window, HTMLDivElement>;

interface GalleryVirtualizerControllerDependencies {
  getImages(): readonly ImageItem[];
  onChange(instance: GalleryVirtualizer, sync: boolean): void;
}

const GALLERY_OVERSCAN = 20;

export class GalleryVirtualizerController {
  private instance: GalleryVirtualizer | null = null;
  private cleanup: (() => void) | null = null;

  constructor(private readonly dependencies: GalleryVirtualizerControllerDependencies) {}

  get current(): GalleryVirtualizer | null {
    return this.instance;
  }

  ensure(geometry: GalleryGeometry): GalleryVirtualizer {
    if (!this.instance) {
      this.instance = new Virtualizer<Window, HTMLDivElement>(this.options(geometry));
      this.cleanup = this.instance._didMount();
    } else {
      this.instance.setOptions(this.options(geometry));
    }
    this.instance._willUpdate();
    return this.instance;
  }

  setOptions(geometry: GalleryGeometry): void {
    this.instance?.setOptions(this.options(geometry));
  }

  willUpdate(): void {
    this.instance?._willUpdate();
  }

  private options(geometry: GalleryGeometry): VirtualizerOptions<Window, HTMLDivElement> {
    return {
      count: this.dependencies.getImages().length,
      getScrollElement: () => window,
      estimateSize: index => estimateVirtualCardSize(this.dependencies.getImages()[index], geometry),
      getItemKey: index => this.dependencies.getImages()[index]?.id || `missing-${index}`,
      scrollToFn: windowScroll,
      observeElementRect: observeWindowRect,
      observeElementOffset: observeWindowOffset,
      onChange: this.dependencies.onChange,
      lanes: geometry.laneCount,
      laneAssignmentMode: 'estimate',
      gap: geometry.gap,
      overscan: GALLERY_OVERSCAN,
      scrollMargin: geometry.scrollMargin,
    };
  }
}
