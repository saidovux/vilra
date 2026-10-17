export interface ImageAspectSource {
  width?: number;
  height?: number;
  aspect_ratio?: number;
}

export interface GalleryGeometry {
  width: number;
  gap: number;
  laneCount: number;
  laneWidth: number;
  borderWidth: number;
  scrollMargin: number;
}

export type GalleryScrollDirection = 'forward' | 'backward' | null;

export interface VirtualRangeItem {
  start: number;
  end: number;
}

export interface VirtualCardItem extends VirtualRangeItem {
  index: number;
  lane: number;
  size: number;
}

export interface VirtualCardLayout {
  index: number;
  lane: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface GalleryGeometryInput {
  galleryWidth: number;
  viewportWidth: number;
  gap: number;
  scrollMargin: number;
}

export interface GalleryViewport {
  scrollY: number;
  height: number;
}

const MASONRY_COL_MIN = 218;
const CARD_BORDER_WIDTH = 1;
const SINGLE_LANE_MAX_WIDTH = 720;
const THUMB_NEAR_LOOKAHEAD_MIN_PX = 480;
const THUMB_NEAR_LOOKAHEAD_VIEWPORTS = 0.75;

export function aspectCss(image: ImageAspectSource): string {
  const width = Number(image.width || 0);
  const height = Number(image.height || 0);
  if (width > 0 && height > 0) return `${width} / ${height}`;
  const ratio = Number(image.aspect_ratio || 1);
  return `${Math.max(1, Math.round(ratio * 1000))} / 1000`;
}

export function imageAspectRatio(image: ImageAspectSource): number {
  const width = Number(image.width || 0);
  const height = Number(image.height || 0);
  if (width > 0 && height > 0) return width / height;
  const ratio = Number(image.aspect_ratio || 1);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export function computeGalleryGeometry(input: GalleryGeometryInput): GalleryGeometry {
  const width = Math.max(1, input.galleryWidth || input.viewportWidth || MASONRY_COL_MIN);
  const laneCount = width < SINGLE_LANE_MAX_WIDTH
    ? 1
    : Math.max(1, Math.floor((width + input.gap) / (MASONRY_COL_MIN + input.gap)));
  const laneWidth = (width - input.gap * (laneCount - 1)) / laneCount;
  return {
    width,
    gap: input.gap,
    laneCount,
    laneWidth,
    borderWidth: CARD_BORDER_WIDTH,
    scrollMargin: input.scrollMargin,
  };
}

export function estimateVirtualCardSize(
  image: ImageAspectSource | undefined,
  geometry: GalleryGeometry,
): number {
  if (!image) return MASONRY_COL_MIN;
  const contentWidth = Math.max(1, geometry.laneWidth - geometry.borderWidth * 2);
  return contentWidth / imageAspectRatio(image) + geometry.borderWidth * 2;
}

export function virtualItemIsVisible(
  item: VirtualRangeItem,
  geometry: GalleryGeometry,
  viewport: GalleryViewport,
): boolean {
  const viewportStart = viewport.scrollY - geometry.scrollMargin;
  const viewportEnd = viewportStart + viewport.height;
  const itemStart = item.start - geometry.scrollMargin;
  return item.end - geometry.scrollMargin >= viewportStart && itemStart <= viewportEnd;
}

export function virtualItemIsNear(
  item: VirtualRangeItem,
  geometry: GalleryGeometry,
  direction: GalleryScrollDirection,
  viewport: GalleryViewport,
): boolean {
  const viewportStart = viewport.scrollY - geometry.scrollMargin;
  const viewportEnd = viewportStart + viewport.height;
  const itemStart = item.start - geometry.scrollMargin;
  const itemEnd = item.end - geometry.scrollMargin;
  const distance = Math.max(
    THUMB_NEAR_LOOKAHEAD_MIN_PX,
    viewport.height * THUMB_NEAR_LOOKAHEAD_VIEWPORTS,
  );
  if (direction === 'backward') {
    return itemEnd < viewportStart && viewportStart - itemEnd <= distance;
  }
  return itemStart > viewportEnd && itemStart - viewportEnd <= distance;
}

export function calculateVirtualCardLayout(
  item: VirtualCardItem,
  geometry: GalleryGeometry,
): VirtualCardLayout {
  return {
    index: item.index,
    lane: item.lane,
    width: geometry.laneWidth,
    height: item.size,
    x: item.lane * (geometry.laneWidth + geometry.gap),
    y: item.start - geometry.scrollMargin,
  };
}
