import {
  type VirtualItem,
  type Virtualizer,
} from '@tanstack/virtual-core';
import {
  galleryDiagnostics,
  type DiagnosticCardRef,
  type DiagnosticPageOutcome,
} from './gallery-diagnostics';
import {
  type GalleryArrowDirection,
  isDesktopRuntime,
  openOriginalNative,
  pickFolderNative,
  revealImageNative,
  sendGalleryArrowInputNative,
} from './desktop-runtime';
import {
  errorMessage,
  escHtml,
  fileName,
  fmtSize,
  isRecord,
  optionalNumber,
  optionalElement,
  optionalHtml,
  readError,
  readJsonRecord,
  requireElement,
  stringArray,
  type JsonRecord,
} from './shared/helpers';
import {
  imagePage,
  imagesFromRecord,
  mergeRefreshedPageIntoLoadedImages,
  normalizeImageItem,
  pageTotalValue,
  type ImageItem,
  type ImagePage,
} from './gallery/image-data';
import {buildImageQueryParams} from './gallery/image-query';
import {
  DEFAULT_SORT_MODE,
  isSortMode,
  normalizeTabs,
  serializeGallerySession,
  updateTabTitle,
  type GalleryTab,
} from './gallery/gallery-tab-model';
import {GalleryTabsState} from './gallery/gallery-tabs-state';
import {
  aspectCss,
  computeGalleryGeometry,
  virtualItemIsNear,
  virtualItemIsVisible,
  type GalleryGeometry,
  type GalleryScrollDirection,
} from './gallery/geometry';
import {
  decodeCurrentThumbnail,
  ThumbnailLifecycleManager,
  type ThumbLifecycle,
} from './gallery/thumbnail-lifecycle';
import {LiveTotalReconciler} from './gallery/live-total-reconciler';
import {VirtualGalleryView} from './gallery/virtual-gallery-view';
import {GalleryVirtualizerController} from './gallery/virtualizer-controller';
import {ProblemsWorkspace} from './problems/problems-workspace';
import {
  dedupeDisplayTags,
  normalizeTag,
  splitTagPrefix,
  TagCatalog,
  tagName,
  type TagMeta,
} from './tags/tag-catalog';
import {ViewerCoordinator} from './viewer/preview-coordinator';
import {PreviewModal} from './viewer/preview-modal';

type SettingsTab = 'general' | 'tags' | 'problems';
type AppWorkspace = 'gallery' | 'settings';
type GalleryContentState = 'no_library' | 'no_images' | 'filtered_empty' | 'load_error' | 'content';
type GalleryRetryKind = 'session' | 'images';
type NotificationKind = 'status' | 'success' | 'warning' | 'error';
type TagCatalogRefreshResult = 'updated' | 'stale' | 'failed';
type ShortcutContext = 'gallery' | 'viewer' | 'settings' | 'blocked';
type AppCommand =
  | 'ui.consumeShortcut'
  | 'ui.toggleFocus'
  | 'ui.toggleSidePanel'
  | 'gallery.newTab'
  | 'gallery.closeTab'
  | 'gallery.focusTagSearch'
  | 'gallery.moveDown'
  | 'gallery.moveUp'
  | 'viewer.panLeft'
  | 'viewer.panDown'
  | 'viewer.panUp'
  | 'viewer.panRight'
  | 'viewer.zoomIn'
  | 'viewer.zoomOut'
  | 'viewer.nextImage'
  | 'viewer.previousImage'
  | 'viewer.fit'
  | 'viewer.actualSize'
  | 'viewer.quickMenu'
  | 'viewer.focusTagInput'
  | 'viewer.close'
  | 'settings.close';
type TagAdminSort = 'name' | 'image_count' | 'user_count' | 'auto_count';
type TagKind = 'include' | 'exclude';
interface StatusResponse {
  db_ready?: boolean;
  db_error?: string;
  root_paths?: string[];
  root?: string;
  running?: boolean;
  queued?: boolean;
  done?: number;
  total?: number;
  error?: string;
}

interface ThumbnailScrollState {
  offset: number | null;
  sampledAt: number | null;
  velocity: number;
  direction: GalleryScrollDirection;
  scrolling: boolean;
  fast: boolean;
  fastSamples: number;
  slowSamples: number;
}

interface LiveEventEnvelope {
  sequence?: number;
  type: string;
  data: JsonRecord;
}

interface FishController {
  suggestion: string;
  update?: () => void;
}

interface GalleryLoadFailure {
  message: string;
  retry: GalleryRetryKind;
}

interface NotificationOptions {
  actionLabel?: string;
  action?: () => void | Promise<void>;
  key?: string;
  persistent?: boolean;
}

interface TagChipOptions {
  auto?: boolean;
  className?: string;
  count?: boolean;
  exclude?: boolean;
  removable?: boolean;
  actionKind?: 'include' | 'exclude' | '';
}

function requiredHtml(id: string): HTMLElement {
  return requireElement(id, HTMLElement, "Required page element is missing");
}

function requiredInput(id: string): HTMLInputElement {
  return requireElement(id, HTMLInputElement, "Required input is missing");
}

function optionalInput(id: string): HTMLInputElement | null {
  return optionalElement(id, HTMLInputElement);
}

function requiredAnchor(id: string): HTMLAnchorElement {
  return requireElement(id, HTMLAnchorElement, "Required link is missing");
}

function statusResponse(value: JsonRecord): StatusResponse {
  return {
    db_ready: Boolean(value.db_ready),
    db_error: typeof value.db_error === 'string' ? value.db_error : undefined,
    root_paths: stringArray(value.root_paths),
    root: typeof value.root === 'string' ? value.root : undefined,
    running: Boolean(value.running),
    queued: Boolean(value.queued),
    done: optionalNumber(value.done),
    total: optionalNumber(value.total),
    error: typeof value.error === 'string' ? value.error : undefined
  };
}

function normalizeTagKind(kind: string | undefined): TagKind {
  return kind === 'exclude' ? 'exclude' : 'include';
}

function actionValue(el: HTMLElement): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  return undefined;
}

function eventTargetElement(event: Event): HTMLElement | null {
  return event.target instanceof HTMLElement ? event.target : null;
}

function closestFromEvent(event: Event, selector: string): HTMLElement | null {
  return eventTargetElement(event)?.closest(selector) as HTMLElement | null;
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    || target.isContentEditable
    || Boolean(target.closest('[contenteditable]:not([contenteditable="false"])'));
}

let allImages: ImageItem[] = [];
let visibleImages: ImageItem[] = [];
let scannedRoots: string[] = [];
let libraryStateRevision = 0;
const disconnectingRoots = new Set<string>();
let folderTagSync = true;
const galleryTabs = new GalleryTabsState();
const tagCatalog = new TagCatalog();
let statusInterval: ReturnType<typeof setInterval> | null = null;
let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let serverTotal = 0;
let serverTotalKnown = false;
let nextCursor: string | null = null;
let hasMorePages = false;
let isLoadingPage = false;
let activeImagesRequest = 0;
let activeSessionRequest = 0;
let galleryRequestPending = false;
let sessionRequestPending = false;
let galleryLoadFailure: GalleryLoadFailure | null = null;
let galleryGeometry: GalleryGeometry | null = null;
let galleryResizeFrame: number | null = null;
let paginationPrefetchFrame: number | null = null;
let pendingGalleryScrollTop: number | null = null;
let activePageLoad: {requestId: number; promise: Promise<void>} | null = null;
let previewModal: PreviewModal | null = null;
let viewerCoordinator: ViewerCoordinator;
let pendingGalleryAnchorImageId: string | null = null;
let galleryFocusMode = false;
let gallerySidebarVisible = true;
let gallerySidebarBeforeFocus = true;
let gallerySidebarChangedDuringFocus = false;
const selectedImageIds = new Set<string>();
let batchTagPanelOpen = false;
let batchTagSubmitting = false;
let batchTagAdditions: string[] = [];
let batchTagRemovals: string[] = [];
let batchTagStatus = '';
let batchTagStatusIsError = false;
let latestStatus: StatusResponse | null = null;
let filterSuggestionOpen = false;
let settingsActiveTab: SettingsTab = 'general';
let tagAdminSort: TagAdminSort = 'name';
let liveEventSource: EventSource | null = null;
let lastLiveSequence = 0;
let liveRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let liveFolderRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let liveTagRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let tagCatalogRevision = 0;
let activeWorkspace: AppWorkspace = 'gallery';
const tagSavesInFlight = new Set<string>();
let notificationAction: (() => void | Promise<void>) | null = null;
let notificationKey = '';
let notificationTimer: ReturnType<typeof setTimeout> | null = null;
const problemsWorkspace = new ProblemsWorkspace({
  isProblemsActive: () => activeWorkspace === 'settings' && settingsActiveTab === 'problems',
});
const terminalThumbIds = new Set<string>();
const thumbnailScrollState: ThumbnailScrollState = {
  offset: null,
  sampledAt: null,
  velocity: 0,
  direction: null,
  scrolling: false,
  fast: false,
  fastSamples: 0,
  slowSamples: 0,
};
let thumbnailAdmissionFrame: number | null = null;
let thumbnailScrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
let terminalGalleryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const forwardedGalleryArrowDirections = new Set<GalleryArrowDirection>();
const PAGE = 48;
const GALLERY_BROWSER_ARROW_STEP = 96;
const VIEWER_KEYBOARD_PAN_STEP = 80;
const THUMB_VELOCITY_EMA_ALPHA = 0.35;
const THUMB_FAST_ENTER_THRESHOLD = 1.25;
const THUMB_FAST_EXIT_THRESHOLD = 0.55;
const THUMB_FAST_ENTER_SAMPLES = 2;
const THUMB_FAST_EXIT_SAMPLES = 2;
const THUMB_SCROLL_SAMPLE_MAX_MS = 250;
const THUMB_SCROLL_SETTLE_FALLBACK_MS = 180;
const thumbnailLifecycles = new ThumbnailLifecycleManager({
  isTerminal: imageId => terminalThumbIds.has(imageId),
  onTerminalUnavailable: handleTerminalImageUnavailable,
  scheduleAdmissionEvaluation: scheduleThumbnailAdmissionEvaluation,
  diagnosticRef: diagnosticCardRef,
  diagnostics: galleryDiagnostics,
});
const virtualGalleryView = new VirtualGalleryView({
  getContainer: () => requiredHtml('gallery'),
  makeCard,
  clearThumbnailLifecycle: (imageId, card) => thumbnailLifecycles.clear(imageId, card),
  diagnosticCardRef,
  diagnostics: galleryDiagnostics,
});
const galleryVirtualizerController = new GalleryVirtualizerController({
  getImages: () => visibleImages,
  onChange: handleGalleryVirtualizerChange,
});
const liveTotalReconciler = new LiveTotalReconciler({
  getActiveRequestId: () => activeImagesRequest,
  buildCountQueryParams: buildLiveTotalQueryParams,
  applyCanonicalTotal: total => {
    serverTotalKnown = true;
    serverTotal = total;
    updateImageCounter();
  },
});

function activeTab(): GalleryTab {
  return galleryTabs.current();
}

function dismissNotification(key = ''): void {
  if (key && notificationKey !== key) return;
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = null;
  notificationAction = null;
  notificationKey = '';
  const notification = optionalHtml('app-notification');
  if (notification) notification.hidden = true;
}

function showNotification(
  message: string,
  kind: NotificationKind = 'status',
  options: NotificationOptions = {},
): void {
  const notification = requiredHtml('app-notification');
  const messageNode = requiredHtml('app-notification-message');
  const actionButton = requireElement(
    'app-notification-action',
    HTMLButtonElement,
    'Notification action is missing',
  );
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = null;
  notificationAction = options.action || null;
  notificationKey = options.key || '';
  messageNode.textContent = message;
  notification.classList.remove('status', 'success', 'warning', 'error');
  notification.classList.add(kind);
  notification.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  actionButton.hidden = !options.actionLabel || !notificationAction;
  actionButton.textContent = options.actionLabel || '';
  notification.hidden = false;
  if (!options.persistent && kind !== 'error' && kind !== 'warning') {
    notificationTimer = setTimeout(() => dismissNotification(options.key), 4_000);
  }
}

function runNotificationAction(): void {
  const action = notificationAction;
  dismissNotification();
  if (action) void action();
}

function setFolderInputValues(path: string): void {
  ['setup-folder', 'folder-input'].forEach(id => {
    const input = optionalInput(id);
    if (input) input.value = path || '';
  });
}

function getFolderInputValue(): string {
  const setupInput = optionalInput('setup-folder');
  const folderInput = optionalInput('folder-input');
  return String((folderInput && folderInput.value) || (setupInput && setupInput.value) || '').trim();
}

function promptFolderPath(message: string): string {
  const typed = window.prompt(`${message}\n\nВведите путь к папке вручную:`);
  return String(typed || '').trim();
}

async function openFolder(pathOverride = '') {
  const p = String(pathOverride || getFolderInputValue()).trim();
  if (!p) return alert('Введите путь к папке');
  try {
    const r = await fetch('/api/folder', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: p})
    });
    if (!r.ok) throw new Error(await readError(r));
    const data = await readJsonRecord(r);
    setFolderInputValues(p);
    if (Array.isArray(data.root_paths)) {
      libraryStateRevision += 1;
      scannedRoots = stringArray(data.root_paths);
    }
    galleryLoadFailure = null;
    showGallery();
    renderTabs();
    renderFilterControls();
    startStatusPolling();
    await refreshImages(true);
    await refreshFolderTree();
    saveSessionSoon();
  } catch (e) {
    showNotification('Не удалось добавить библиотеку: ' + errorMessage(e), 'error', {
      key: 'library-open',
      persistent: true,
    });
  }
}

async function pickFolder() {
  try {
    if (isDesktopRuntime()) {
      const path = await pickFolderNative(getFolderInputValue());
      if (path) {
        setFolderInputValues(path);
        await openFolder(path);
      }
      return;
    }

    const r = await fetch('/api/folder/pick', {method: 'POST'});
    if (!r.ok) {
      const manualPath = promptFolderPath(await readError(r));
      if (manualPath) await openFolder(manualPath);
      return;
    }
    const data = await readJsonRecord(r);
    if (data.manual) {
      const manualPath = promptFolderPath(String(data.message || 'Нативный выбор папки недоступен.'));
      if (manualPath) await openFolder(manualPath);
      return;
    }
    if (data.cancelled || !data.path) return;
    const path = String(data.path);
    setFolderInputValues(path);
    await openFolder(path);
  } catch (e) {
    if (isDesktopRuntime()) {
      alert('Не удалось открыть проводник: ' + errorMessage(e));
      return;
    }
    const manualPath = promptFolderPath('Не удалось открыть выбор папки: ' + errorMessage(e));
    if (manualPath) await openFolder(manualPath);
  }
}

async function refreshFolderTree() {
  const revision = libraryStateRevision;
  try {
    const r = await fetch('/api/folders');
    if (!r.ok) return;
    const data = await readJsonRecord(r);
    if (revision !== libraryStateRevision) return;
    const roots = stringArray(data.roots);
    scannedRoots = roots;
    renderFolderTree();
    updateRootSummary();
    updateEmptyStateMessage();
  } catch {}
}

async function disconnectFolder(root: string): Promise<void> {
  if (!root || disconnectingRoots.has(root)) return;
  if (!window.confirm('Убрать папку из Vilra? Файлы на диске не будут удалены')) return;
  disconnectingRoots.add(root);
  renderFolderTree();
  try {
    const response = await fetch('/api/folders', {
      method: 'DELETE',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: root}),
    });
    if (!response.ok) throw new Error(await readError(response));
    const data = await readJsonRecord(response);
    libraryStateRevision += 1;
    scannedRoots = stringArray(data.root_paths);
    galleryLoadFailure = null;
    setFolderInputValues(typeof data.root === 'string' ? data.root : '');
    viewerCoordinator.suppressRestoreFromActiveTab();
    viewerCoordinator.close(false, false);
    clearImageSelection();
    renderFolderTree();
    updateRootSummary();
    updateEmptyStateMessage();
    showGallery();
    await refreshImages(true);
    await refreshFolderTree();
    problemsWorkspace.scheduleRefresh();
    await pollStatus();
  } catch (error) {
    alert('Не удалось отключить библиотеку: ' + errorMessage(error));
    libraryStateRevision += 1;
    await refreshFolderTree();
    await refreshImages(true);
  } finally {
    disconnectingRoots.delete(root);
    renderFolderTree();
  }
}

