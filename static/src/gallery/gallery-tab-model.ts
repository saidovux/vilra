import {isRecord, type JsonRecord} from '../shared/helpers';
import {type MatchMode, type SortMode} from './image-query';

export interface GalleryTab {
  id: string;
  title: string;
  includeTags: string[];
  excludeTags: string[];
  matchMode: MatchMode;
  sortMode: SortMode;
  lastImageId: string | null;
  scrollTop: number;
}

type DedupeDisplayTags = (tags: unknown) => string[];

export const SORT_MODES: SortMode[] = ['path_asc', 'path_desc', 'date_desc', 'date_asc', 'size_desc', 'size_asc'];
export const DEFAULT_SORT_MODE: SortMode = 'date_desc';

export function isSortMode(mode: string | undefined): mode is SortMode {
  return Boolean(mode && SORT_MODES.includes(mode as SortMode));
}

export function makeDefaultTab(title = "Все фото"): GalleryTab {
  const id = "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  return { id, title, includeTags: [], excludeTags: [], matchMode: "any", sortMode: DEFAULT_SORT_MODE, lastImageId: null, scrollTop: 0 };
}

export function normalizeTabs(
  rawTabs: unknown,
  session: JsonRecord,
  dedupeDisplayTags: DedupeDisplayTags,
): GalleryTab[] {
  if (Array.isArray(rawTabs) && rawTabs.length) {
    const normalized: GalleryTab[] = rawTabs.filter(isRecord).map((tab, i) => {
      const sortMode = String(tab.sortMode || tab.sort_mode || '');
      return {
        id: String(tab.id || `tab-${i}`),
        title: String(tab.title || 'Все фото'),
        includeTags: dedupeDisplayTags(tab.includeTags || tab.include_tags || []),
        excludeTags: dedupeDisplayTags(tab.excludeTags || tab.exclude_tags || []),
        matchMode: tab.matchMode === 'all' || tab.match_mode === 'all' ? 'all' : 'any',
        sortMode: isSortMode(sortMode) ? sortMode : DEFAULT_SORT_MODE,
        lastImageId: tab.lastImageId || tab.last_image_id ? String(tab.lastImageId || tab.last_image_id) : null,
        scrollTop: Number(tab.scrollTop || tab.scroll_top || 0)
      };
    });
    if (normalized.length) return normalized;
  }
  const tab = makeDefaultTab();
  tab.includeTags = dedupeDisplayTags(session.search_tags || []);
  tab.matchMode = session.search_mode === 'all' ? 'all' : 'any';
  tab.sortMode = DEFAULT_SORT_MODE;
  tab.lastImageId = session.last_image_id ? String(session.last_image_id) : null;
  updateTabTitle(tab);
  return [tab];
}

export function updateTabTitle(tab: GalleryTab): void {
  const include = tab.includeTags || [];
  const exclude = tab.excludeTags || [];
  if (!include.length && !exclude.length) {
    tab.title = "Все фото";
    return;
  }
  const parts: string[] = [];
  if (include.length) parts.push((tab.matchMode === "all" ? "все " : "любой ") + include.join(tab.matchMode === "all" ? " + " : " / "));
  if (exclude.length) parts.push("без " + exclude.join(", "));
  tab.title = parts.join(" / ").slice(0, 80);
}

export function serializeGallerySession(
  tabs: GalleryTab[],
  activeTabId: string | null,
  activeTab: GalleryTab,
) {
  return {
    tabs: tabs.map(item => ({
      id: item.id,
      title: item.title,
      includeTags: item.includeTags || [],
      excludeTags: item.excludeTags || [],
      matchMode: item.matchMode === 'all' ? 'all' : 'any',
      sortMode: isSortMode(item.sortMode) ? item.sortMode : DEFAULT_SORT_MODE,
      lastImageId: item.lastImageId || null,
      scrollTop: item.scrollTop || 0
    })),
    active_tab_id: activeTabId,
    search_tags: activeTab.includeTags || [],
    last_image_id: activeTab.lastImageId || null
  };
}
