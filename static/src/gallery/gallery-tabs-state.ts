import {
  DEFAULT_SORT_MODE,
  makeDefaultTab,
  SORT_MODES,
  type GalleryTab,
} from './gallery-tab-model';

export class GalleryTabsState {
  private tabs: GalleryTab[] = [];
  private activeTabId: string | null = null;

  get list(): readonly GalleryTab[] {
    return this.tabs;
  }

  get activeId(): string | null {
    return this.activeTabId;
  }

  current(): GalleryTab {
    if (!this.tabs.length) {
      const tab = makeDefaultTab();
      this.tabs = [tab];
      this.activeTabId = tab.id;
    }
    let tab = this.tabs.find(item => item.id === this.activeTabId);
    if (!tab) {
      tab = this.tabs[0];
      this.activeTabId = tab.id;
    }
    tab.includeTags = Array.isArray(tab.includeTags) ? tab.includeTags : [];
    tab.excludeTags = Array.isArray(tab.excludeTags) ? tab.excludeTags : [];
    tab.matchMode = tab.matchMode === 'all' ? 'all' : 'any';
    tab.sortMode = SORT_MODES.includes(tab.sortMode) ? tab.sortMode : DEFAULT_SORT_MODE;
    return tab;
  }

  add(): GalleryTab {
    const tab = makeDefaultTab();
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    return tab;
  }

  select(id: string): void {
    this.activeTabId = id;
  }

  close(id: string): void {
    if (this.tabs.length <= 1) {
      this.reset();
    } else {
      const idx = this.tabs.findIndex(tab => tab.id === id);
      this.tabs = this.tabs.filter(tab => tab.id !== id);
      if (this.activeTabId === id) {
        const next = this.tabs[Math.max(0, idx - 1)] || this.tabs[0];
        this.activeTabId = next.id;
      }
    }
  }

  restore(tabs: GalleryTab[], activeId: string | null): void {
    const first = tabs[0];
    if (!first) throw new Error('GalleryTabsState.restore requires at least one tab');
    this.tabs = tabs;
    this.activeTabId = activeId && tabs.some(tab => tab.id === activeId) ? activeId : first.id;
  }

  reset(): void {
    const tab = makeDefaultTab();
    this.tabs = [tab];
    this.activeTabId = tab.id;
  }
}