function renderGalleryUiState(): void {
  const screen = requiredHtml('gallery-screen');
  const sidebar = requiredHtml('folder-sidebar');
  const focusButton = optionalHtml('gallery-focus-toggle');
  const sidebarButton = optionalHtml('folder-sidebar-toggle');
  screen.classList.toggle('gallery-focus-mode', galleryFocusMode);
  sidebar.classList.toggle('collapsed', !gallerySidebarVisible);
  if (focusButton) {
    focusButton.classList.toggle('active', galleryFocusMode);
    focusButton.setAttribute('aria-pressed', galleryFocusMode ? 'true' : 'false');
  }
  sidebarButton?.setAttribute('aria-expanded', gallerySidebarVisible ? 'true' : 'false');
}

function updateGalleryUiState(mutator: () => void): void {
  const anchor = captureGalleryAnchor();
  mutator();
  renderGalleryUiState();
  scheduleGalleryResize(anchor);
}

function toggleFolderSidebar(force?: boolean, explicit = true): void {
  const open = force === undefined ? !gallerySidebarVisible : Boolean(force);
  if (open === gallerySidebarVisible) return;
  updateGalleryUiState(() => {
    gallerySidebarVisible = open;
    if (galleryFocusMode && explicit) gallerySidebarChangedDuringFocus = true;
  });
}

function setGalleryFocusMode(enabled: boolean): void {
  if (enabled === galleryFocusMode) return;
  updateGalleryUiState(() => {
    if (enabled) {
      gallerySidebarBeforeFocus = gallerySidebarVisible;
      gallerySidebarChangedDuringFocus = false;
      galleryFocusMode = true;
      gallerySidebarVisible = false;
      return;
    }
    galleryFocusMode = false;
    if (!gallerySidebarChangedDuringFocus) gallerySidebarVisible = gallerySidebarBeforeFocus;
    gallerySidebarChangedDuringFocus = false;
  });
}

function toggleGalleryFocusMode(): void {
  setGalleryFocusMode(!galleryFocusMode);
}

function updateRootSummary(): void {
  const current = optionalHtml('current-root');
  if (!current) return;
  current.title = '';
  if (!scannedRoots.length) {
    current.textContent = 'Папка не выбрана';
  } else if (scannedRoots.length === 1) {
    current.textContent = scannedRoots[0];
  } else {
    current.textContent = `${scannedRoots.length} папки`;
    current.title = scannedRoots.join('\n');
  }
}

function pathName(path: string): string {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || path || 'Папка';
}

function renderFolderTree(): void {
  const el = optionalHtml('folder-tree');
  if (!el) return;
  el.innerHTML = scannedRoots.length
    ? scannedRoots.map(root => `
      <div class="library-root" title="${escAttr(root)}">
        <div class="library-root-head">
          <span class="library-root-name">${escHtml(pathName(root))}</span>
          <button class="library-disconnect-btn" type="button" data-action="disconnect-folder" data-root="${escAttr(root)}" ${disconnectingRoots.has(root) ? 'disabled' : ''}>Отключить</button>
        </div>
        <span class="library-root-path">${escHtml(root)}</span>
      </div>
    `).join('')
    : '<div class="folder-empty">Библиотеки не добавлены</div>';
}

function hasActiveGalleryFilters(): boolean {
  if (!galleryTabs.list.length) return false;
  const tab = activeTab();
  return Boolean((tab.includeTags || []).length || (tab.excludeTags || []).length);
}

function galleryContentState(): GalleryContentState {
  if (visibleImages.length) return 'content';
  if (galleryLoadFailure) return 'load_error';
  if (!scannedRoots.length) return 'no_library';
  if (galleryRequestPending || sessionRequestPending) return 'content';
  if (hasActiveGalleryFilters()) return 'filtered_empty';
  return 'no_images';
}

function updateEmptyStateMessage(): void {
  const empty = requiredHtml('empty-state');
  const label = empty.querySelector<HTMLElement>('.label');
  const detail = empty.querySelector<HTMLElement>('.empty-state-detail');
  const action = empty.querySelector<HTMLButtonElement>('#empty-state-action');
  if (!label || !detail || !action) return;
  const state = galleryContentState();
  empty.dataset.state = state;
  empty.style.display = state === 'content' ? 'none' : 'flex';
  action.hidden = false;
  action.disabled = galleryRequestPending || sessionRequestPending;
  switch (state) {
    case 'no_library':
      label.textContent = 'Библиотеки не добавлены';
      detail.textContent = 'Добавьте папку с изображениями, чтобы начать работу';
      action.textContent = 'Добавить библиотеку';
      action.dataset.emptyAction = 'add-library';
      break;
    case 'no_images':
      label.textContent = 'Изображения не найдены';
      detail.textContent = 'Проверьте содержимое папки или поддержку формата';
      action.hidden = true;
      action.dataset.emptyAction = '';
      break;
    case 'filtered_empty':
      label.textContent = 'Нет изображений по выбранным тегам';
      detail.textContent = 'Сбросьте фильтры, чтобы снова показать всю библиотеку';
      action.textContent = 'Сбросить фильтры';
      action.dataset.emptyAction = 'reset-filters';
      break;
    case 'load_error':
      label.textContent = 'Не удалось загрузить изображения';
      detail.textContent = galleryLoadFailure?.message || 'Проверьте подключение и повторите попытку';
      action.textContent = galleryRequestPending || sessionRequestPending ? 'Повторяем…' : 'Повторить';
      action.dataset.emptyAction = galleryLoadFailure?.retry || 'images';
      break;
    case 'content':
      action.hidden = true;
      action.dataset.emptyAction = '';
      break;
  }
}

function runEmptyStateAction(action: string | undefined): void {
  switch (action) {
    case 'add-library':
      void pickFolder();
      break;
    case 'reset-filters':
      clearActiveFilters();
      break;
    case 'session':
      void loadSession();
      break;
    case 'images':
      void refreshImages(true);
      break;
  }
}

function toggleSettings(force?: boolean): void {
  const panel = requiredHtml('settings-panel');
  const open = force === undefined ? !panel.classList.contains('open') : Boolean(force);
  if (open === (activeWorkspace === 'settings')) return;
  if (open) {
    saveActiveScroll();
    viewerCoordinator.suppressRestoreFromActiveTab();
    viewerCoordinator.close(false);
  }
  activeWorkspace = open ? 'settings' : 'gallery';
  requiredHtml('gallery-screen').classList.toggle('settings-active', open);
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) {
    setSettingsTab(settingsActiveTab || 'general');
    renderFolderTagSyncSetting();
    window.scrollTo({top: 0});
  } else {
    requestAnimationFrame(() => {
      window.scrollTo({top: activeTab().scrollTop || 0});
      handleGalleryResize();
    });
  }
}

function renderFolderTagSyncSetting(): void {
  const toggle = optionalElement('folder-tag-sync-toggle', HTMLInputElement);
  if (toggle) toggle.checked = folderTagSync;
}

async function setFolderTagSync(enabled: boolean): Promise<void> {
  const toggle = optionalElement('folder-tag-sync-toggle', HTMLInputElement);
  if (toggle) toggle.disabled = true;
  try {
    const response = await fetch('/api/session', {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({folder_tag_sync: enabled})
    });
    if (!response.ok) throw new Error(await readError(response));
    const session = await readJsonRecord(response);
    folderTagSync = session.folder_tag_sync !== false;
    renderFolderTagSyncSetting();
  } catch (error) {
    renderFolderTagSyncSetting();
    alert('Не удалось изменить синхронизацию тегов: ' + errorMessage(error));
  } finally {
    if (toggle) toggle.disabled = false;
  }
}

async function deleteAllAutoTags(): Promise<void> {
  const confirmed = window.confirm(
    'Удалить все auto-tags, созданные из папок? Ручные теги и изображения останутся без изменений.',
  );
  if (!confirmed) return;
  try {
    const response = await fetch('/api/auto-tags', {method: 'DELETE'});
    if (!response.ok) throw new Error(await readError(response));
    const data = await readJsonRecord(response);
    setTagPool(data.tags || []);
    await refreshImages(true);
    renderTagAdmin();
  } catch (error) {
    alert('Не удалось удалить auto-tags: ' + errorMessage(error));
  }
}

function setSettingsTab(tab: SettingsTab | string | undefined): void {
  settingsActiveTab = tab === 'tags' || tab === 'problems' || tab === 'general' ? tab : 'general';
  document.querySelectorAll<HTMLElement>('.settings-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.settingsTab === settingsActiveTab);
  });
  document.querySelectorAll<HTMLElement>('.settings-panel-page').forEach(panel => {
    const active = panel.dataset.settingsPanel === settingsActiveTab;
    panel.classList.toggle('active', active);
    panel.setAttribute('aria-hidden', active ? 'false' : 'true');
  });
  if (settingsActiveTab === 'tags') renderTagAdmin();
  if (settingsActiveTab === 'problems' && activeWorkspace === 'settings') problemsWorkspace.scheduleRefresh();
}

function showGallery(): void {
  requiredHtml('setup-screen').style.display = 'none';
  requiredHtml('gallery-screen').style.display = 'block';
}

function showSetup(): void {
  requiredHtml('setup-screen').style.display = 'none';
  requiredHtml('gallery-screen').style.display = 'block';
  toggleFolderSidebar(true, false);
  renderFolderTree();
  updateRootSummary();
  updateEmptyStateMessage();
}

const setupFolderInput = optionalInput('setup-folder');
if (setupFolderInput) setupFolderInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') openFolder();
});
const settingsFolderInput = optionalInput('folder-input');
if (settingsFolderInput) settingsFolderInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') openFolder();
});

async function startStatusPolling(): Promise<void> {
  if (statusInterval) clearInterval(statusInterval);
  await pollStatus();
  statusInterval = setInterval(pollStatus, 1000);
}

async function pollStatus(): Promise<void> {
  const revision = libraryStateRevision;
  try {
    const r = await fetch('/api/status');
    if (!r.ok) throw new Error(await readError(r));
    const s = statusResponse(await readJsonRecord(r));
    if (revision !== libraryStateRevision) return;
    latestStatus = s;
    renderDbStatus(s);
    if (Array.isArray(s.root_paths)) {
      scannedRoots = stringArray(s.root_paths);
      updateRootSummary();
      renderFolderTree();
    } else if (s.root && !scannedRoots.includes(s.root)) {
      scannedRoots = [...scannedRoots, s.root];
      updateRootSummary();
      renderFolderTree();
    }
    setFolderInputValues(s.root || '');
    updateEmptyStateMessage();
    const prog = optionalHtml('scan-progress');
    const bar = optionalHtml('scan-bar');
    const txt = optionalHtml('status-text');
    if (!prog || !bar || !txt) return;
    if (s.running) {
      prog.style.display = 'block';
      const total = Number(s.total || 0);
      const done = Number(s.done || 0);
      const pct = total > 0 ? Math.round(done / total * 100) : 0;
      bar.style.width = pct + '%';
      txt.textContent = `Синхронизация: ${done}/${total}`;
    } else if (s.queued) {
      prog.style.display = 'block';
      bar.style.width = '0';
      txt.textContent = 'Синхронизация ожидает запуска';
    } else {
      prog.style.display = 'none';
      bar.style.width = '0';
      txt.textContent = s.error ? s.error : (s.root || 'Готово');
      if (statusInterval && !s.error && !s.queued) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
    }
  } catch (e) {
    setDbStatus(false, errorMessage(e));
  }
}

function startLiveEvents(): void {
  if (liveEventSource) return;
  const source = new EventSource('/api/events');
  liveEventSource = source;
  source.onmessage = event => {
    try {
      const raw: unknown = JSON.parse(event.data);
      if (!isRecord(raw) || typeof raw.type !== 'string') return;
      const sequence = Number(raw.sequence || 0);
      if (sequence > 0 && lastLiveSequence > 0 && sequence > lastLiveSequence + 1) {
        scheduleLiveRecovery('sequence_gap');
      }
      if (sequence > 0) lastLiveSequence = Math.max(lastLiveSequence, sequence);
      handleLiveEvent({
        sequence,
        type: raw.type,
        data: isRecord(raw.data) ? raw.data : {},
      });
    } catch (error) {
      console.warn('Invalid filesystem event payload', error);
    }
  };
  source.onerror = () => {
    // EventSource reconnects automatically and sends Last-Event-ID.
  };
}

function handleLiveEvent(event: LiveEventEnvelope): void {
  const image = normalizeImageItem(event.data.image);
  const eventRoot = typeof event.data.root_path === 'string' ? event.data.root_path : '';
  const disconnectedRootEvent = Boolean(eventRoot) && !scannedRoots.includes(eventRoot);
  switch (event.type) {
    case 'image_created':
      if (image && !disconnectedRootEvent) applyLiveImage(image);
      break;
    case 'image_updated':
    case 'image_renamed':
      if (image && !disconnectedRootEvent) applyLiveImage(image);
      break;
    case 'image_removed':
      if (!disconnectedRootEvent) removeLiveImage(String(event.data.image_id || ''));
      break;
    case 'directory_created':
    case 'directory_removed':
    case 'directory_renamed':
      scheduleLiveFolderRefresh();
      break;
    case 'sync_started':
      startStatusPolling();
      break;
    case 'sync_finished':
      void refreshImages(true);
      scheduleLiveFolderRefresh();
      scheduleLiveTagRefresh();
      break;
    case 'tags_changed':
      scheduleLiveTagRefresh();
      if (event.data.reason === 'auto_tags_deleted') void refreshImages(true);
      break;
    case 'settings_changed':
      if (typeof event.data.folder_tag_sync === 'boolean') {
        folderTagSync = event.data.folder_tag_sync;
        renderFolderTagSyncSetting();
      }
      break;
    case 'root_online':
    case 'root_offline':
      void pollStatus();
      break;
    case 'library_disconnected':
      libraryStateRevision += 1;
      scannedRoots = stringArray(event.data.root_paths);
      galleryLoadFailure = null;
      setFolderInputValues(typeof event.data.root === 'string' ? event.data.root : '');
      viewerCoordinator.suppressRestoreFromActiveTab();
      viewerCoordinator.close(false, false);
      clearImageSelection();
      renderFolderTree();
      updateRootSummary();
      updateEmptyStateMessage();
      void refreshImages(true);
      problemsWorkspace.scheduleRefresh();
      break;
    case 'problems_changed':
      problemsWorkspace.handleProblemsChanged();
      break;
    case 'problems_recheck_finished':
      problemsWorkspace.handleRecheckFinished(event.data);
      break;
    case 'resync_required':
      scheduleLiveRecovery(String(event.data.reason || 'backend_requested'));
      break;
  }
}

function imageMatchesActiveTab(image: ImageItem): boolean {
  const tab = activeTab();
  const tags = new Set((image.tags || []).map(normalizeTag));
  if ((tab.excludeTags || []).some(tag => tags.has(normalizeTag(tag)))) return false;
  const required = (tab.includeTags || []).map(normalizeTag).filter(Boolean);
  if (!required.length) return true;
  return tab.matchMode === 'all'
    ? required.every(tag => tags.has(tag))
    : required.some(tag => tags.has(tag));
}

function compareLiveImages(left: ImageItem, right: ImageItem): number {
  const tab = activeTab();
  const pathOrder = left.path.localeCompare(right.path, undefined, {sensitivity: 'base'}) || left.id.localeCompare(right.id);
  switch (tab.sortMode) {
    case 'path_desc': return -pathOrder;
    case 'date_desc': return Number(right.mtime || 0) - Number(left.mtime || 0) || pathOrder;
    case 'date_asc': return Number(left.mtime || 0) - Number(right.mtime || 0) || pathOrder;
    case 'size_desc': return Number(right.size || 0) - Number(left.size || 0) || pathOrder;
    case 'size_asc': return Number(left.size || 0) - Number(right.size || 0) || pathOrder;
    default: return pathOrder;
  }
}

