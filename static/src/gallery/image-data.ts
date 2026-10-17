import {
  isRecord,
  optionalNumber,
  stringArray,
  type JsonRecord,
} from '../shared/helpers';

export interface ImageItem {
  id: string;
  path: string;
  thumb_url?: string;
  tags?: string[];
  auto_tags?: string[];
  folder_tags?: string[];
  user_tags?: string[];
  width?: number;
  height?: number;
  aspect_ratio?: number;
  size?: number;
  mtime?: number;
}

export interface ImagePage {
  total?: unknown;
  next_cursor?: string | null;
  has_more?: boolean;
}

export function normalizeImageItem(value: unknown): ImageItem | null {
  if (!isRecord(value)) return null;
  const id = String(value.id || '');
  const path = String(value.path || '');
  if (!id || !path) return null;
  return {
    id,
    path,
    thumb_url: typeof value.thumb_url === 'string' ? value.thumb_url : undefined,
    tags: stringArray(value.tags),
    auto_tags: stringArray(value.auto_tags),
    folder_tags: stringArray(value.folder_tags),
    user_tags: stringArray(value.user_tags),
    width: optionalNumber(value.width),
    height: optionalNumber(value.height),
    aspect_ratio: optionalNumber(value.aspect_ratio),
    size: optionalNumber(value.size),
    mtime: optionalNumber(value.mtime),
  };
}

export function imageArray(value: unknown): ImageItem[] {
  return Array.isArray(value)
    ? value.map(normalizeImageItem).filter((item): item is ImageItem => Boolean(item))
    : [];
}

export function imagesFromRecord(value: JsonRecord): ImageItem[] {
  const items = imageArray(value.items);
  return items.length || Array.isArray(value.items) ? items : imageArray(value.images);
}

export function imagePage(value: unknown): ImagePage | null {
  if (!isRecord(value)) return null;
  return {
    total: value.total,
    next_cursor: typeof value.next_cursor === 'string' ? value.next_cursor : null,
    has_more: Boolean(value.has_more),
  };
}

export function pageTotalValue(page: ImagePage | null | undefined): number | null {
  if (!page || page.total === null || page.total === undefined || page.total === '') return null;
  const total = Number(page.total);
  return Number.isFinite(total) ? total : null;
}

export function mergeRefreshedPageIntoLoadedImages(
  existing: ImageItem[],
  refreshedPage: ImageItem[],
): ImageItem[] {
  if (!existing.length) return refreshedPage.slice();
  if (!refreshedPage.length) return existing.slice();

  const refreshedById = new Map(refreshedPage.map(img => [img.id, img]));
  const retained = existing
    .map(img => refreshedById.get(img.id) || img)
    .filter(img => !refreshedById.has(img.id));

  return [...refreshedPage, ...retained];
}