function buildLiveTotalQueryParams(): URLSearchParams {
  const tab = activeTab();
  return buildImageQueryParams({
    includeTags: tab.includeTags || [],
    excludeTags: tab.excludeTags || [],
    matchMode: tab.matchMode === 'all' ? 'all' : 'any',
    limit: 1,
    sortMode: tab.sortMode || DEFAULT_SORT_MODE,
    includeTotal: true,
  });
}

function applyLiveImage(image: ImageItem): void {
  acceptActiveImage(image.id);
  const existingIndex = allImages.findIndex(item => item.id === image.id);
  const previousMembership = liveTotalReconciler.knownMembership(image.id, existingIndex);
  const nextMembership = imageMatchesActiveTab(image);
  if (existingIndex >= 0) allImages.splice(existingIndex, 1);
  if (nextMembership) allImages.push(image);
  allImages.sort(compareLiveImages);
  visibleImages = allImages.slice();
  liveTotalReconciler.recordMembership(image.id, nextMembership);
  liveTotalReconciler.reconcileMembership(previousMembership, nextMembership);
  renderLiveGalleryState();
  scheduleLiveFolderRefresh();
  scheduleLiveTagRefresh();
  updateLivePreviewImage(image);
}

function removeLiveImage(imageId: string): void {
  if (!imageId) return;
  if (selectedImageIds.delete(imageId)) {
    if (!batchTagSubmitting) resetBatchTagDraft();
    updateImageSelectionUi();
  }
  const existingIndex = allImages.findIndex(item => item.id === imageId);
  const previousMembership = liveTotalReconciler.knownMembership(imageId, existingIndex);
  if (existingIndex >= 0) allImages.splice(existingIndex, 1);
  visibleImages = allImages.slice();
  liveTotalReconciler.recordMembership(imageId, false);
  liveTotalReconciler.reconcileMembership(previousMembership, false);
  if (viewerCoordinator.currentImageId === imageId) viewerCoordinator.close(true, false);
  renderLiveGalleryState();
  scheduleLiveFolderRefresh();
  scheduleLiveTagRefresh();
}

function renderLiveGalleryState(): void {
  invalidateVirtualGallery({preserveAnchor: true, resetCards: false});
  updateImageCounter();
  viewerCoordinator.refreshGallerySource();
  updateEmptyStateMessage();
}

function updateLivePreviewImage(image: ImageItem): void {
  viewerCoordinator.updateFixedImage(image);
  if (viewerCoordinator.isOpen && viewerCoordinator.currentImageId === image.id) {
    renderPreviewMeta(viewerCoordinator.currentImage || image, false);
  }
}

function scheduleLiveRecovery(reason: string): void {
  if (liveRecoveryTimer) return;
  console.warn('Recovering gallery state after filesystem event gap', {reason});
  liveRecoveryTimer = setTimeout(async () => {
    liveRecoveryTimer = null;
    await refreshImages(true);
    await refreshFolderTree();
  }, 100);
}

function scheduleLiveFolderRefresh(): void {
  if (liveFolderRefreshTimer) clearTimeout(liveFolderRefreshTimer);
  liveFolderRefreshTimer = setTimeout(() => {
    liveFolderRefreshTimer = null;
    void refreshFolderTree();
  }, 150);
}

function scheduleLiveTagRefresh(): void {
  if (liveTagRefreshTimer) clearTimeout(liveTagRefreshTimer);
  liveTagRefreshTimer = setTimeout(() => {
    liveTagRefreshTimer = null;
    void refreshTagPool();
  }, 150);
}

function renderDbStatus(status: StatusResponse): void {
  if (status.db_ready) setDbStatus(true, 'SQLite готов');
  else setDbStatus(false, status.db_error || 'SQLite недоступен');
}

function setDbStatus(ok: boolean, text: string): void {
  const db = requiredHtml('db-status');
  const setup = requiredHtml('setup-db-status');
  db.textContent = text;
  db.title = text;
  setup.textContent = text;
  setup.title = text;
  db.classList.toggle('ok', ok);
  db.classList.toggle('bad', !ok);
}

function showProblemsView(): void {
  toggleSettings(true);
  setSettingsTab('problems');
}

function showGalleryView(): void {
  toggleSettings(false);
}

function setServerTotalFromPage(page: ImagePage | null | undefined, fallbackCount: number, resetKnown: boolean): void {
  const total = pageTotalValue(page);
  if (total !== null) {
    serverTotalKnown = true;
    serverTotal = total;
    return;
  }
  if (resetKnown) serverTotalKnown = false;
  if (!serverTotalKnown) serverTotal = Number(fallbackCount || 0);
}

function updateImageCounter(): void {
  const count = serverTotalKnown ? serverTotal : visibleImages.length;
  const suffix = !serverTotalKnown && hasMorePages ? '+' : '';
  requiredHtml('count-text').textContent = `${count}${suffix} фото`;
}

async function refreshImages(clear = true): Promise<void> {
  const requestId = ++activeImagesRequest;
  const liveRevisionAtStart = liveTotalReconciler.beginGalleryRefresh(requestId);
  const diagnosticPage = galleryDiagnostics.beginPage('refresh', allImages.length);
  activePageLoad = null;
  isLoadingPage = true;
  galleryRequestPending = true;
  updateEmptyStateMessage();
  const tab = activeTab();
  const params = buildImageQueryParams({
    includeTags: tab.includeTags || [],
    excludeTags: tab.excludeTags || [],
    matchMode: tab.matchMode === 'all' ? 'all' : 'any',
    limit: PAGE,
    sortMode: tab.sortMode || DEFAULT_SORT_MODE,
    includeTotal: true,
  });
  try {
    const r = await fetch('/api/images?' + params.toString());
    galleryDiagnostics.pageResponse(diagnosticPage, r);
    if (!r.ok) {
      galleryDiagnostics.finishPage(diagnosticPage, 'http_failure', allImages.length);
      throw new Error(await readError(r));
    }
    let d: JsonRecord;
    try {
      d = await readJsonRecord(r);
      galleryDiagnostics.pageStage(diagnosticPage, 'json');
    } catch (error) {
      galleryDiagnostics.finishPage(diagnosticPage, 'parse_failure', allImages.length);
      throw error;
    }
    if (requestId !== activeImagesRequest) {
      galleryDiagnostics.finishPage(diagnosticPage, 'stale', allImages.length);
      return;
    }
    const refreshedPage = imagesFromRecord(d);
    galleryDiagnostics.pageStage(diagnosticPage, 'mapped');
    refreshedPage.forEach(image => acceptActiveImage(image.id));
    allImages = clear
      ? refreshedPage
      : mergeRefreshedPageIntoLoadedImages(allImages, refreshedPage);
    const liveEventsDuringRequest = liveTotalReconciler.acceptGallerySnapshot(
      requestId,
      liveRevisionAtStart,
    );
    galleryDiagnostics.pageStage(diagnosticPage, 'deduped');
    visibleImages = allImages.slice();
    galleryDiagnostics.pageStage(diagnosticPage, 'arrays');
    const page = imagePage(d.page);
    setServerTotalFromPage(page, visibleImages.length, true);
    if (liveEventsDuringRequest) liveTotalReconciler.schedule();
    nextCursor = page ? page.next_cursor || null : null;
    hasMorePages = Boolean(page && page.has_more);
    isLoadingPage = false;
    galleryRequestPending = false;
    galleryLoadFailure = null;
    dismissNotification('gallery-load');
    await refreshTagPool();
    if (requestId !== activeImagesRequest) {
      galleryDiagnostics.finishPage(diagnosticPage, 'stale', allImages.length);
      return;
    }
    galleryDiagnostics.pageStage(diagnosticPage, 'pre_virtualizer_wait');
    applyFilter(clear);
    viewerCoordinator.refreshGallerySource();
    galleryDiagnostics.pageStage(diagnosticPage, 'virtualizer');
    galleryDiagnostics.finishPage(diagnosticPage, 'success', allImages.length);
    await restorePendingGalleryScroll(requestId);
    if (requestId !== activeImagesRequest) return;
    viewerCoordinator.restoreIfNeeded();
  } catch (e) {
    if (diagnosticPage && !diagnosticPage.finished) {
      const outcome: DiagnosticPageOutcome = e instanceof DOMException && e.name === 'AbortError'
        ? 'aborted'
        : 'network_failure';
      galleryDiagnostics.finishPage(diagnosticPage, outcome, allImages.length);
    }
    console.error(e);
    if (requestId === activeImagesRequest) {
      isLoadingPage = false;
      galleryRequestPending = false;
      const message = errorMessage(e);
      galleryLoadFailure = {message, retry: 'images'};
      requiredHtml('status-text').textContent = message;
      updateEmptyStateMessage();
      if (visibleImages.length) {
        showNotification('Не удалось обновить галерею: ' + message, 'error', {
          actionLabel: 'Повторить',
          action: () => refreshImages(true),
          key: 'gallery-load',
          persistent: true,
        });
      }
    }
  }
}

function applyFilter(clear = true): void {
  const tab = activeTab();
  visibleImages = allImages.slice();
  updateImageCounter();
  updateTabTitle(tab);
  renderTabs();
  renderFilterControls();
  invalidateVirtualGallery({preserveAnchor: !clear, resetCards: clear});
  updateEmptyStateMessage();
}

function loadNextImagesPage(): Promise<void> {
  const requestId = activeImagesRequest;
  if (activePageLoad?.requestId === requestId) return activePageLoad.promise;
  if (!hasMorePages || !nextCursor) return Promise.resolve();
  const cursor = nextCursor;
  const diagnosticPage = galleryDiagnostics.beginPage('cursor', allImages.length);
  isLoadingPage = true;
  const load = {requestId, promise: Promise.resolve()};
  load.promise = (async () => {
    const tab = activeTab();
    const params = buildImageQueryParams({
      includeTags: tab.includeTags || [],
      excludeTags: tab.excludeTags || [],
      matchMode: tab.matchMode === 'all' ? 'all' : 'any',
      limit: PAGE,
      sortMode: tab.sortMode || DEFAULT_SORT_MODE,
      includeTotal: false,
      cursor,
    });
    try {
      const r = await fetch('/api/images?' + params.toString());
      galleryDiagnostics.pageResponse(diagnosticPage, r);
      if (!r.ok) {
        galleryDiagnostics.finishPage(diagnosticPage, 'http_failure', allImages.length);
        throw new Error(await readError(r));
      }
      let d: JsonRecord;
      try {
        d = await readJsonRecord(r);
        galleryDiagnostics.pageStage(diagnosticPage, 'json');
      } catch (error) {
        galleryDiagnostics.finishPage(diagnosticPage, 'parse_failure', allImages.length);
        throw error;
      }
      if (requestId !== activeImagesRequest) {
        galleryDiagnostics.finishPage(diagnosticPage, 'stale', allImages.length);
        return;
      }
      const items = imagesFromRecord(d);
      galleryDiagnostics.pageStage(diagnosticPage, 'mapped');
      items.forEach(image => acceptActiveImage(image.id));
      const seen = new Set(allImages.map(img => img.id));
      items.forEach(img => {
        if (!seen.has(img.id)) {
          seen.add(img.id);
          allImages.push(img);
        }
      });
      galleryDiagnostics.pageStage(diagnosticPage, 'deduped');
      visibleImages = allImages.slice();
      galleryDiagnostics.pageStage(diagnosticPage, 'arrays');
      const page = imagePage(d.page);
      setServerTotalFromPage(page, visibleImages.length, false);
      nextCursor = page ? page.next_cursor || null : null;
      hasMorePages = Boolean(page && page.has_more);
      updateImageCounter();
      updateVirtualGalleryCount();
      refreshPreviewSourceUi();
      galleryDiagnostics.pageStage(diagnosticPage, 'virtualizer');
      galleryDiagnostics.finishPage(diagnosticPage, 'success', allImages.length);
    } catch (e) {
      if (diagnosticPage && !diagnosticPage.finished) {
        const outcome: DiagnosticPageOutcome = e instanceof DOMException && e.name === 'AbortError'
          ? 'aborted'
          : 'network_failure';
        galleryDiagnostics.finishPage(diagnosticPage, outcome, allImages.length);
      }
      console.error(e);
      if (requestId === activeImagesRequest) {
        showNotification('Не удалось загрузить следующую страницу: ' + errorMessage(e), 'error', {
          actionLabel: 'Повторить',
          action: loadNextImagesPage,
          key: 'gallery-page',
          persistent: true,
        });
      }
    } finally {
      if (activePageLoad === load) {
        isLoadingPage = false;
        activePageLoad = null;
        const instance = galleryVirtualizerController.current;
        if (instance) schedulePaginationPrefetch(instance);
      }
    }
  })();
  activePageLoad = load;
  return load.promise;
}

function thumbnailUrls(img: ImageItem): {primary: string; fallback: string; version: number} {
  const version = Number(img.mtime || 0);
  return {
    primary: `${img.thumb_url || `/thumb-file/${img.id}.jpg`}?v=${version}`,
    fallback: `/thumb/${img.id}?v=${version}`,
    version,
  };
}

function bindDiagnosticCardRef(image: HTMLImageElement, ref: DiagnosticCardRef | null): void {
  if (!ref) return;
  image.dataset.diagnosticGeneration = String(ref.generation);
  image.dataset.diagnosticLifecycle = String(ref.lifecycle);
}

function diagnosticCardRef(image: HTMLImageElement | null): DiagnosticCardRef | null {
  if (!image) return null;
  const generation = Number(image.dataset.diagnosticGeneration);
  const lifecycle = Number(image.dataset.diagnosticLifecycle);
  const key = String(image.dataset.imageId || '');
  return key && Number.isInteger(generation) && Number.isInteger(lifecycle)
    ? {key, generation, lifecycle}
    : null;
}

function updateImageSelectionUi(): void {
  const validIds = new Set(allImages.map(image => image.id));
  for (const imageId of [...selectedImageIds]) {
    if (!validIds.has(imageId)) selectedImageIds.delete(imageId);
  }
  document.body.classList.toggle('image-selection-mode', selectedImageIds.size > 0);
  optionalHtml('selection-tray')?.classList.toggle('open', selectedImageIds.size > 0);
  const count = optionalHtml('selection-count');
  if (count) count.textContent = String(selectedImageIds.size);
  virtualGalleryView.forEachMounted((mounted, imageId) => {
    mounted.card.classList.toggle('selected', selectedImageIds.has(imageId));
  });
  renderBatchTagPanel();
}

function toggleImageSelection(imageId: string): void {
  if (!imageId) return;
  if (selectedImageIds.has(imageId)) selectedImageIds.delete(imageId);
  else selectedImageIds.add(imageId);
  if (!batchTagSubmitting) resetBatchTagDraft();
  updateImageSelectionUi();
}

function clearImageSelection(): void {
  selectedImageIds.clear();
  batchTagPanelOpen = false;
  if (!batchTagSubmitting) resetBatchTagDraft();
  updateImageSelectionUi();
}

function resetBatchTagDraft(): void {
  batchTagAdditions = [];
  batchTagRemovals = [];
  batchTagStatus = '';
  batchTagStatusIsError = false;
}

function selectedLoadedImages(): ImageItem[] {
  return allImages.filter(image => selectedImageIds.has(image.id));
}

function selectedUserTagCounts(): Map<string, {name: string; count: number}> {
  const counts = new Map<string, {name: string; count: number}>();
  for (const image of selectedLoadedImages()) {
    const seen = new Set<string>();
    for (const tag of image.user_tags || []) {
      const normalized = normalizeTag(tag);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const current = counts.get(normalized);
      if (current) current.count += 1;
      else counts.set(normalized, {name: tag, count: 1});
    }
  }
  return counts;
}

function renderBatchTagPanel(): void {
  const panel = optionalHtml('batch-tag-panel');
  if (!panel) return;
  panel.classList.toggle('open', batchTagPanelOpen && selectedImageIds.size > 0);
  const summary = optionalHtml('batch-tag-summary');
  if (summary) summary.textContent = `${selectedImageIds.size} фото`;
  const selectedCount = selectedImageIds.size;
  const counts = selectedUserTagCounts();
  const removeNorms = new Set(batchTagRemovals.map(normalizeTag));
  const existing = optionalHtml('batch-tag-existing');
  if (existing) {
    const tags = [...counts.values()].sort((left, right) => left.name.localeCompare(right.name));
    existing.innerHTML = tags.length
      ? tags.map(tag => {
        const pending = removeNorms.has(normalizeTag(tag.name));
        const coverage = tag.count === selectedCount ? 'все' : `${tag.count}/${selectedCount}`;
        return `<button class="batch-tag-token ${pending ? 'pending-remove' : ''}" type="button" data-action="toggle-batch-remove" data-tag="${escAttr(tag.name)}" title="${pending ? 'Отменить удаление' : 'Удалить у выбранных'}"><span>${escHtml(tag.name)}</span><span class="tag-coverage">${coverage}</span></button>`;
      }).join('')
      : '<span class="batch-tag-empty">У выбранных изображений нет пользовательских тегов</span>';
  }
  const additions = optionalHtml('batch-tag-additions');
  if (additions) {
    additions.innerHTML = batchTagAdditions.map(tag => `
      <button class="batch-tag-token pending-add" type="button" data-action="cancel-batch-add" data-tag="${escAttr(tag)}" title="Не добавлять этот тег">+ ${escHtml(tag)} ×</button>
    `).join('');
  }
  const suggestions = document.getElementById('batch-tag-suggestions');
  if (suggestions instanceof HTMLDataListElement) {
    suggestions.innerHTML = tagCatalog.names
      .filter(tag => {
        const meta = tagCatalog.getMeta(tag);
        return meta.user_defined || meta.user_count > 0;
      })
      .map(tag => `<option value="${escAttr(tag)}"></option>`)
      .join('');
  }
  const status = optionalHtml('batch-tag-status');
  if (status) {
    status.textContent = batchTagStatus;
    status.classList.toggle('error', batchTagStatusIsError);
  }
  const apply = optionalElement('batch-tag-apply', HTMLButtonElement);
  if (apply) {
    apply.disabled = batchTagSubmitting
      || !selectedImageIds.size
      || (!batchTagAdditions.length && !batchTagRemovals.length);
    apply.textContent = batchTagSubmitting ? 'Применение…' : 'Применить';
  }
}

function toggleBatchTagPanel(force?: boolean): void {
  if (!selectedImageIds.size) return;
  batchTagPanelOpen = force === undefined ? !batchTagPanelOpen : force;
  renderBatchTagPanel();
  if (batchTagPanelOpen) requiredInput('batch-tag-input').focus();
}

function queueBatchTagFromInput(): void {
  if (batchTagSubmitting) return;
  const input = requiredInput('batch-tag-input');
  const value = tagCatalog.findDisplayTag(input.value);
  const normalized = normalizeTag(value);
  if (!normalized) return;
  batchTagRemovals = batchTagRemovals.filter(tag => normalizeTag(tag) !== normalized);
  const assignedCount = selectedUserTagCounts().get(normalized)?.count || 0;
  if (assignedCount < selectedImageIds.size
      && !batchTagAdditions.some(tag => normalizeTag(tag) === normalized)) {
    batchTagAdditions.push(value);
  }
  input.value = '';
  batchTagStatus = assignedCount === selectedImageIds.size ? 'Этот тег уже назначен всем выбранным' : '';
  batchTagStatusIsError = false;
  renderBatchTagPanel();
}

function cancelBatchTagAddition(tag: string): void {
  if (batchTagSubmitting) return;
  const normalized = normalizeTag(tag);
  batchTagAdditions = batchTagAdditions.filter(item => normalizeTag(item) !== normalized);
  renderBatchTagPanel();
}

function toggleBatchTagRemoval(tag: string): void {
  if (batchTagSubmitting) return;
  const normalized = normalizeTag(tag);
  const removing = batchTagRemovals.some(item => normalizeTag(item) === normalized);
  batchTagRemovals = removing
    ? batchTagRemovals.filter(item => normalizeTag(item) !== normalized)
    : [...batchTagRemovals, tag];
  if (!removing) {
    batchTagAdditions = batchTagAdditions.filter(item => normalizeTag(item) !== normalized);
  }
  batchTagStatus = '';
  batchTagStatusIsError = false;
  renderBatchTagPanel();
}

function applyBatchTagDeltaLocally(imageIds: string[], addTags: string[], removeTags: string[]): void {
  const targetIds = new Set(imageIds);
  const removeNorms = new Set(removeTags.map(normalizeTag));
  const updated = new Map<string, ImageItem>();
  const applyToImage = (image: ImageItem): void => {
    const retained = (image.user_tags || []).filter(tag => !removeNorms.has(normalizeTag(tag)));
    image.user_tags = dedupeDisplayTags([...retained, ...addTags]);
    image.auto_tags = image.auto_tags || image.folder_tags || [];
    image.folder_tags = image.auto_tags;
    image.tags = dedupeDisplayTags([...(image.auto_tags || []), ...image.user_tags]);
  };
  for (const images of [allImages, visibleImages]) {
    for (const image of images) {
      if (!targetIds.has(image.id)) continue;
      applyToImage(image);
      updated.set(image.id, image);
    }
  }
  for (const image of updated.values()) updateCardForImage(image);
  const previewImage = viewerCoordinator.currentImage;
  if (previewImage && targetIds.has(previewImage.id)) {
    applyToImage(previewImage);
    renderPreviewTags(previewImage);
  }
  setTagPool([...tagCatalog.names, ...addTags]);
  updateFishGhosts();
}

function batchChangesAffectActiveFilter(addTags: string[], removeTags: string[]): boolean {
  const tab = activeTab();
  const changed = new Set([...addTags, ...removeTags].map(normalizeTag));
  return [...(tab.includeTags || []), ...(tab.excludeTags || [])]
    .some(tag => changed.has(normalizeTag(tag)));
}

async function applyBatchTagChanges(): Promise<void> {
  if (batchTagSubmitting || !selectedImageIds.size) return;
  if (selectedImageIds.size > 1000) {
    batchTagStatus = 'За один раз можно изменить не более 1000 изображений';
    batchTagStatusIsError = true;
    renderBatchTagPanel();
    return;
  }
  const imageIds = [...selectedImageIds];
  const addTags = batchTagAdditions.slice();
  const removeTags = batchTagRemovals.slice();
  if (!addTags.length && !removeTags.length) return;
  batchTagSubmitting = true;
  batchTagStatus = 'Сохранение…';
  batchTagStatusIsError = false;
  renderBatchTagPanel();
  try {
    const response = await fetch('/api/images/tags/batch', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({image_ids: imageIds, add_tags: addTags, remove_tags: removeTags}),
    });
    if (!response.ok) throw new Error(await readError(response));
    const result = await readJsonRecord(response);
    const appliedAdditions = stringArray(result.add_tags);
    const appliedRemovals = stringArray(result.remove_tags);
    activeImagesRequest += 1;
    activePageLoad = null;
    isLoadingPage = false;
    tagCatalogRevision += 1;
    applyBatchTagDeltaLocally(imageIds, appliedAdditions, appliedRemovals);
    const resetGallery = batchChangesAffectActiveFilter(appliedAdditions, appliedRemovals);
    batchTagAdditions = [];
    batchTagRemovals = [];
    batchTagStatus = `Обновлено: ${Number(result.updated_count || 0)}, без изменений: ${Number(result.unchanged_count || 0)}`;
    await refreshImages(resetGallery);
  } catch (error) {
    batchTagStatus = errorMessage(error);
    batchTagStatusIsError = true;
  } finally {
    batchTagSubmitting = false;
    renderBatchTagPanel();
  }
}

function makeCard(
  img: ImageItem,
  highPriority = false,
  initialDiagnosticRef: DiagnosticCardRef | null = null,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = img.id;
  const name = fileName(img.path);
  const ph = document.createElement('img');
  ph.className = 'lazy';
  ph.dataset.imageId = img.id;
  bindDiagnosticCardRef(ph, initialDiagnosticRef);
  const sources = thumbnailUrls(img);
  ph.dataset.fallbackSrc = sources.fallback;
  ph.dataset.primarySrc = sources.primary;
  ph.dataset.thumbVersion = String(sources.version);
  ph.alt = name;
  ph.decoding = 'async';
  ph.loading = 'eager';
  if ('fetchPriority' in ph) ph.fetchPriority = highPriority ? 'high' : 'auto';
  ph.style.aspectRatio = aspectCss(img);
  const width = Number(img.width || 0);
  const height = Number(img.height || 0);
  if (width > 0 && height > 0) {
    ph.width = width;
    ph.height = height;
  }
  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';
  overlay.innerHTML = `
    <div class="card-name">${escHtml(name)}</div>
    <div class="card-tags">${renderTagChips(img)}</div>
  `;
  const selectButton = document.createElement('button');
  selectButton.className = 'card-select';
  selectButton.type = 'button';
  selectButton.title = 'Выбрать изображение';
  selectButton.textContent = '✓';
  card.classList.toggle('selected', selectedImageIds.has(img.id));
  card.appendChild(ph);
  card.appendChild(overlay);
  card.appendChild(selectButton);
  selectButton.addEventListener('click', event => {
    event.stopPropagation();
    toggleImageSelection(img.id);
  });
  card.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || selectedImageIds.size > 0) {
      toggleImageSelection(img.id);
      return;
    }
    viewerCoordinator.openById(img.id);
  });
  let primaryState: 'loading' | 'decoding' | 'ready' | 'failed' = 'loading';
  const failPrimary = () => {
    if (primaryState === 'failed') return;
    primaryState = 'failed';
    galleryDiagnostics.primaryFailed(diagnosticCardRef(ph));
    if (ph.dataset.fallbackSrc && ph.dataset.primarySrc) {
      thumbnailLifecycles.registerMissing(ph);
      return;
    }
    ph.classList.add('loaded');
    ph.alt = 'Ошибка загрузки';
  };
  const handlePrimaryLoad = () => {
    if (primaryState !== 'loading') return;
    primaryState = 'decoding';
    const expectedSrc = ph.currentSrc;
    void decodeCurrentThumbnail(
      ph,
      expectedSrc,
      () => ph.isConnected && primaryState === 'decoding' && ph.onload === handlePrimaryLoad,
    ).then(result => {
      if (result === 'stale') return;
      if (result === 'failed') {
        failPrimary();
        return;
      }
      primaryState = 'ready';
      galleryDiagnostics.primaryLoaded(diagnosticCardRef(ph), true);
      ph.classList.add('loaded');
    });
  };
  ph.onload = handlePrimaryLoad;
  ph.onerror = failPrimary;
  galleryDiagnostics.primaryRequestStarted(diagnosticCardRef(ph));
  ph.src = sources.primary;
  return card;
}

function renderTagChips(img: ImageItem): string {
  const autoTags = img.auto_tags || img.folder_tags || [];
  const userTags = img.user_tags || [];
  return [
    ...autoTags.map(t => renderTagChip(t, {auto: true, className: 'tag-chip'})),
    ...userTags.map(t => renderTagChip(t, {className: 'tag-chip'}))
  ].join('');
}

function updateCardForImage(img: ImageItem): void {
  const mounted = virtualGalleryView.getMounted(img.id);
  const card = mounted?.card;
  if (!card) return;
  const tags = card.querySelector('.card-tags');
  if (tags) tags.innerHTML = renderTagChips(img);
}

function acceptActiveImage(imageId: string): void {
  terminalThumbIds.delete(imageId);
}

function handleTerminalImageUnavailable(imageId: string): void {
  if (!imageId || terminalThumbIds.has(imageId)) return;
  terminalThumbIds.add(imageId);
  if (selectedImageIds.delete(imageId) && !batchTagSubmitting) resetBatchTagDraft();
  updateImageSelectionUi();
  thumbnailLifecycles.cancel(imageId);
  if (viewerCoordinator.currentImageId === imageId) {
    viewerCoordinator.invalidateOriginalRequest();
    viewerCoordinator.close(true, false);
  }
  removeLiveImage(imageId);
  problemsWorkspace.scheduleRefresh();
  if (!terminalGalleryRefreshTimer) {
    terminalGalleryRefreshTimer = setTimeout(() => {
      terminalGalleryRefreshTimer = null;
      void refreshImages(true);
    }, 100);
  }
}

async function refreshTagPool(): Promise<TagCatalogRefreshResult> {
  const revision = ++tagCatalogRevision;
  try {
    const r = await fetch('/api/tags');
    if (!r.ok) throw new Error(await readError(r));
    const d = await readJsonRecord(r);
    if (revision !== tagCatalogRevision) return 'stale';
    setTagPool(d.tags || []);
    updateFishGhosts();
    renderFilterSuggestions();
    renderTagAdmin();
    return 'updated';
  } catch (error) {
    console.error('Failed to refresh tag catalog', error);
    return 'failed';
  }
}

function addTab() {
  clearImageSelection();
  saveActiveScroll();
  galleryTabs.add();
  viewerCoordinator.close(false);
  refreshImages(true);
  window.scrollTo({top: 0});
  saveSessionSoon();
}

function switchTab(id: string): void {
  if (id === galleryTabs.activeId) return;
  clearImageSelection();
  saveActiveScroll();
  galleryTabs.select(id);
  viewerCoordinator.close(false);
  const tab = activeTab();
  pendingGalleryScrollTop = tab.scrollTop || 0;
  void refreshImages(true);
  saveSessionSoon();
}

function closeTab(id: string): void {
  clearImageSelection();
  galleryTabs.close(id);
  viewerCoordinator.close(false);
  refreshImages(true);
  saveSessionSoon();
}

function switchTabByVisibleIndex(index: number): void {
  const tab = galleryTabs.list[index];
  if (tab) switchTab(tab.id);
}

function renderTabs(): void {
  const el = requiredHtml('tabs');
  el.innerHTML = galleryTabs.list.map(tab => `
    <button class="tab ${tab.id === galleryTabs.activeId ? 'active' : ''}" data-tab="${escAttr(tab.id)}" title="${escAttr(tab.title)}">
      <span class="tab-title">${escHtml(tab.title)}</span>
      <span class="tab-close" data-close="${escAttr(tab.id)}">×</span>
    </button>
  `).join('');
  el.querySelectorAll<HTMLElement>('.tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', e => {
      if (closestFromEvent(e, '.tab-close')) return;
      const id = btn.dataset.tab;
      if (id) switchTab(id);
    });
  });
  el.querySelectorAll<HTMLElement>('.tab-close[data-close]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.close;
      if (id) closeTab(id);
    });
  });
}

function saveActiveScroll(): void {
  if (!galleryTabs.list.length || activeWorkspace !== 'gallery') return;
  activeTab().scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
}

function renderFilterControls(): void {
  const tab = activeTab();
  requiredHtml('match-any').classList.toggle('active', tab.matchMode !== 'all');
  requiredHtml('match-all').classList.toggle('active', tab.matchMode === 'all');
  const sortSelect = optionalElement('sort-select', HTMLSelectElement);
  if (sortSelect) sortSelect.value = tab.sortMode || DEFAULT_SORT_MODE;
  renderSelectedFilterTags();
  renderFilterSuggestions();
  renderSidebarTags();
}

function setMatchMode(mode: string | undefined): void {
  activeTab().matchMode = mode === 'all' ? 'all' : 'any';
  refreshImages(true);
  saveSessionSoon();
}

function setSortMode(mode: string | undefined): void {
  activeTab().sortMode = isSortMode(mode) ? mode : DEFAULT_SORT_MODE;
  refreshImages(true);
  window.scrollTo({top: 0});
  saveSessionSoon();
}

function renderSelectedFilterTags(): void {
  const tab = activeTab();
  const el = requiredHtml('selected-filter-tags');
  const include = (tab.includeTags || []).map(tag => renderTagChip(tag, {
    removable: true,
    actionKind: 'include',
    className: 'filter-chip'
  })).join('');
  const exclude = (tab.excludeTags || []).map(tag => renderTagChip(tag, {
    removable: true,
    exclude: true,
    actionKind: 'exclude',
    className: 'filter-chip'
  })).join('');
  el.innerHTML = include + exclude || '<span class="muted-inline">Фильтры не выбраны</span>';
  el.querySelectorAll<HTMLElement>('button[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => removeFilterTag(btn.dataset.kind, btn.dataset.tag));
  });
}

function parseFilterTagInput(raw: string): {kind: TagKind; tag: string} | null {
  const parsed = splitTagPrefix(raw);
  let value = parsed.value;
  let kind: TagKind = 'include';
  if (parsed.prefix) {
    kind = 'exclude';
  }
  if (!value) return null;
  return {kind, tag: tagCatalog.findDisplayTag(value)};
}

function addFilterFromInput(raw: string): void {
  commitFilterTokens(raw);
}

function addFilterTag(kind: string | undefined, tag: string | undefined, clearInput = false): void {
  if (!tag) return;
  const changed = applyFilterTagToTab(kind, tag, activeTab());
  if (clearInput) requiredInput('filter-tag-input').value = '';
  if (changed) {
    refreshImages(true);
    saveSessionSoon();
  } else {
    renderFilterSuggestions();
  }
}

function applyFilterTagToTab(kind: string | undefined, tag: string, tab: GalleryTab): boolean {
  const value = tagCatalog.findDisplayTag(tag);
  if (!value) return false;
  const norm = normalizeTag(value);
  const normalizedKind = normalizeTagKind(kind);
  const key: 'includeTags' | 'excludeTags' = normalizedKind === 'exclude' ? 'excludeTags' : 'includeTags';
  const oppositeKey: 'includeTags' | 'excludeTags' = normalizedKind === 'exclude' ? 'includeTags' : 'excludeTags';
  const before = JSON.stringify([tab.includeTags || [], tab.excludeTags || []]);
  tab[oppositeKey] = (tab[oppositeKey] || []).filter(item => normalizeTag(item) !== norm);
  tab[key] = dedupeDisplayTags([...(tab[key] || []), value]);
  return before !== JSON.stringify([tab.includeTags || [], tab.excludeTags || []]);
}

function commitFilterTokens(raw?: string): void {
  const input = requiredInput('filter-tag-input');
  const tokens = String(raw || input.value || '').split(/\s+/).map(item => item.trim()).filter(Boolean);
  if (!tokens.length) return;
  let changed = false;
  const tab = activeTab();
  tokens.forEach(token => {
    const parsed = parseFilterTagInput(token);
    if (parsed) changed = applyFilterTagToTab(parsed.kind, parsed.tag, tab) || changed;
  });
  input.value = '';
  updateFilterGhost();
  updateFishGhosts();
  renderFilterSuggestions();
  if (changed) {
    refreshImages(true);
    saveSessionSoon();
  }
}

function removeFilterTag(kind: string | undefined, tag: string | undefined): void {
  if (!tag) return;
  const tab = activeTab();
  const key: 'includeTags' | 'excludeTags' = normalizeTagKind(kind) === 'exclude' ? 'excludeTags' : 'includeTags';
  tab[key] = (tab[key] || []).filter(item => normalizeTag(item) !== normalizeTag(tag));
  refreshImages(true);
  saveSessionSoon();
}

function clearActiveFilters(): void {
  const tab = activeTab();
  tab.includeTags = [];
  tab.excludeTags = [];
  refreshImages(true);
  saveSessionSoon();
}

function currentFilterPrefix(): {token: string; prefix: string; query: string; kind: TagKind} {
  const input = requiredInput('filter-tag-input');
  const token = String(input.value || '').split(/\s+/).pop() || '';
  const parsed = splitTagPrefix(token);
  return {token, prefix: parsed.prefix, query: normalizeTag(parsed.value), kind: parsed.prefix ? 'exclude' : 'include'};
}

function updateFilterGhost(): void {
  const input = requiredInput('filter-tag-input');
  const ghost = requiredHtml('filter-tag-ghost');
  const raw = input.value || '';
  const parts = raw.split(/\s+/);
  const token = parts.pop() || '';
  const parsed = splitTagPrefix(token);
  const q = normalizeTag(parsed.value);
  const suggestion = q
    ? tagCatalog.names.find(tag => normalizeTag(tag).startsWith(q) && normalizeTag(tag) !== q)
    : '';
  if (!suggestion) {
    input.dataset.suggestion = '';
    ghost.innerHTML = '';
    return;
  }
  const prefix = parts.length ? parts.join(' ') + ' ' : '';
  const completion = prefix + parsed.prefix + suggestion;
  input.dataset.suggestion = completion;
  ghost.innerHTML = completion.startsWith(raw)
    ? `<span class="ghost-hidden">${escHtml(raw)}</span>${escHtml(completion.slice(raw.length))}`
    : '';
}

function renderFilterSuggestions(): void {
  const list = optionalHtml('filter-suggestion-list');
  if (!list) return;
  updateFilterGhost();
  const {query, prefix, kind} = currentFilterPrefix();
  const tab = activeTab();
  const used = new Set([...(tab.includeTags || []), ...(tab.excludeTags || [])].map(normalizeTag));
  const matches = tagCatalog.names
    .filter(tag => !query || normalizeTag(tag).includes(query))
    .slice(0, 80);
  list.classList.toggle('open', filterSuggestionOpen);
  if (!filterSuggestionOpen) return;
  list.innerHTML = matches.length
    ? matches.map(tag => {
      const norm = normalizeTag(tag);
      const activeKind = (tab.excludeTags || []).some(item => normalizeTag(item) === norm)
        ? 'exclude'
        : (tab.includeTags || []).some(item => normalizeTag(item) === norm)
          ? 'include'
          : '';
      const label = `${prefix ? '!' : ''}${tag}`;
      return `<button class="filter-suggestion ${kind === 'exclude' ? 'is-exclude' : ''} ${activeKind ? 'active' : ''}" type="button" data-kind="${kind}" data-tag="${escAttr(tag)}">${escHtml(label)}${used.has(norm) ? ' ✓' : ''}</button>`;
    }).join('')
    : '<span class="muted-inline">Теги не найдены</span>';
  list.querySelectorAll<HTMLElement>('button[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      addFilterTag(btn.dataset.kind, btn.dataset.tag, true);
      requiredInput('filter-tag-input').focus();
    });
  });
}

function initFilterInput(): void {
  const input = requiredInput('filter-tag-input');
  input.addEventListener('focus', () => {
    filterSuggestionOpen = true;
    renderFilterSuggestions();
  });
  input.addEventListener('input', () => {
    filterSuggestionOpen = true;
    updateFilterGhost();
    renderFilterSuggestions();
  });
  input.addEventListener('keydown', e => {
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && input.dataset.suggestion) {
      e.preventDefault();
      input.value = input.dataset.suggestion;
      updateFilterGhost();
      renderFilterSuggestions();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      commitFilterTokens(input.value);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitFilterTokens(input.value);
      return;
    }
    if (e.key === 'Escape') {
      filterSuggestionOpen = false;
      input.value = '';
      updateFilterGhost();
      renderFilterSuggestions();
    }
  });
}

function focusGalleryTagSearch(): void {
  const input = requiredInput('filter-tag-input');
  input.focus({preventScroll: true});
  filterSuggestionOpen = true;
  renderFilterSuggestions();
}

function renderAllTagSurfaces(): void {
  renderFilterControls();
  renderTagAdmin();
  visibleImages.forEach(updateCardForImage);
  const previewImage = viewerCoordinator.currentImage;
  if (previewImage) renderPreviewTags(previewImage);
}

function renderTagAdmin(): void {
  const list = optionalHtml('tag-admin-list');
  if (!list) return;
  const query = normalizeTag(optionalInput('tag-admin-search')?.value || '');
  const tags = tagCatalog.names
    .filter(tag => !query || normalizeTag(tag).includes(query))
    .sort((a, b) => {
      const metaA = tagCatalog.getMeta(a);
      const metaB = tagCatalog.getMeta(b);
      if (tagAdminSort === 'image_count' || tagAdminSort === 'user_count' || tagAdminSort === 'auto_count') {
        return Number(metaB[tagAdminSort] || 0) - Number(metaA[tagAdminSort] || 0) || a.localeCompare(b);
      }
      return a.localeCompare(b);
    });
  list.innerHTML = tags.length ? tags.map(tag => {
    const meta = tagCatalog.getMeta(tag);
    const isAuto = Boolean(meta.is_auto || Number(meta.auto_count || 0) > 0);
    const color = meta.color || (isAuto ? '#D4D4D4' : '#E5E5E5');
    return `
      <div class="tag-admin-row" data-tag="${escAttr(tag)}">
        <input type="color" value="${escAttr(color)}" data-action="color" data-tag="${escAttr(tag)}" title="Цвет тега">
        <div class="tag-admin-identity">
          ${renderTagChip(tag, {count: true})}
          <input class="tag-admin-name-input" type="text" value="${escAttr(tag)}" ${isAuto ? 'disabled' : ''} data-name-input="${escAttr(tag)}">
        </div>
        <span class="tag-admin-counts">${Number(meta.image_count || 0)} фото · ${Number(meta.user_count || 0)} ручн · ${Number(meta.auto_count || 0)} папок</span>
        <button class="btn btn-ghost btn-sm" type="button" data-action="rename" data-tag="${escAttr(tag)}" ${isAuto ? 'disabled' : ''}>Сохранить</button>
        <button class="btn btn-danger btn-sm" type="button" data-action="delete" data-tag="${escAttr(tag)}">Удалить</button>
        ${isAuto ? '<span class="tag-admin-protected">auto</span>' : '<span></span>'}
      </div>
    `;
  }).join('') : '<span class="muted-inline">Теги не найдены</span>';

  list.querySelectorAll<HTMLInputElement>('input[data-action="color"]').forEach(input => {
    input.addEventListener('change', () => updateTagDefinition(input.dataset.tag, {color: input.value}, false));
  });
  list.querySelectorAll<HTMLElement>('button[data-action="rename"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.tag-admin-row');
      const input = row ? row.querySelector<HTMLInputElement>('.tag-admin-name-input') : null;
      updateTagDefinition(btn.dataset.tag, {name: input ? input.value : btn.dataset.tag}, true);
    });
  });
  list.querySelectorAll<HTMLElement>('button[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteTagDefinition(btn.dataset.tag));
  });
}

function setTagAdminSort(sort: string | undefined): void {
  tagAdminSort = sort === 'image_count' || sort === 'user_count' || sort === 'auto_count' ? sort : 'name';
  renderTagAdmin();
}

async function createTagFromSettings(): Promise<void> {
  const input = requiredInput('tag-admin-create');
  const value = input.value.trim();
  if (!value) return;
  try {
    const r = await fetch('/api/tags', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: value})
    });
    if (!r.ok) throw new Error(await readError(r));
    const d = await readJsonRecord(r);
    setTagPool(d.tags || [...tagCatalog.names, d.tag || value]);
    input.value = '';
    renderAllTagSurfaces();
    updateFishGhosts();
  } catch (e) {
    alert('Ошибка тега: ' + errorMessage(e));
  }
}

async function updateTagDefinition(tag: string | undefined, body: {name?: string; color?: string}, reloadImages: boolean): Promise<void> {
  if (!tag) return;
  try {
    const r = await fetch(`/api/tags/${encodeURIComponent(tag)}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(await readError(r));
    const d = await readJsonRecord(r);
    setTagPool(d.tags || []);
    if (reloadImages) await refreshImages(true);
    else renderAllTagSurfaces();
  } catch (e) {
    alert('Ошибка тега: ' + errorMessage(e));
    renderTagAdmin();
  }
}

async function deleteTagDefinition(tag: string | undefined): Promise<void> {
  if (!tag) return;
  const meta = tagCatalog.getMeta(tag);
  const isAuto = Boolean(meta.is_auto || Number(meta.auto_count || 0) > 0);
  const message = isAuto
    ? `Удалить авто-тег "${tag}"? Он останется скрытым при следующих изменениях файлов, пока вы не создадите его вручную.`
    : `Удалить тег "${tag}"?`;
  if (!confirm(message)) return;
  try {
    const r = await fetch(`/api/tags/${encodeURIComponent(tag)}`, {method: 'DELETE'});
    if (!r.ok) throw new Error(await readError(r));
    const d = await readJsonRecord(r);
    setTagPool(d.tags || []);
    await refreshImages(true);
  } catch (e) {
    alert('Ошибка тега: ' + errorMessage(e));
  }
}

function scrollToTop(): void {
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function updateScrollTopButton(): void {
  const btn = optionalHtml('scroll-top-btn');
  if (!btn) return;
  btn.classList.toggle('visible', window.scrollY > 320);
}

function initFishInput(
  inputId: string,
  ghostId: string,
  getExcluded: (value: string) => string[],
  onCommit: (tag: string) => void | boolean | Promise<void | boolean>
): FishController {
  const input = requiredInput(inputId);
  const ghost = requiredHtml(ghostId);
  const controller: FishController = { suggestion: '' };
  function update(): void {
    const value = input.value;
    const parsed = splitTagPrefix(value);
    const q = normalizeTag(parsed.value);
    const excluded = new Set(getExcluded(value).map(normalizeTag));
    const suggestion = q
      ? tagCatalog.names.find(tag => normalizeTag(tag).startsWith(q) && normalizeTag(tag) !== q && !excluded.has(normalizeTag(tag)))
      : '';
    controller.suggestion = suggestion ? parsed.prefix + suggestion : '';
    ghost.innerHTML = controller.suggestion
      ? `<span class="ghost-hidden">${escHtml(value)}</span>${escHtml(controller.suggestion.slice(value.length))}`
      : '';
  }
  input.addEventListener('input', update);
  input.addEventListener('keydown', e => {
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && controller.suggestion) {
      e.preventDefault();
      input.value = controller.suggestion;
      update();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = input.value.trim();
      if (value) {
        void onCommit(
          controller.suggestion && normalizeTag(value) !== normalizeTag(controller.suggestion)
            ? value
            : (controller.suggestion || value),
        );
      }
    }
    if (e.key === 'Escape') {
      input.value = '';
      update();
    }
  });
  controller.update = update;
  return controller;
}

let fishControllers: FishController[] = [];
function initFishInputs(): void {
  fishControllers = [
    initFishInput('preview-tag-input', 'preview-tag-ghost', () => {
      const img = viewerCoordinator.currentImage;
      return img ? img.tags || [] : [];
    }, tag => commitPreviewTagInput(tag))
  ];
}

function updateFishGhosts(): void {
  fishControllers.forEach(controller => controller.update && controller.update());
}

async function diagnosePreviewOriginalFailure(
  img: ImageItem,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const originalUrl = `/file/${img.id}`;
  let message: string;
  try {
    const response = await fetch(originalUrl, {method: 'HEAD', cache: 'no-store'});
    if (!isCurrent()) return;
    if (response.status === 422) {
      handleTerminalImageUnavailable(img.id);
      return;
    }
    message = response.status === 404
      ? `Оригинал недоступен: ${img.path} (${originalUrl})`
      : response.ok
        ? `Не удалось декодировать оригинал: ${img.path} (${originalUrl})`
        : `Не удалось загрузить оригинал (${response.status}): ${img.path} (${originalUrl})`;
  } catch (error) {
    if (!isCurrent()) return;
    message = `Не удалось проверить оригинал: ${errorMessage(error)}`;
  }
  requiredHtml('preview-name').textContent = `Ошибка оригинала: ${fileName(img.path)}`;
  console.error(message);
  alert('Не удалось открыть изображение: ' + message);
}

function imageFormat(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : '—';
}

function renderPreviewMeta(img: ImageItem, loading: boolean): void {
  const currentIndex = viewerCoordinator.currentIndex;
  const name = fileName(img.path);
  const resolution = `${img.width || '?'} × ${img.height || '?'}`;
  requiredHtml('preview-name').textContent = loading ? `Загрузка: ${name}` : name;
  requiredHtml('preview-size').textContent = fmtSize(img.size) || '—';
  const previewMetaName = optionalHtml('preview-meta-name');
  const previewResolution = optionalHtml('preview-resolution');
  const previewFormat = optionalHtml('preview-format');
  const previewPath = optionalHtml('preview-path');
  const previewHudResolution = optionalHtml('preview-hud-resolution');
  const previewIndex = optionalHtml('preview-index');
  if (previewMetaName) previewMetaName.textContent = name;
  if (previewResolution) previewResolution.textContent = resolution;
  if (previewFormat) previewFormat.textContent = imageFormat(img.path);
  if (previewPath) previewPath.textContent = img.path;
  if (previewHudResolution) previewHudResolution.textContent = resolution;
  if (previewIndex) previewIndex.textContent = `${currentIndex + 1} / ${viewerCoordinator.source().length}`;
  requiredAnchor('preview-open').href = `/file/${img.id}`;
  renderPreviewTags(img);
  renderPreviewFilmstrip();
}

function refreshPreviewSourceUi(): void {
  if (!viewerCoordinator.isOpen) return;
  const currentIndex = viewerCoordinator.currentIndex;
  if (currentIndex < 0) return;
  const previewIndex = optionalHtml('preview-index');
  if (previewIndex) previewIndex.textContent = `${currentIndex + 1} / ${viewerCoordinator.source().length}`;
  renderPreviewFilmstrip();
}

function measurePreviewFilmNearbyCapacity(): number | null {
  const target = optionalHtml('preview-film-items');
  if (!target || target.clientWidth <= 0) return null;
  const style = getComputedStyle(target);
  const itemWidth = Number.parseFloat(style.getPropertyValue('--preview-film-item-width'));
  const gap = Number.parseFloat(style.getPropertyValue('--preview-film-gap'));
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  if (!Number.isFinite(itemWidth) || itemWidth <= 0 || !Number.isFinite(gap) || gap < 0) return null;
  const usableWidth = target.clientWidth - paddingLeft - paddingRight;
  if (usableWidth <= 0) return null;
  return Math.max(1, Math.floor((usableWidth + gap) / (itemWidth + gap)));
}

function renderPreviewFilmstrip(): void {
  const target = optionalHtml('preview-film-items');
  const info = optionalHtml('preview-film-info');
  const modes = optionalHtml('preview-film-modes');
  if (!target || !info || !modes) return;
  modes.querySelectorAll<HTMLElement>('button[data-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === viewerCoordinator.filmMode);
  });
  const items = viewerCoordinator.filmCandidates();
  const current = viewerCoordinator.currentImage;
  target.replaceChildren();
  for (const image of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `preview-film-item${image.id === current?.id ? ' active' : ''}`;
    button.title = fileName(image.path);
    const thumbnail = document.createElement('img');
    thumbnail.alt = '';
    thumbnail.decoding = 'async';
    thumbnail.loading = 'eager';
    thumbnail.src = thumbnailUrls(image).primary;
    thumbnail.onerror = () => {
      button.classList.add('missing');
      thumbnail.removeAttribute('src');
    };
    button.appendChild(thumbnail);
    button.addEventListener('click', () => {
      const source = viewerCoordinator.source();
      const nextIndex = source.findIndex(item => item.id === image.id);
      if (nextIndex >= 0) viewerCoordinator.openAt(nextIndex, true, source, viewerCoordinator.sourceMode);
    });
    target.appendChild(button);
  }
  const label = viewerCoordinator.filmMode === 'tag'
    ? 'SAME TAG'
    : viewerCoordinator.filmMode === 'folder' ? 'FOLDER' : 'NEARBY';
  info.textContent = `${label} · ${items.length}`;
  requestAnimationFrame(() => {
    target.querySelector<HTMLElement>('.preview-film-item.active')?.scrollIntoView({inline: 'center', block: 'nearest'});
  });
}

function renderPreviewUiState(): void {
  const modal = requiredHtml('preview-modal');
  modal.classList.toggle('preview-focus-mode', viewerCoordinator.focusMode);
  modal.classList.toggle('preview-inspector-hidden', !viewerCoordinator.inspectorVisible);
  const button = optionalHtml('preview-focus-toggle');
  if (button) {
    button.classList.toggle('active', viewerCoordinator.focusMode);
    button.setAttribute('aria-pressed', viewerCoordinator.focusMode ? 'true' : 'false');
  }
}

async function runNativeImageAction(
  imageId: string,
  action: 'original' | 'reveal',
): Promise<void> {
  try {
    if (action === 'original') await openOriginalNative(imageId);
    else await revealImageNative(imageId);
  } catch (error) {
    const label = action === 'original' ? 'Не удалось открыть оригинал' : 'Не удалось показать файл';
    console.error(label, error);
    alert(`${label}: ${errorMessage(error)}`);
  }
}

function refreshPreviewLayout(): void {
  if (!viewerCoordinator.isOpen) return;
  previewModal?.refreshLayout();
  viewerCoordinator.scheduleFilmstripLayoutRefresh();
}

function focusPreviewTagInput(): void {
  if (!viewerCoordinator.isOpen) return;
  closePreviewQuickMenu();
  if (!viewerCoordinator.inspectorVisible) viewerCoordinator.toggleInspector();
  requiredInput('preview-tag-input').focus({preventScroll: true});
}

function openPreviewQuickMenu(clientX: number, clientY: number): void {
  if (!viewerCoordinator.isOpen) return;
  const menu = requiredHtml('quickMenu');
  const imageId = viewerCoordinator.currentImageId;
  if (!imageId) return;
  const maxLeft = window.innerWidth - 190;
  const maxTop = window.innerHeight - 260;
  menu.style.left = `${Math.min(maxLeft, clientX)}px`;
  menu.style.top = `${Math.min(maxTop, clientY)}px`;
  menu.dataset.imageId = imageId;
  menu.classList.add('open');
  menu.setAttribute('aria-hidden', 'false');
}

function closePreviewQuickMenu(): void {
  const menu = optionalHtml('quickMenu');
  if (!menu) return;
  menu.classList.remove('open');
  menu.setAttribute('aria-hidden', 'true');
  delete menu.dataset.imageId;
}

function runPreviewQuickAction(action: string | undefined): void {
  const menu = requiredHtml('quickMenu');
  const imageId = menu.dataset.imageId;
  if (!imageId || imageId !== viewerCoordinator.currentImageId) {
    closePreviewQuickMenu();
    return;
  }
  closePreviewQuickMenu();
  if (action === 'Tag') {
    requiredInput('preview-tag-input').focus();
  } else if (action === 'Original') {
    if (isDesktopRuntime()) void runNativeImageAction(imageId, 'original');
    else requiredAnchor('preview-open').click();
  } else if (action === 'Reveal in folder' && isDesktopRuntime()) {
    void runNativeImageAction(imageId, 'reveal');
  }
}

function initPreviewQuickMenu(): void {
  const menu = requiredHtml('quickMenu');
  const modal = requiredHtml('preview-modal');
  const revealAction = menu.querySelector<HTMLElement>('[data-quick-action="Reveal in folder"]');
  if (revealAction) revealAction.hidden = !isDesktopRuntime();
  requiredAnchor('preview-open').addEventListener('click', event => {
    if (!isDesktopRuntime()) return;
    event.preventDefault();
    const imageId = viewerCoordinator.currentImageId;
    if (imageId) void runNativeImageAction(imageId, 'original');
  });
  modal.addEventListener('contextmenu', event => {
    if (!viewerCoordinator.isOpen) return;
    event.preventDefault();
    openPreviewQuickMenu(event.clientX, event.clientY);
  });
  menu.querySelectorAll<HTMLElement>('[data-quick-action]').forEach(button => {
    button.addEventListener('click', () => runPreviewQuickAction(button.dataset.quickAction));
  });
  document.addEventListener('click', event => {
    const target = event.target instanceof Node ? event.target : null;
    if (target && !menu.contains(target)) closePreviewQuickMenu();
  });
  document.addEventListener('keydown', event => {
    const closeShortcut = event.key === 'Escape'
      || (isPlainCode(event, 'KeyQ') && !isTextEntryTarget(event.target));
    if (closeShortcut && menu.classList.contains('open')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePreviewQuickMenu();
    }
  }, true);
}

function renderPreviewTags(img: ImageItem): void {
  const auto = requiredHtml('preview-auto-tags');
  const user = requiredHtml('preview-user-tags');
  const autoTags = img.auto_tags || img.folder_tags || [];
  const userTags = img.user_tags || [];
  auto.innerHTML = autoTags.map(t => renderTagChip(t, {auto: true, className: 'preview-chip'})).join('');
  user.innerHTML = userTags.map(t => `
    ${renderTagChip(t, {removable: true, className: 'preview-chip'})}
  `).join('');
  user.querySelectorAll<HTMLElement>('button[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => { void removeTagFromPreview(btn.dataset.tag); });
  });
  renderPreviewTagDropdown();
  updatePreviewTagSavingState();
}

function updatePreviewTagSavingState(): void {
  const currentId = viewerCoordinator.currentImageId;
  const saving = Boolean(currentId && tagSavesInFlight.has(currentId));
  const panel = optionalHtml('preview-tag-panel');
  const input = optionalInput('preview-tag-input');
  if (panel) panel.setAttribute('aria-busy', saving ? 'true' : 'false');
  if (input) {
    input.readOnly = saving;
    input.setAttribute('aria-disabled', saving ? 'true' : 'false');
  }
  ['preview-tag-pick', 'preview-tag-add'].forEach(id => {
    const button = optionalElement(id, HTMLButtonElement);
    if (button) button.disabled = saving;
  });
  panel?.querySelectorAll<HTMLButtonElement>('button[data-tag]').forEach(button => {
    button.disabled = saving;
  });
}

function togglePreviewTagDropdown(force?: boolean): void {
  const dropdown = requiredHtml('preview-tag-dropdown');
  const open = force === undefined ? !dropdown.classList.contains('open') : Boolean(force);
  dropdown.classList.toggle('open', open);
  if (open) renderPreviewTagDropdown();
}

function renderPreviewTagDropdown(): void {
  const dropdown = optionalHtml('preview-tag-dropdown');
  if (!dropdown) return;
  const img = viewerCoordinator.currentImage;
  const used = new Set((img ? img.tags || [] : []).map(normalizeTag));
  const tags = tagCatalog.names.filter(tag => !used.has(normalizeTag(tag)));
  dropdown.innerHTML = tags.length
    ? tags.map(tag => `<button class="preview-pick-tag" type="button" data-tag="${escAttr(tag)}">${renderTagChip(tag, {count: true})}</button>`).join('')
    : `<span class="muted-inline">Нет доступных тегов для добавления</span>`;
  dropdown.querySelectorAll<HTMLElement>('button[data-tag]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (await addTagToPreview(btn.dataset.tag)) togglePreviewTagDropdown(false);
    });
  });
  updatePreviewTagSavingState();
}

async function addTagFromPreviewInput(): Promise<void> {
  await commitPreviewTagInput();
}

async function commitPreviewTagInput(tagOverride = ''): Promise<boolean> {
  const input = requiredInput('preview-tag-input');
  const inputValue = input.value;
  const value = String(tagOverride || inputValue).trim();
  const imageId = viewerCoordinator.currentImageId;
  if (!value || !imageId) return false;
  const saved = await addTagToPreview(value);
  if (saved && viewerCoordinator.currentImageId === imageId && input.value === inputValue) {
    input.value = '';
    updateFishGhosts();
  }
  return saved;
}

async function addTagToPreview(tag: string | undefined): Promise<boolean> {
  if (!tag) return false;
  const img = viewerCoordinator.currentImage;
  if (!img) return false;
  const newTags = dedupeDisplayTags([...(img.user_tags || []), tagCatalog.findDisplayTag(tag)]);
  return saveTags(img.id, newTags);
}

async function removeTagFromPreview(tag: string | undefined): Promise<boolean> {
  if (!tag) return false;
  const img = viewerCoordinator.currentImage;
  if (!img) return false;
  const newTags = (img.user_tags || []).filter(t => normalizeTag(t) !== normalizeTag(tag));
  return saveTags(img.id, newTags);
}

async function saveTags(id: string, userTags: string[]): Promise<boolean> {
  if (tagSavesInFlight.has(id)) return false;
  tagSavesInFlight.add(id);
  updatePreviewTagSavingState();
  let postCommitted = false;
  try {
    const r = await fetch(`/api/tag/${id}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tags: userTags})
    });
    if (!r.ok) throw new Error(await readError(r));
    postCommitted = true;
    const updated = await readJsonRecord(r);
    updateImageTags(id, updated);
    const catalogResult = await refreshTagPool();
    if (catalogResult === 'failed') {
      showNotification('Теги сохранены, но список тегов не удалось обновить', 'warning', {
        key: 'tag-save',
        persistent: true,
      });
    } else {
      showNotification('Теги сохранены', 'success', {key: 'tag-save'});
    }
    return true;
  } catch (e) {
    console.error(e);
    if (postCommitted) {
      showNotification('Теги сохранены, но интерфейс не удалось обновить: ' + errorMessage(e), 'warning', {
        key: 'tag-save',
        persistent: true,
      });
      return true;
    }
    showNotification('Не удалось сохранить теги: ' + errorMessage(e), 'error', {
      key: 'tag-save',
      persistent: true,
    });
    return false;
  } finally {
    tagSavesInFlight.delete(id);
    updatePreviewTagSavingState();
  }
}

function updateImageTags(id: string, updated: JsonRecord): void {
  let updatedImage: ImageItem | null = null;
  for (const list of [allImages, visibleImages]) {
    const img = list.find(item => item.id === id);
    if (!img) continue;
    img.tags = stringArray(updated.tags);
    img.auto_tags = stringArray(updated.auto_tags).length ? stringArray(updated.auto_tags) : stringArray(updated.folder_tags);
    img.folder_tags = img.auto_tags;
    img.user_tags = stringArray(updated.user_tags);
    updatedImage = img;
  }
  if (updatedImage) {
    setTagPool([...tagCatalog.names, ...(updatedImage.tags || [])]);
    const previewImage = viewerCoordinator.currentImage;
    if (previewImage && previewImage.id === id) renderPreviewTags(previewImage);
    updateCardForImage(updatedImage);
    updateFishGhosts();
  }
}

function forwardGalleryArrowKeyDown(direction: GalleryArrowDirection, repeat: boolean): void {
  if (sendGalleryArrowInputNative(direction, 'down', repeat)) {
    forwardedGalleryArrowDirections.add(direction);
    return;
  }
  window.scrollBy({
    top: direction === 'down' ? GALLERY_BROWSER_ARROW_STEP : -GALLERY_BROWSER_ARROW_STEP,
    behavior: 'auto',
  });
}

function forwardGalleryArrowKeyUp(code: string): void {
  const direction = code === 'KeyJ' ? 'down' : code === 'KeyK' ? 'up' : null;
  if (!direction || !forwardedGalleryArrowDirections.delete(direction)) return;
  sendGalleryArrowInputNative(direction, 'up', false);
}

function resolveShortcutContext(): ShortcutContext {
  if (activeWorkspace === 'settings') return 'settings';
  if (viewerCoordinator.isOpen) return 'viewer';
  return activeWorkspace === 'gallery' ? 'gallery' : 'blocked';
}

function isPlainCharacter(event: KeyboardEvent, key: string): boolean {
  return event.key === key && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}

function isPlainCode(event: KeyboardEvent, code: string): boolean {
  return event.code === code && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}

function resolveShortcut(event: KeyboardEvent, context: ShortcutContext): AppCommand | null {
  const controlOnly = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  if (controlOnly && event.code === 'KeyT') return 'gallery.newTab';
  if (controlOnly && event.code === 'KeyW') return 'gallery.closeTab';
  if (controlOnly && event.code === 'KeyO') {
    if (context === 'gallery') return 'gallery.focusTagSearch';
    if (context === 'viewer') return 'ui.consumeShortcut';
  }

  if (event.key === 'Escape' || isPlainCode(event, 'KeyQ')) {
    if (context === 'viewer') return 'viewer.close';
    if (context === 'settings') return 'settings.close';
    return null;
  }

  const tabShortcut = event.key === 'Tab'
    && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
  const panelShortcut = event.key.toLowerCase() === 'b'
    && event.ctrlKey && !event.altKey && !event.metaKey;
  if ((context === 'gallery' || context === 'viewer') && tabShortcut) return 'ui.toggleFocus';
  if ((context === 'gallery' || context === 'viewer') && panelShortcut) return 'ui.toggleSidePanel';

  if (context === 'gallery') {
    if (isPlainCharacter(event, 'j')) return 'gallery.moveDown';
    if (isPlainCharacter(event, 'k')) return 'gallery.moveUp';
    return null;
  }
  if (context !== 'viewer') return null;

  if (isPlainCharacter(event, 'h')) return 'viewer.panLeft';
  if (isPlainCharacter(event, 'j')) return 'viewer.panDown';
  if (isPlainCharacter(event, 'k')) return 'viewer.panUp';
  if (isPlainCharacter(event, 'l')) return 'viewer.panRight';
  if (isPlainCharacter(event, 'i')) return 'viewer.zoomIn';
  if (isPlainCharacter(event, 'o')) return 'viewer.zoomOut';
  if (isPlainCode(event, 'KeyT')) return 'viewer.focusTagInput';
  if (isPlainCharacter(event, 'p')) return 'viewer.previousImage';
  if (isPlainCharacter(event, 'n')) return 'viewer.nextImage';
  if (event.key === 'ArrowRight') return 'viewer.nextImage';
  if (event.key === 'ArrowLeft') return 'viewer.previousImage';
  if (event.key.toLowerCase() === 'f') return 'viewer.fit';
  if (event.key === '1') return 'viewer.actualSize';
  if (event.key === '+' || event.key === '=') return 'viewer.zoomIn';
  if (event.key === '-') return 'viewer.zoomOut';
  if (event.code === 'Space') return 'viewer.quickMenu';
  return null;
}

function dispatchCommand(command: AppCommand, context: ShortcutContext, event: KeyboardEvent): void {
  switch (command) {
    case 'ui.consumeShortcut':
      break;
    case 'ui.toggleFocus':
      if (context === 'viewer') viewerCoordinator.toggleFocus();
      else if (context === 'gallery') toggleGalleryFocusMode();
      break;
    case 'ui.toggleSidePanel':
      if (context === 'viewer') viewerCoordinator.toggleInspector();
      else if (context === 'gallery') toggleFolderSidebar();
      break;
    case 'gallery.newTab':
      addTab();
      break;
    case 'gallery.closeTab':
      closeTab(activeTab().id);
      break;
    case 'gallery.focusTagSearch':
      focusGalleryTagSearch();
      break;
    case 'gallery.moveDown':
      forwardGalleryArrowKeyDown('down', event.repeat);
      break;
    case 'gallery.moveUp':
      forwardGalleryArrowKeyDown('up', event.repeat);
      break;
    case 'viewer.panLeft':
      previewModal?.panBy(VIEWER_KEYBOARD_PAN_STEP, 0);
      break;
    case 'viewer.panDown':
      previewModal?.panBy(0, -VIEWER_KEYBOARD_PAN_STEP);
      break;
    case 'viewer.panUp':
      previewModal?.panBy(0, VIEWER_KEYBOARD_PAN_STEP);
      break;
    case 'viewer.panRight':
      previewModal?.panBy(-VIEWER_KEYBOARD_PAN_STEP, 0);
      break;
    case 'viewer.zoomIn':
      previewModal?.zoomBy(1.2);
      break;
    case 'viewer.zoomOut':
      previewModal?.zoomBy(1 / 1.2);
      break;
    case 'viewer.nextImage':
      viewerCoordinator.navigate(1);
      break;
    case 'viewer.previousImage':
      viewerCoordinator.navigate(-1);
      break;
    case 'viewer.fit':
      previewModal?.fit();
      break;
    case 'viewer.actualSize':
      previewModal?.oneToOne();
      break;
    case 'viewer.quickMenu':
      openPreviewQuickMenu(window.innerWidth / 2 - 90, window.innerHeight / 2 - 120);
      break;
    case 'viewer.focusTagInput':
      focusPreviewTagInput();
      break;
    case 'viewer.close':
      previewModal?.close();
      break;
    case 'settings.close':
      toggleSettings(false);
      break;
  }
}

document.addEventListener('keydown', event => {
  const context = resolveShortcutContext();
  const numberedTab = event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey
    && /^Digit[1-9]$/.test(event.code)
    ? Number(event.code.slice(-1)) - 1
    : null;
  if (numberedTab !== null) {
    event.preventDefault();
    switchTabByVisibleIndex(numberedTab);
    return;
  }
  const command = resolveShortcut(event, context);
  const preserveContextEscape = event.key === 'Escape' && context === 'settings';
  const applicationCommand = command === 'gallery.newTab'
    || command === 'gallery.closeTab'
    || command === 'gallery.focusTagSearch'
    || command === 'ui.consumeShortcut';
  if (isTextEntryTarget(event.target) && !preserveContextEscape && !applicationCommand) return;
  if (!command) return;
  event.preventDefault();
  dispatchCommand(command, context, event);
});

document.addEventListener('keyup', event => {
  forwardGalleryArrowKeyUp(event.code);
});

function saveSessionSoon(): void {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, 250);
}

async function saveSession(): Promise<void> {
  saveActiveScroll();
  const tab = activeTab();
  const body = serializeGallerySession(galleryTabs.list, galleryTabs.activeId, tab);
  try {
    await fetch('/api/session', {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
  } catch {}
}

async function loadSession(): Promise<void> {
  const requestId = ++activeSessionRequest;
  sessionRequestPending = true;
  updateEmptyStateMessage();
  try {
    const r = await fetch('/api/session');
    if (!r.ok) throw new Error(await readError(r));
    const s = await readJsonRecord(r);
    if (requestId !== activeSessionRequest) return;
    sessionRequestPending = false;
    galleryLoadFailure = null;
    dismissNotification('gallery-load');
    folderTagSync = s.folder_tag_sync !== false;
    renderFolderTagSyncSetting();
    const restoredTabs = normalizeTabs(s.tabs, s, dedupeDisplayTags);
    const activeId = typeof s.active_tab_id === 'string' ? s.active_tab_id : null;
    galleryTabs.restore(restoredTabs, activeId);
    renderTabs();
    renderFilterControls();
    const rootPath = typeof s.root_path === 'string' ? s.root_path : '';
    scannedRoots = Array.isArray(s.root_paths) ? stringArray(s.root_paths) : (rootPath ? [rootPath] : []);
    const currentRoot = scannedRoots[scannedRoots.length - 1] || rootPath;
    if (currentRoot) {
      setFolderInputValues(currentRoot);
      updateRootSummary();
      await refreshFolderTree();
      if (requestId !== activeSessionRequest) return;
      showGallery();
      startStatusPolling();
      pendingGalleryScrollTop = activeTab().scrollTop || 0;
      await refreshImages(true);
    } else {
      showSetup();
      pollStatus();
    }
  } catch (e) {
    if (requestId !== activeSessionRequest) return;
    sessionRequestPending = false;
    galleryTabs.reset();
    renderTabs();
    renderFilterControls();
    showSetup();
    const message = errorMessage(e);
    galleryLoadFailure = {message, retry: 'session'};
    setDbStatus(false, message);
    updateEmptyStateMessage();
  }
}

function initPreview(): void {
  let handleClosed: () => void = () => undefined;
  previewModal = new PreviewModal({}, () => handleClosed());
  viewerCoordinator = new ViewerCoordinator({
    modal: previewModal,
    gallery: {
      getVisibleImages: () => visibleImages,
      getAllImages: () => allImages,
      hasMorePages: () => hasMorePages,
      loadNextPage: loadNextImagesPage,
      clearPendingAnchor: () => { pendingGalleryAnchorImageId = null; },
      scheduleAnchorRestore: scheduleGalleryAnchorRestore,
    },
    session: {
      getLastImageId: () => activeTab().lastImageId,
      setLastImageId: imageId => { activeTab().lastImageId = imageId; },
      hasTabs: () => galleryTabs.list.length > 0,
      saveSessionSoon,
      isGalleryActive: () => activeWorkspace === 'gallery',
    },
    ui: {
      closeTransientUi: () => {
        togglePreviewTagDropdown(false);
        closePreviewQuickMenu();
      },
      renderImage: renderPreviewMeta,
      renderFilmstrip: renderPreviewFilmstrip,
      renderViewerUiState: renderPreviewUiState,
      refreshSourceUi: refreshPreviewSourceUi,
      measureFilmstripCapacity: measurePreviewFilmNearbyCapacity,
      refreshPreviewLayout,
      setBodyLocked: locked => { document.body.style.overflow = locked ? 'hidden' : ''; },
      thumbnailUrls,
      fileName,
      diagnoseOriginalFailure: diagnosePreviewOriginalFailure,
    },
    normalizeTag,
  });
  handleClosed = () => viewerCoordinator.handleModalClosed();
}

function readGalleryGeometry(): GalleryGeometry {
  const gallery = requiredHtml('gallery');
  const styles = getComputedStyle(gallery);
  const gap = Number.parseFloat(styles.columnGap || styles.gap || '') || 10;
  const scrollMargin = gallery.getBoundingClientRect().top + window.scrollY;
  return computeGalleryGeometry({
    galleryWidth: gallery.clientWidth,
    viewportWidth: window.innerWidth,
    gap,
    scrollMargin,
  });
}

function updateThumbnailScrollState(
  instance: Virtualizer<Window, HTMLDivElement>,
  sync: boolean,
): void {
  const now = performance.now();
  const offset = Number.isFinite(instance.scrollOffset) ? Number(instance.scrollOffset) : window.scrollY;
  const previousOffset = thumbnailScrollState.offset;
  const previousSampledAt = thumbnailScrollState.sampledAt;
  const offsetChanged = previousOffset === null || Math.abs(offset - previousOffset) >= 0.5;
  if (instance.scrollDirection) thumbnailScrollState.direction = instance.scrollDirection;
  if (!sync) {
    if (thumbnailScrollSettleTimer) clearTimeout(thumbnailScrollSettleTimer);
    thumbnailScrollSettleTimer = null;
    thumbnailScrollState.offset = offset;
    thumbnailScrollState.sampledAt = now;
    thumbnailScrollState.velocity = 0;
    thumbnailScrollState.scrolling = false;
    thumbnailScrollState.fast = false;
    thumbnailScrollState.fastSamples = 0;
    thumbnailScrollState.slowSamples = 0;
    return;
  }
  thumbnailScrollState.scrolling = true;
  if (offsetChanged || !thumbnailScrollSettleTimer) {
    if (thumbnailScrollSettleTimer) clearTimeout(thumbnailScrollSettleTimer);
    thumbnailScrollSettleTimer = setTimeout(() => {
      thumbnailScrollSettleTimer = null;
      thumbnailScrollState.velocity = 0;
      thumbnailScrollState.scrolling = false;
      thumbnailScrollState.fast = false;
      thumbnailScrollState.fastSamples = 0;
      thumbnailScrollState.slowSamples = 0;
      reevaluateThumbnailAdmissions(instance);
    }, THUMB_SCROLL_SETTLE_FALLBACK_MS);
  }
  if (previousOffset !== null && previousSampledAt !== null) {
    const elapsed = now - previousSampledAt;
    const delta = offset - previousOffset;
    if (!instance.scrollDirection && delta !== 0) {
      thumbnailScrollState.direction = delta > 0 ? 'forward' : 'backward';
    }
    if (elapsed > 0 && elapsed <= THUMB_SCROLL_SAMPLE_MAX_MS) {
      const sample = Math.abs(delta) / elapsed;
      thumbnailScrollState.velocity = thumbnailScrollState.velocity === 0
        ? sample
        : THUMB_VELOCITY_EMA_ALPHA * sample
          + (1 - THUMB_VELOCITY_EMA_ALPHA) * thumbnailScrollState.velocity;
      if (thumbnailScrollState.fast) {
        thumbnailScrollState.slowSamples = thumbnailScrollState.velocity <= THUMB_FAST_EXIT_THRESHOLD
          ? thumbnailScrollState.slowSamples + 1
          : 0;
        if (thumbnailScrollState.slowSamples >= THUMB_FAST_EXIT_SAMPLES) {
          thumbnailScrollState.fast = false;
          thumbnailScrollState.fastSamples = 0;
        }
      } else {
        thumbnailScrollState.fastSamples = thumbnailScrollState.velocity >= THUMB_FAST_ENTER_THRESHOLD
          ? thumbnailScrollState.fastSamples + 1
          : 0;
        if (thumbnailScrollState.fastSamples >= THUMB_FAST_ENTER_SAMPLES) {
          thumbnailScrollState.fast = true;
          thumbnailScrollState.slowSamples = 0;
        }
      }
    }
  }
  thumbnailScrollState.offset = offset;
  thumbnailScrollState.sampledAt = now;
}

function reevaluateThumbnailAdmissions(
  instance: Virtualizer<Window, HTMLDivElement> | null = galleryVirtualizerController.current,
): void {
  if (!instance || !galleryGeometry || thumbnailScrollState.fast) return;
  const visible: ThumbLifecycle[] = [];
  const near: ThumbLifecycle[] = [];
  const viewport = {scrollY: window.scrollY, height: window.innerHeight};
  for (const item of instance.getVirtualItems()) {
    const image = visibleImages[item.index];
    if (!image) continue;
    const lifecycle = thumbnailLifecycles.get(image.id);
    if (!lifecycle || !thumbnailLifecycles.isCurrent(lifecycle)) continue;
    if (virtualItemIsVisible(item, galleryGeometry, viewport)) {
      visible.push(lifecycle);
    } else if (
      lifecycle.state === 'missing'
      && virtualItemIsNear(item, galleryGeometry, thumbnailScrollState.direction, viewport)
    ) {
      near.push(lifecycle);
    }
  }
  for (const lifecycle of visible) {
    if (lifecycle.state === 'missing') void thumbnailLifecycles.admit(lifecycle, 'visible');
  }
  if (visible.length > 0 || thumbnailScrollState.scrolling) return;
  for (const lifecycle of near) void thumbnailLifecycles.admit(lifecycle, 'near');
}

function scheduleThumbnailAdmissionEvaluation(): void {
  if (thumbnailAdmissionFrame !== null) return;
  thumbnailAdmissionFrame = requestAnimationFrame(() => {
    thumbnailAdmissionFrame = null;
    reevaluateThumbnailAdmissions();
  });
}

function handleGalleryVirtualizerChange(
  instance: Virtualizer<Window, HTMLDivElement>,
  sync: boolean,
): void {
  updateThumbnailScrollState(instance, sync);
  galleryDiagnostics.virtualizerChanged(
    sync,
    Number.isFinite(instance.scrollOffset) ? Number(instance.scrollOffset) : null,
    instance.scrollDirection,
  );
  renderVirtualGalleryRange(instance);
  reevaluateThumbnailAdmissions(instance);
  schedulePaginationPrefetch(instance);
}

function renderVirtualGalleryRange(instance = galleryVirtualizerController.current): void {
  if (!instance || !galleryGeometry) return;
  virtualGalleryView.render(instance, galleryGeometry, visibleImages);
}

function ensureGalleryVirtualizer(): Virtualizer<Window, HTMLDivElement> {
  galleryGeometry = readGalleryGeometry();
  return galleryVirtualizerController.ensure(galleryGeometry);
}

function captureGalleryAnchor(): {imageId: string; viewportTop: number} | null {
  const mountedCards: Array<{imageId: string; rect: DOMRect}> = [];
  virtualGalleryView.forEachMounted((mounted, imageId) => {
    mountedCards.push({imageId, rect: mounted.slot.getBoundingClientRect()});
  });
  const candidates = mountedCards
    .filter(item => item.rect.bottom > 0 && item.rect.top < window.innerHeight)
    .sort((left, right) => Math.abs(left.rect.top) - Math.abs(right.rect.top));
  const anchor = candidates[0];
  return anchor ? {imageId: anchor.imageId, viewportTop: anchor.rect.top} : null;
}

function restoreGalleryAnchor(anchor: {imageId: string; viewportTop: number} | null): void {
  const instance = galleryVirtualizerController.current;
  if (!anchor || !instance) return;
  const index = visibleImages.findIndex(image => image.id === anchor.imageId);
  if (index < 0) return;
  const item = instance.measurementsCache[index];
  if (!item) return;
  instance.scrollToOffset(Math.max(0, item.start - anchor.viewportTop), {behavior: 'instant'});
  requestAnimationFrame(() => {
    const mounted = virtualGalleryView.getMounted(anchor.imageId);
    if (!mounted) return;
    const delta = mounted.slot.getBoundingClientRect().top - anchor.viewportTop;
    if (Math.abs(delta) > 0.5) window.scrollTo(0, Math.max(0, window.scrollY + delta));
  });
}

function scheduleGalleryAnchorRestore(imageId: string): void {
  pendingGalleryAnchorImageId = imageId;
  requestAnimationFrame(() => restorePendingGalleryAnchor(imageId, 0));
}

function restorePendingGalleryAnchor(imageId: string, frame: number): void {
  if (pendingGalleryAnchorImageId !== imageId) return;
  if (viewerCoordinator.isOpen || activeWorkspace !== 'gallery') {
    pendingGalleryAnchorImageId = null;
    return;
  }
  const index = visibleImages.findIndex(image => image.id === imageId);
  if (index < 0) {
    pendingGalleryAnchorImageId = null;
    return;
  }
  const instance = ensureGalleryVirtualizer();
  if (frame === 0) instance.scrollToIndex(index, {align: 'center', behavior: 'instant'});
  renderVirtualGalleryRange(instance);
  const mounted = virtualGalleryView.getMounted(imageId);
  if (!mounted && frame < 2) {
    requestAnimationFrame(() => restorePendingGalleryAnchor(imageId, frame + 1));
    return;
  }
  if (mounted) {
    const rect = mounted.slot.getBoundingClientRect();
    const targetCenter = rect.top + rect.height / 2;
    const viewportCenter = window.innerHeight / 2;
    if (Math.abs(targetCenter - viewportCenter) > 1) {
      window.scrollTo(0, Math.max(0, window.scrollY + targetCenter - viewportCenter));
    }
  }
  pendingGalleryAnchorImageId = null;
  saveActiveScroll();
  saveSessionSoon();
}

function invalidateVirtualGallery(options: {preserveAnchor: boolean; resetCards: boolean}): void {
  const anchor = options.preserveAnchor ? captureGalleryAnchor() : null;
  if (options.resetCards) virtualGalleryView.clear();
  const instance = ensureGalleryVirtualizer();
  instance.measure();
  renderVirtualGalleryRange(instance);
  if (anchor) requestAnimationFrame(() => restoreGalleryAnchor(anchor));
}

function updateVirtualGalleryCount(): void {
  const diagnosticStartedAt = galleryDiagnostics.recording ? performance.now() : 0;
  const instance = ensureGalleryVirtualizer();
  galleryVirtualizerController.setOptions(galleryGeometry!);
  galleryVirtualizerController.willUpdate();
  renderVirtualGalleryRange(instance);
  schedulePaginationPrefetch(instance);
  if (galleryDiagnostics.recording) {
    galleryDiagnostics.measureVirtualizerUpdate(performance.now() - diagnosticStartedAt);
  }
}

function captureMountedCardsForDiagnostics(): void {
  galleryDiagnostics.setLoadedMetadataCount(allImages.length);
  virtualGalleryView.forEachMounted((mounted, imageId) => {
    const image = mounted.card.querySelector<HTMLImageElement>('img');
    const index = Number(mounted.slot.dataset.index);
    if (!image || !Number.isInteger(index)) return;
    const reference = galleryDiagnostics.cardMounted(
      imageId,
      index,
      image.complete && image.naturalWidth > 0,
    );
    bindDiagnosticCardRef(image, reference);
  });
  const instance = galleryVirtualizerController.current;
  if (instance) renderVirtualGalleryRange(instance);
}

function schedulePaginationPrefetch(instance: Virtualizer<Window, HTMLDivElement>): void {
  if (paginationPrefetchFrame !== null || !hasMorePages || isLoadingPage) return;
  paginationPrefetchFrame = requestAnimationFrame(() => {
    paginationPrefetchFrame = null;
    const items = instance.getVirtualItems();
    const last = items[items.length - 1];
    const threshold = Math.max(PAGE, (galleryGeometry?.laneCount || 1) * 8);
    if (last && last.index >= visibleImages.length - threshold) void loadNextImagesPage();
  });
}

function galleryContentBottom(): number {
  const instance = galleryVirtualizerController.current;
  if (!instance || !galleryGeometry) return 0;
  return galleryGeometry.scrollMargin + instance.getTotalSize();
}

async function restorePendingGalleryScroll(requestId: number): Promise<void> {
  if (requestId !== activeImagesRequest || pendingGalleryScrollTop === null) return;
  const target = Math.max(0, pendingGalleryScrollTop);
  pendingGalleryScrollTop = null;
  while (hasMorePages && galleryContentBottom() < target + window.innerHeight * 1.5) {
    if (requestId !== activeImagesRequest) return;
    const previousCount = visibleImages.length;
    await loadNextImagesPage();
    if (requestId !== activeImagesRequest) return;
    if (visibleImages.length <= previousCount) break;
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  if (requestId !== activeImagesRequest) return;
  galleryVirtualizerController.current?.scrollToOffset(target, {behavior: 'instant'});
}

function scheduleGalleryResize(anchor: {imageId: string; viewportTop: number} | null): void {
  if (galleryResizeFrame !== null) cancelAnimationFrame(galleryResizeFrame);
  galleryResizeFrame = requestAnimationFrame(() => {
    galleryResizeFrame = null;
    galleryGeometry = readGalleryGeometry();
    const instance = ensureGalleryVirtualizer();
    instance.measure();
    renderVirtualGalleryRange(instance);
    requestAnimationFrame(() => restoreGalleryAnchor(anchor));
  });
}

function handleGalleryResize(): void {
  scheduleGalleryResize(captureGalleryAnchor());
}

function setTagPool(rawTags: unknown): void {
  tagCatalogRevision += 1;
  tagCatalog.replace(rawTags);
  renderSidebarTags();
  renderBatchTagPanel();
}

function renderSidebarTags(): void {
  const autoTarget = optionalHtml('sidebar-auto-tags');
  const userTarget = optionalHtml('sidebar-user-tags');
  if (!autoTarget || !userTarget) return;
  const query = normalizeTag(optionalInput('sidebar-tag-search')?.value || '');
  const tab = galleryTabs.list.length ? activeTab() : null;
  const included = new Set((tab?.includeTags || []).map(normalizeTag));
  const excluded = new Set((tab?.excludeTags || []).map(normalizeTag));
  const tags = tagCatalog.names.map(tag => tagCatalog.getMeta(tag))
    .filter(tag => !query || normalizeTag(tag.name).includes(query))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, {sensitivity: 'base'}));
  const renderRows = (items: TagMeta[], auto: boolean): string => items.length
    ? items.map(tag => {
      const norm = normalizeTag(tag.name);
      const state = included.has(norm) ? 'selected' : (excluded.has(norm) ? 'excluded' : '');
      return `
        <button class="sidebar-tag-row ${state}" type="button" data-sidebar-tag="${escAttr(tag.name)}" aria-pressed="${state === 'selected'}">
          <span class="sidebar-tag-name">${escHtml(tag.name)}</span>
          ${auto ? '<span class="auto-label">AUTO</span>' : ''}
          <span class="sidebar-tag-count">${Number(tag.image_count || 0)}</span>
        </button>
      `;
    }).join('')
    : '<div class="sidebar-empty">Нет тегов</div>';
  autoTarget.innerHTML = renderRows(tags.filter(tag => tag.auto_count > 0), true);
  userTarget.innerHTML = renderRows(tags.filter(tag => tag.auto_count <= 0 && (tag.user_defined || tag.user_count > 0)), false);
  document.querySelectorAll<HTMLElement>('[data-sidebar-tag]').forEach(button => {
    button.addEventListener('click', () => {
      const tag = button.dataset.sidebarTag;
      if (!tag) return;
      if (included.has(normalizeTag(tag))) removeFilterTag('include', tag);
      else addFilterTag('include', tag);
    });
  });
  const total = optionalHtml('sidebar-tag-total');
  if (total) total.textContent = String(tags.length);
}

function normalizeHexColor(value: unknown, fallback = '#D4D4D4'): string {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : fallback;
}

function hexToRgbTriplet(hex: unknown): string {
  const color = normalizeHexColor(hex);
  const value = color.slice(1);
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ].join(', ');
}

function renderTagChip(tag: unknown, options: TagChipOptions = {}): string {
  const name = tagName(tag);
  const meta = tagCatalog.getMeta(name);
  const color = normalizeHexColor(meta.color, '#D4D4D4');
  const rgb = hexToRgbTriplet(color);
  const classes = [
    'tag-chip-base',
    options.className || '',
    meta.color ? 'has-color' : '',
    options.exclude ? 'is-exclude' : ''
  ].filter(Boolean).join(' ');
  const label = `${options.exclude ? '!' : ''}${name}`;
  const count = options.count ? `<span class="tag-count">${Number(meta.image_count || 0)}</span>` : '';
  const source = meta.is_auto ? '<span class="auto-label">AUTO</span>' : '';
  const remove = options.removable
    ? `<button type="button" data-kind="${escAttr(options.actionKind || '')}" data-tag="${escAttr(name)}">×</button>`
    : '';
  return `<span class="${classes}" style="--tag-color:${escAttr(color)};--tag-rgb:${escAttr(rgb)}" title="${escAttr(label)}"><span class="tag-label">${escHtml(label)}</span>${source}${count}${remove}</span>`;
}

function cssEscape(value: unknown): string {
  const text = String(value);
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
  return text.replace(/"/g, '\\"');
}

function escAttr(s: unknown): string {
  return escHtml(s);
}

function runAction(actionEl: HTMLElement): void {
  const action = actionEl.dataset.action;
  switch (action) {
    case 'app-notification-action':
      runNotificationAction();
      break;
    case 'app-notification-dismiss':
      dismissNotification();
      break;
    case 'add-tab':
      addTab();
      break;
    case 'apply-batch-tags':
      void applyBatchTagChanges();
      break;
    case 'cancel-batch-add':
      cancelBatchTagAddition(String(actionEl.dataset.tag || ''));
      break;
    case 'close-batch-tags':
      toggleBatchTagPanel(false);
      break;
    case 'add-tag-from-preview-input':
      addTagFromPreviewInput();
      break;
    case 'clear-active-filters':
      clearActiveFilters();
      break;
    case 'clear-image-selection':
      clearImageSelection();
      break;
    case 'close-preview':
      viewerCoordinator.close();
      break;
    case 'create-tag-from-settings':
      createTagFromSettings();
      break;
    case 'delete-all-auto-tags':
      void deleteAllAutoTags();
      break;
    case 'disconnect-folder':
      void disconnectFolder(String(actionEl.dataset.root || ''));
      break;
    case 'empty-state-action':
      runEmptyStateAction(actionEl.dataset.emptyAction);
      break;
    case 'open-folder':
      openFolder();
      break;
    case 'open-gallery-diagnostics':
      galleryDiagnostics.openPanel();
      break;
    case 'queue-batch-tag':
      queueBatchTagFromInput();
      break;
    case 'show-gallery-view':
      showGalleryView();
      break;
    case 'show-problems-view':
      showProblemsView();
      break;
    case 'set-problems-filter':
      problemsWorkspace.setFilter(actionEl.dataset.severity);
      break;
    case 'load-more-problems':
      void problemsWorkspace.load(false);
      break;
    case 'retry-problems':
      problemsWorkspace.scheduleRefresh();
      break;
    case 'recheck-problem':
      void problemsWorkspace.recheck(Number(actionEl.dataset.problemId));
      break;
    case 'recheck-all-problems':
      void problemsWorkspace.recheckAll();
      break;
    case 'reveal-problem':
      void problemsWorkspace.reveal(Number(actionEl.dataset.problemId));
      break;
    case 'pick-folder':
      pickFolder();
      break;
    case 'preview-fit':
      previewModal?.fit();
      break;
    case 'preview-one-to-one':
      previewModal?.oneToOne();
      break;
    case 'preview-zoom':
      previewModal?.zoomBy(Number(actionEl.dataset.factor || 1));
      break;
    case 'preview-nav':
      viewerCoordinator.navigate(Number(actionEl.dataset.dir || 0));
      break;
    case 'scroll-to-top':
      scrollToTop();
      break;
    case 'set-match-mode':
      setMatchMode(actionEl.dataset.mode);
      break;
    case 'set-preview-film-mode':
      viewerCoordinator.setFilmMode(actionEl.dataset.mode);
      break;
    case 'set-settings-tab':
      setSettingsTab(actionEl.dataset.settingsTab);
      break;
    case 'toggle-folder-sidebar':
      toggleFolderSidebar();
      break;
    case 'toggle-batch-remove':
      toggleBatchTagRemoval(String(actionEl.dataset.tag || ''));
      break;
    case 'toggle-batch-tags':
      toggleBatchTagPanel();
      break;
    case 'toggle-gallery-focus':
      toggleGalleryFocusMode();
      break;
    case 'toggle-preview-focus':
      viewerCoordinator.toggleFocus();
      break;
    case 'toggle-preview-inspector':
      viewerCoordinator.toggleInspector();
      break;
    case 'toggle-preview-tag-dropdown':
      togglePreviewTagDropdown();
      break;
    case 'toggle-settings':
      if (actionEl.dataset.open === undefined) toggleSettings();
      else toggleSettings(actionEl.dataset.open === 'true');
      break;
  }
}

function initActionBindings(): void {
  document.addEventListener('click', e => {
    const actionEl = closestFromEvent(e, '[data-action]');
    if (!actionEl) return;
    runAction(actionEl);
  });

  document.addEventListener('change', e => {
    const actionEl = closestFromEvent(e, '[data-action]');
    if (!actionEl) return;
    if (actionEl.dataset.action === 'set-sort-mode') setSortMode(actionValue(actionEl));
    else if (actionEl.dataset.action === 'set-tag-admin-sort') setTagAdminSort(actionValue(actionEl));
    else if (actionEl.dataset.action === 'toggle-folder-tag-sync' && actionEl instanceof HTMLInputElement) {
      void setFolderTagSync(actionEl.checked);
    }
  });
}

document.addEventListener('click', e => {
  const targetNode = e.target instanceof Node ? e.target : null;
  const filterWrap = document.querySelector('.filter-input-wrap');
  if (targetNode && filterWrap && !filterWrap.contains(targetNode)) {
    filterSuggestionOpen = false;
    renderFilterSuggestions();
  }
  const previewTools = document.querySelector('.preview-user-tools');
  if (targetNode && previewTools && !previewTools.contains(targetNode)) togglePreviewTagDropdown(false);
});

requiredInput('tag-admin-search').addEventListener('input', renderTagAdmin);
requiredInput('sidebar-tag-search').addEventListener('input', renderSidebarTags);
requiredInput('problems-search').addEventListener('input', () => problemsWorkspace.handleSearchInput());
requiredInput('tag-admin-create').addEventListener('keydown', e => {
  if (e.key === 'Enter') createTagFromSettings();
});
requiredInput('batch-tag-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  queueBatchTagFromInput();
});
window.addEventListener('scroll', updateScrollTopButton, {passive: true});
window.addEventListener('resize', () => {
  handleGalleryResize();
  if (viewerCoordinator.isOpen) viewerCoordinator.scheduleFilmstripLayoutRefresh();
});
document.addEventListener('visibilitychange', () => problemsWorkspace.handleVisibilityChange());

initActionBindings();
initPreview();
initPreviewQuickMenu();
galleryDiagnostics.install({
  captureMountedCards: captureMountedCardsForDiagnostics,
  isGalleryActive: () => activeWorkspace === 'gallery'
    && !viewerCoordinator.isOpen
});
initFilterInput();
initFishInputs();
startLiveEvents();
problemsWorkspace.startPolling();
updateScrollTopButton();
renderGalleryUiState();
renderPreviewUiState();
loadSession();
