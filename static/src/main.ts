type MatchMode = 'any' | 'all';
type SortMode = 'path_asc' | 'path_desc' | 'date_desc' | 'date_asc' | 'size_desc' | 'size_asc';
type SettingsTab = 'general' | 'tags' | 'graph';
type GraphScope = 'current' | 'all';
type TagAdminSort = 'name' | 'image_count' | 'user_count' | 'auto_count';
type TagKind = 'include' | 'exclude';
type ElementConstructor<T extends Element> = { new (...args: any[]): T };
type JsonRecord = Record<string, unknown>;

interface TagMeta {
  name: string;
  normalized: string;
  color: string | null;
  image_count: number;
  auto_count: number;
  user_count: number;
  user_defined: boolean;
  is_auto: boolean;
  source: 'auto' | 'user';
  sources: Array<'auto' | 'user'>;
}

interface ImageItem {
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

interface GalleryTab {
  id: string;
  title: string;
  includeTags: string[];
  excludeTags: string[];
  matchMode: MatchMode;
  sortMode: SortMode;
  lastImageId: string | null;
  scrollTop: number;
}

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

interface ImagePage {
  total?: unknown;
  next_cursor?: string | null;
  has_more?: boolean;
}

type ProblemSeverity = 'all' | 'error' | 'warning';

interface ProblemSummary {
  total: number;
  errors: number;
  warnings: number;
  latestUpdatedAt: string | null;
}

interface ProblemItem {
  id: number;
  imageId: string | null;
  rootPath: string;
  path: string;
  absolutePath: string;
  fileName: string;
  severity: 'error' | 'warning';
  kind: string;
  expectedFormat: string | null;
  detectedFormat: string | null;
  size: number;
  mtimeNs: number;
  technicalDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LiveEventEnvelope {
  sequence?: number;
  type: string;
  data: JsonRecord;
}

interface TagInputParse {
  prefix: string;
  value: string;
}

interface GraphBaseNode {
  id: string;
  type: 'tag' | 'image';
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

interface GraphTagNode extends GraphBaseNode {
  type: 'tag';
  tag: string;
  label: string;
}

interface GraphImageNode extends GraphBaseNode {
  type: 'image';
  imageId: string;
  image: ImageItem;
  tags: string[];
}

type GraphNode = GraphTagNode | GraphImageNode;

interface GraphEdge {
  source: string;
  target: string;
}

interface GraphPoint {
  screenX: number;
  screenY: number;
  x: number;
  y: number;
}

interface GraphState {
  open: boolean;
  scope: GraphScope;
  nodes: GraphNode[];
  edges: GraphEdge[];
  scale: number;
  panX: number;
  panY: number;
  dragNode: GraphNode | null;
  isPanning: boolean;
  pointerMoved: boolean;
  lastX: number;
  lastY: number;
  tick: number;
  raf: number | null;
  needsRebuild: boolean;
  query: string;
  nodeLimit: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

interface PreviewModalOptions {
  modalId: string;
  canvasId: string;
  closeId: string;
  zoomId: string;
  minScale: number;
  maxScale: number;
  initialViewportFill: number;
  messageType: string;
  postToParent: boolean;
}

interface FishController {
  suggestion: string;
  update?: () => void;
}

class TerminalImageUnavailableError extends Error {
  constructor(readonly imageId: string) {
    super('Изображение исключено из галереи из-за ошибки файла.');
  }
}

interface TagChipOptions {
  auto?: boolean;
  className?: string;
  count?: boolean;
  exclude?: boolean;
  removable?: boolean;
  actionKind?: 'include' | 'exclude' | '';
}

/*!
 * PreviewModal standalone lightbox for canvas images.
 *
 * Required HTML contract:
 * - #preview-modal            (overlay root)
 * - #preview-close            (close button)
 * - #preview-modal-canvas     (canvas used inside lightbox)
 * - #zoom-level               (zoom label, e.g. "100%")
 */
const PREVIEW_MODAL_DEFAULTS: PreviewModalOptions = {
  modalId: "preview-modal",
  canvasId: "preview-modal-canvas",
  closeId: "preview-close",
  zoomId: "zoom-level",
  minScale: 0.1,
  maxScale: 10,
  initialViewportFill: 0.6,
  messageType: "web-tools:preview-modal",
  postToParent: true
};

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function requireElement<T extends Element>(
  id: string,
  expected: ElementConstructor<T>,
  message: string
): T {
  const node = document.getElementById(id);
  if (!(node instanceof expected)) {
    throw new Error(`${message} (id="${id}")`);
  }
  return node;
}

function optionalElement<T extends Element>(id: string, expected: ElementConstructor<T>): T | null {
  const node = document.getElementById(id);
  return node instanceof expected ? node : null;
}

function requiredHtml(id: string): HTMLElement {
  return requireElement(id, HTMLElement, "Required page element is missing");
}

function optionalHtml(id: string): HTMLElement | null {
  return optionalElement(id, HTMLElement);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonRecord(response: Response): Promise<JsonRecord> {
  const value: unknown = await response.json();
  return isRecord(value) ? value : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

function optionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function normalizeImageItem(value: unknown): ImageItem | null {
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
    mtime: optionalNumber(value.mtime)
  };
}

function imageArray(value: unknown): ImageItem[] {
  return Array.isArray(value)
    ? value.map(normalizeImageItem).filter((item): item is ImageItem => Boolean(item))
    : [];
}

function imagesFromRecord(value: JsonRecord): ImageItem[] {
  const items = imageArray(value.items);
  return items.length || Array.isArray(value.items) ? items : imageArray(value.images);
}

function imagePage(value: unknown): ImagePage | null {
  if (!isRecord(value)) return null;
  return {
    total: value.total,
    next_cursor: typeof value.next_cursor === 'string' ? value.next_cursor : null,
    has_more: Boolean(value.has_more)
  };
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

function normalizeProblemItem(value: unknown): ProblemItem | null {
  if (!isRecord(value)) return null;
  const id = Number(value.id);
  const severity = value.severity === 'warning' ? 'warning' : value.severity === 'error' ? 'error' : null;
  if (!Number.isInteger(id) || !severity) return null;
  return {
    id,
    imageId: typeof value.image_id === 'string' ? value.image_id : null,
    rootPath: String(value.root_path || ''),
    path: String(value.path || ''),
    absolutePath: String(value.absolute_path || ''),
    fileName: String(value.file_name || fileName(value.path)),
    severity,
    kind: String(value.kind || ''),
    expectedFormat: typeof value.expected_format === 'string' ? value.expected_format : null,
    detectedFormat: typeof value.detected_format === 'string' ? value.detected_format : null,
    size: Number(value.size || 0),
    mtimeNs: Number(value.mtime_ns || 0),
    technicalDetail: typeof value.technical_detail === 'string' ? value.technical_detail : null,
    createdAt: String(value.created_at || ''),
    updatedAt: String(value.updated_at || '')
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

function getCanvas2DContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not obtain 2D context from preview canvas.");
  return ctx;
}

function eventTargetElement(event: Event): HTMLElement | null {
  return event.target instanceof HTMLElement ? event.target : null;
}

function closestFromEvent(event: Event, selector: string): HTMLElement | null {
  return eventTargetElement(event)?.closest(selector) as HTMLElement | null;
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName);
}

class PreviewModal {
  readonly options: PreviewModalOptions;
  readonly modal: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly closeBtn: HTMLElement;
  readonly zoomLevel: HTMLElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly onClosed?: () => void;
  isOpen = false;
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

  private readonly boundWheel = this.handleWheel.bind(this);
  private readonly boundMouseDown = this.handleMouseDown.bind(this);
  private readonly boundMouseMove = this.handleMouseMove.bind(this);
  private readonly boundMouseUp = this.handleMouseUp.bind(this);
  private readonly boundKeyDown = this.handleKeyDown.bind(this);
  private readonly boundBackdropClick = this.handleBackdropClick.bind(this);
  private readonly boundCloseClick = this.close.bind(this);

  constructor(options: Partial<PreviewModalOptions> = {}, onClosed?: () => void) {
    this.options = {...PREVIEW_MODAL_DEFAULTS, ...options};
    this.modal = requireElement(this.options.modalId, HTMLElement, "Preview modal element is missing");
    this.canvas = requireElement(this.options.canvasId, HTMLCanvasElement, "Preview modal canvas is missing");
    this.closeBtn = requireElement(this.options.closeId, HTMLElement, "Preview close button is missing");
    this.zoomLevel = requireElement(this.options.zoomId, HTMLElement, "Preview zoom label is missing");
    this.ctx = getCanvas2DContext(this.canvas);
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
    document.addEventListener("keydown", this.boundKeyDown);
    this.canvas.addEventListener("wheel", this.boundWheel, { passive: false });
    this.canvas.addEventListener("mousedown", this.boundMouseDown);
    this.canvas.addEventListener("mousemove", this.boundMouseMove);
    this.canvas.addEventListener("mouseup", this.boundMouseUp);
    this.canvas.addEventListener("mouseleave", this.boundMouseUp);
  }

  private handleBackdropClick(event: MouseEvent): void {
    if (event.target === this.modal) this.close();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.isOpen) this.close();
  }

  open(sourceCanvas: HTMLCanvasElement): void {
    if (!(sourceCanvas instanceof HTMLCanvasElement)) {
      throw new TypeError("PreviewModal.open(sourceCanvas) expects an HTMLCanvasElement.");
    }
    this.imageWidth = sourceCanvas.width;
    this.imageHeight = sourceCanvas.height;
    if (!this.imageWidth || !this.imageHeight) throw new Error("Source canvas is empty.");
    this.containerWidth = window.innerWidth;
    this.containerHeight = window.innerHeight;
    let fill = Number(this.options.initialViewportFill);
    if (!Number.isFinite(fill) || fill <= 0 || fill > 1) fill = PREVIEW_MODAL_DEFAULTS.initialViewportFill;
    const targetWidth = this.containerWidth * fill;
    const targetHeight = this.containerHeight * fill;
    const scaleX = targetWidth / this.imageWidth;
    const scaleY = targetHeight / this.imageHeight;
    this.scale = clamp(Math.min(scaleX, scaleY), this.minScale, this.maxScale);
    this.offsetX = (this.containerWidth - this.imageWidth * this.scale) / 2;
    this.offsetY = (this.containerHeight - this.imageHeight * this.scale) / 2;
    this.canvas.width = this.imageWidth;
    this.canvas.height = this.imageHeight;
    this.ctx.clearRect(0, 0, this.imageWidth, this.imageHeight);
    this.ctx.drawImage(sourceCanvas, 0, 0);
    this.modal.style.display = "flex";
    this.isOpen = true;
    this.notifyShell(true);
    this.render();
  }

  update(sourceCanvas: HTMLCanvasElement): void {
    if (!this.isOpen) return;
    if (!(sourceCanvas instanceof HTMLCanvasElement)) return;
    if (sourceCanvas.width !== this.imageWidth || sourceCanvas.height !== this.imageHeight) {
      this.open(sourceCanvas);
      return;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(sourceCanvas, 0, 0);
  }

  close(): void {
    const wasOpen = this.isOpen;
    this.modal.style.display = "none";
    this.isOpen = false;
    this.isDragging = false;
    this.hasDragged = false;
    this.notifyShell(false);
    if (wasOpen) this.onClosed?.();
  }

  private zoomAt(mouseX: number, mouseY: number, factor: number): void {
    const newScale = this.scale * factor;
    if (newScale < this.minScale || newScale > this.maxScale) return;
    const canvasX = (mouseX - this.offsetX) / this.scale;
    const canvasY = (mouseY - this.offsetY) / this.scale;
    this.scale = newScale;
    this.offsetX = mouseX - canvasX * this.scale;
    this.offsetY = mouseY - canvasY * this.scale;
    this.constrainOffset();
    this.render();
  }

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    this.zoomAt(event.clientX, event.clientY, delta);
  }

  private handleMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    this.isDragging = true;
    this.hasDragged = false;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.canvas.style.cursor = "grabbing";
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

  private handleMouseUp(event: MouseEvent): void {
    if (!this.isDragging) return;
    if (!this.hasDragged) this.zoomAt(event.clientX, event.clientY, 1.5);
    this.isDragging = false;
    this.canvas.style.cursor = "grab";
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
    this.canvas.style.width = `${scaledWidth}px`;
    this.canvas.style.height = `${scaledHeight}px`;
    this.canvas.style.left = `${this.offsetX}px`;
    this.canvas.style.top = `${this.offsetY}px`;
    this.zoomLevel.textContent = `${Math.round(this.scale * 100)}%`;
  }
}

let allImages: ImageItem[] = [];
let visibleImages: ImageItem[] = [];
let allTagPool: string[] = [];
let allTagMeta: Map<string, TagMeta> = new Map();
let scannedRoots: string[] = [];
let folderTagSync = true;
let tabs: GalleryTab[] = [];
let activeTabId: string | null = null;
let lbIndex = -1;
let statusInterval: ReturnType<typeof setInterval> | null = null;
let loadedIds = new Set<string>();
let observer: IntersectionObserver | null = null;
let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let renderedCount = 0;
let serverTotal = 0;
let serverTotalKnown = false;
let nextCursor: string | null = null;
let hasMorePages = false;
let isLoadingPage = false;
let activeImagesRequest = 0;
let masonryColumns: HTMLElement[] = [];
let masonryHeights: number[] = [];
let masonryColumnCount = 0;
let previewModal: PreviewModal | null = null;
let lightboxImages: ImageItem[] = [];
let previewRequestToken = 0;
let suppressPreviewCloseClear = false;
let suppressedPreviewRestoreId: string | null = null;
let tagManagerSelection: Pick<GalleryTab, 'includeTags' | 'excludeTags'> = {includeTags: [], excludeTags: []};
let latestStatus: StatusResponse | null = null;
let filterSuggestionOpen = false;
let settingsActiveTab: SettingsTab = 'general';
let tagAdminSort: TagAdminSort = 'name';
let lastScrollY = 0;
let graphState: GraphState | null = null;
let liveEventSource: EventSource | null = null;
let lastLiveSequence = 0;
let liveRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let liveFolderRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let liveTagRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let activeView: 'gallery' | 'problems' = 'gallery';
let problemsSummary: ProblemSummary = {total: 0, errors: 0, warnings: 0, latestUpdatedAt: null};
let problemsSeverity: ProblemSeverity = 'all';
let problemsItems: ProblemItem[] = [];
let problemsTotal = 0;
let problemsLoading = false;
let problemsLoadError = '';
let problemsNotice = '';
let problemsNoticeIsError = false;
let problemsRecheckAllRunning = false;
let problemsRefreshRunning = false;
let problemsRefreshQueued = false;
let problemsListRefreshQueued = false;
let problemsSearchTimer: ReturnType<typeof setTimeout> | null = null;
let problemsRequestToken = 0;
let problemsListReloadQueued = false;
let problemsPollTimer: ReturnType<typeof setInterval> | null = null;
const problemRowRechecks = new Set<number>();
const terminalThumbIds = new Set<string>();
const thumbRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let terminalGalleryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const PAGE = 48;
const MASONRY_COL_MIN = 230;
const canvasCache = new Map<string, Promise<HTMLCanvasElement>>();
const MAX_CANVAS_CACHE = 9;
const SORT_MODES: SortMode[] = ['path_asc', 'path_desc', 'date_desc', 'date_asc', 'size_desc', 'size_asc'];
const DEFAULT_SORT_MODE: SortMode = 'date_desc';

function isSortMode(mode: string | undefined): mode is SortMode {
  return Boolean(mode && SORT_MODES.includes(mode as SortMode));
}

function makeDefaultTab(title = "Все фото"): GalleryTab {
  const id = "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  return { id, title, includeTags: [], excludeTags: [], matchMode: "any", sortMode: DEFAULT_SORT_MODE, lastImageId: null, scrollTop: 0 };
}

function activeTab(): GalleryTab {
  if (!tabs.length) {
    const tab = makeDefaultTab();
    tabs = [tab];
    activeTabId = tab.id;
  }
  let tab = tabs.find(item => item.id === activeTabId);
  if (!tab) {
    tab = tabs[0];
    activeTabId = tab.id;
  }
  tab.includeTags = Array.isArray(tab.includeTags) ? tab.includeTags : [];
  tab.excludeTags = Array.isArray(tab.excludeTags) ? tab.excludeTags : [];
  tab.matchMode = tab.matchMode === "all" ? "all" : "any";
  tab.sortMode = SORT_MODES.includes(tab.sortMode) ? tab.sortMode : DEFAULT_SORT_MODE;
  return tab;
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
    if (Array.isArray(data.root_paths)) scannedRoots = stringArray(data.root_paths);
    showGallery();
    renderTabs();
    renderFilterControls();
    startStatusPolling();
    await refreshImages(true);
    await refreshFolderTree();
    saveSessionSoon();
  } catch (e) {
    alert('Ошибка: ' + errorMessage(e));
  }
}

async function pickFolder() {
  try {
    const tauriWindow = window as Window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: {
        dialog?: {
          open?: (options: {
            directory: boolean;
            multiple: boolean;
            title: string;
            defaultPath?: string;
          }) => Promise<string | string[] | null>;
        };
      };
    };
    if (tauriWindow.__TAURI_INTERNALS__) {
      const openDialog = tauriWindow.__TAURI__?.dialog?.open;
      if (!openDialog) throw new Error('Нативный диалог выбора папки недоступен');
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Выберите папку с изображениями',
        ...(getFolderInputValue() ? {defaultPath: getFolderInputValue()} : {})
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
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
    if ((window as Window & {__TAURI_INTERNALS__?: unknown}).__TAURI_INTERNALS__) {
      alert('Не удалось открыть проводник: ' + errorMessage(e));
      return;
    }
    const manualPath = promptFolderPath('Не удалось открыть выбор папки: ' + errorMessage(e));
    if (manualPath) await openFolder(manualPath);
  }
}

async function refreshFolderTree() {
  try {
    const r = await fetch('/api/folders');
    if (!r.ok) return;
    const data = await readJsonRecord(r);
    const roots = stringArray(data.roots);
    if (roots.length) scannedRoots = roots;
    renderFolderTree();
    updateRootSummary();
  } catch {}
}

function toggleFolderSidebar(force?: boolean): void {
  const sidebar = optionalHtml('folder-sidebar');
  if (!sidebar) return;
  const open = force === undefined ? sidebar.classList.contains('collapsed') : Boolean(force);
  sidebar.classList.toggle('collapsed', !open);
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
        <span class="library-root-name">${escHtml(pathName(root))}</span>
        <span class="library-root-path">${escHtml(root)}</span>
      </div>
    `).join('')
    : '<div class="folder-empty">Библиотеки не добавлены</div>';
}

function toggleSettings(force?: boolean): void {
  const panel = requiredHtml('settings-panel');
  const open = force === undefined ? !panel.classList.contains('open') : Boolean(force);
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) document.body.classList.add('modal-open');
  else if (!requiredHtml('graph-overlay').classList.contains('open')) document.body.classList.remove('modal-open');
  if (open) {
    showChrome();
    setSettingsTab(settingsActiveTab || 'general');
    renderFolderTagSyncSetting();
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
  settingsActiveTab = tab === 'tags' || tab === 'graph' || tab === 'general' ? tab : 'general';
  document.querySelectorAll<HTMLElement>('.settings-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.settingsTab === settingsActiveTab);
  });
  document.querySelectorAll<HTMLElement>('.settings-panel-page').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.settingsPanel === settingsActiveTab);
  });
  if (settingsActiveTab === 'tags') renderTagAdmin();
}

function showGallery(): void {
  requiredHtml('setup-screen').style.display = 'none';
  requiredHtml('gallery-screen').style.display = 'block';
}

function showSetup(): void {
  requiredHtml('setup-screen').style.display = 'none';
  requiredHtml('gallery-screen').style.display = 'block';
  toggleFolderSidebar(true);
  renderFolderTree();
  updateRootSummary();
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
  try {
    const r = await fetch('/api/status');
    const s = statusResponse(await readJsonRecord(r));
    latestStatus = s;
    renderDbStatus(s);
    if (Array.isArray(s.root_paths) && s.root_paths.length) {
      scannedRoots = stringArray(s.root_paths);
      updateRootSummary();
      renderFolderTree();
    } else if (s.root && !scannedRoots.includes(s.root)) {
      scannedRoots = [...scannedRoots, s.root];
      updateRootSummary();
      renderFolderTree();
    }
    if (s.root) setFolderInputValues(s.root);
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
  switch (event.type) {
    case 'image_created':
      if (image) applyLiveImage(image, 'created');
      break;
    case 'image_updated':
    case 'image_renamed':
      if (image) applyLiveImage(image, 'updated');
      break;
    case 'image_removed':
      removeLiveImage(String(event.data.image_id || ''), image);
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
    case 'problems_changed':
      scheduleProblemsRefresh();
      break;
    case 'problems_recheck_finished':
      problemsRecheckAllRunning = false;
      problemsNotice = Number(event.data.failed || 0) > 0
        ? `Проверка завершена, ошибок выполнения: ${Number(event.data.failed || 0)}.`
        : 'Проверка завершена.';
      problemsNoticeIsError = Number(event.data.failed || 0) > 0;
      renderProblems();
      scheduleProblemsRefresh();
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

function applyLiveImage(image: ImageItem, operation: 'created' | 'updated'): void {
  acceptActiveImage(image.id);
  const existingIndex = allImages.findIndex(item => item.id === image.id);
  const existingWasVisible = existingIndex >= 0;
  if (existingIndex >= 0) allImages.splice(existingIndex, 1);
  if (imageMatchesActiveTab(image)) allImages.push(image);
  allImages.sort(compareLiveImages);
  visibleImages = allImages.slice();
  if (serverTotalKnown && operation === 'created' && !existingWasVisible && imageMatchesActiveTab(image)) {
    serverTotal += 1;
  }
  canvasCache.delete(image.id);
  renderLiveGalleryState();
  scheduleLiveFolderRefresh();
  scheduleLiveTagRefresh();
  updateLivePreviewImage(image);
}

function removeLiveImage(imageId: string, removedImage: ImageItem | null): void {
  if (!imageId) return;
  const existingIndex = allImages.findIndex(item => item.id === imageId);
  const wasVisible = existingIndex >= 0;
  if (existingIndex >= 0) allImages.splice(existingIndex, 1);
  visibleImages = allImages.slice();
  if (serverTotalKnown && (wasVisible || (removedImage && imageMatchesActiveTab(removedImage)))) {
    serverTotal = Math.max(0, serverTotal - 1);
  }
  canvasCache.delete(imageId);
  if (activeTab().lastImageId === imageId) closePreview(true);
  renderLiveGalleryState();
  scheduleLiveFolderRefresh();
  scheduleLiveTagRefresh();
}

function renderLiveGalleryState(): void {
  const targetCount = Math.min(
    visibleImages.length,
    Math.max(renderedCount, Math.min(PAGE, visibleImages.length)),
  );
  renderedCount = targetCount;
  layoutGallery();
  updateImageCounter();
  requiredHtml('empty-state').style.display = visibleImages.length ? 'none' : 'flex';
  requestGraphRebuild();
}

function updateLivePreviewImage(image: ImageItem): void {
  const index = lightboxImages.findIndex(item => item.id === image.id);
  if (index >= 0) lightboxImages[index] = image;
  if (previewModal?.isOpen && activeTab().lastImageId === image.id) renderPreviewMeta(image, false);
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

function problemHumanMessage(problem: ProblemItem): string {
  switch (problem.kind) {
    case 'decode_error': return 'Файл не удаётся прочитать. Возможно, он повреждён или обрезан.';
    case 'format_mismatch':
      if (problem.expectedFormat && problem.detectedFormat) {
        return `Содержимое: ${formatDisplayName(problem.detectedFormat)} · расширение: ${formatDisplayName(problem.expectedFormat)}`;
      }
      return 'Расширение файла не соответствует его содержимому.';
    case 'unsupported_content': return 'Содержимое файла имеет формат, который Vilra не поддерживает.';
    case 'unreadable': return 'Vilra не может прочитать этот файл.';
    default: return 'Файл требует проверки.';
  }
}

function formatDisplayName(format: string | null): string {
  switch (String(format || '').toLowerCase()) {
    case 'jpeg':
    case 'jpg': return 'JPEG';
    case 'png': return 'PNG';
    case 'webp': return 'WebP';
    default: return format || 'не определён';
  }
}

function renderProblemsSummary(): void {
  requiredHtml('problems-total').textContent = String(problemsSummary.total);
  requiredHtml('problems-errors').textContent = String(problemsSummary.errors);
  requiredHtml('problems-warnings').textContent = String(problemsSummary.warnings);
  const badge = requiredHtml('problems-badge');
  badge.textContent = String(problemsSummary.errors);
  badge.classList.toggle('muted', problemsSummary.errors === 0);
}

function renderProblems(): void {
  document.querySelectorAll<HTMLElement>('.problems-filter').forEach(button => {
    button.classList.toggle('active', button.dataset.severity === problemsSeverity);
  });
  const list = requiredHtml('problems-list');
  list.innerHTML = problemsItems.map(problem => `
    <article class="problem-row" data-problem-id="${problem.id}">
      <span class="problem-severity ${problem.severity}">${problem.severity === 'error' ? 'Ошибка' : 'Внимание'}</span>
      <div>
        <div class="problem-file">${escHtml(problem.fileName)}</div>
        <div class="problem-path">${escHtml(problem.path)}</div>
        <div class="problem-message">${escHtml(problemHumanMessage(problem))}</div>
        <div class="problem-meta">${escHtml(fmtSize(problem.size))} · расширение: ${escHtml(formatDisplayName(problem.expectedFormat))} · содержимое: ${escHtml(formatDisplayName(problem.detectedFormat))}</div>
        ${problem.technicalDetail ? `<details class="problem-detail"><summary>Технические детали</summary>${escHtml(problem.technicalDetail)}</details>` : ''}
        <div class="problem-inline-error" data-problem-error="${problem.id}"></div>
      </div>
      <div class="problem-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-action="reveal-problem" data-problem-id="${problem.id}">${isTauriRuntime() ? 'Показать в папке' : 'Копировать путь'}</button>
        <button class="btn btn-ghost btn-sm" type="button" data-action="recheck-problem" data-problem-id="${problem.id}" ${problemRowRechecks.has(problem.id) ? 'disabled' : ''}>${problemRowRechecks.has(problem.id) ? 'Проверка…' : 'Проверить'}</button>
      </div>
    </article>
  `).join('');
  const feedback = requiredHtml('problems-feedback');
  feedback.classList.toggle('error', Boolean(problemsLoadError || (problemsNotice && problemsNoticeIsError)));
  if (problemsLoadError) feedback.innerHTML = `${escHtml(problemsLoadError)} <button class="btn btn-ghost btn-sm" type="button" data-action="retry-problems">Повторить</button>`;
  else if (problemsNotice) feedback.textContent = problemsNotice;
  else if (problemsLoading && !problemsItems.length) feedback.textContent = 'Загрузка…';
  else if (!problemsItems.length) feedback.textContent = 'Проблем не найдено.';
  else feedback.textContent = `Показано ${problemsItems.length} из ${problemsTotal}`;
  const more = requireElement('problems-load-more', HTMLButtonElement, 'Problems load button is missing');
  more.hidden = problemsItems.length >= problemsTotal;
  more.disabled = problemsLoading;
  const all = requireElement('problems-recheck-all', HTMLButtonElement, 'Problems recheck button is missing');
  all.disabled = problemsRecheckAllRunning || problemsSummary.total === 0;
  all.textContent = problemsRecheckAllRunning ? 'Проверка…' : 'Проверить все';
}

async function refreshProblemsSummary(): Promise<boolean> {
  const previous = problemsSummary;
  const response = await fetch('/api/problems/summary');
  if (!response.ok) throw new Error(await readError(response));
  const data = await readJsonRecord(response);
  const next: ProblemSummary = {
    total: Number(data.total || 0),
    errors: Number(data.errors || 0),
    warnings: Number(data.warnings || 0),
    latestUpdatedAt: typeof data.latest_updated_at === 'string' ? data.latest_updated_at : null
  };
  const changed = previous.total !== next.total
    || previous.errors !== next.errors
    || previous.warnings !== next.warnings
    || previous.latestUpdatedAt !== next.latestUpdatedAt;
  problemsSummary = next;
  renderProblemsSummary();
  return changed;
}

async function loadProblems(reset = true): Promise<void> {
  if (problemsLoading) {
    problemsListReloadQueued ||= reset;
    return;
  }
  const token = ++problemsRequestToken;
  const offset = reset ? 0 : problemsItems.length;
  const search = requiredInput('problems-search').value.trim();
  problemsLoading = true;
  problemsLoadError = '';
  renderProblems();
  const params = new URLSearchParams({
    severity: problemsSeverity,
    search,
    limit: '100',
    offset: String(offset)
  });
  try {
    const response = await fetch(`/api/problems?${params}`);
    if (!response.ok) throw new Error(await readError(response));
    const data = await readJsonRecord(response);
    if (token !== problemsRequestToken) return;
    const items = Array.isArray(data.items)
      ? data.items.map(normalizeProblemItem).filter((item): item is ProblemItem => Boolean(item))
      : [];
    problemsItems = reset ? items : [...problemsItems, ...items];
    const page = isRecord(data.page) ? data.page : {};
    problemsTotal = Number(page.total || problemsItems.length);
  } catch (error) {
    if (token !== problemsRequestToken) return;
    problemsLoadError = errorMessage(error);
  } finally {
    if (token === problemsRequestToken) {
      problemsLoading = false;
      renderProblems();
      if (problemsListReloadQueued) {
        problemsListReloadQueued = false;
        void loadProblems(true);
      }
    }
  }
}

function scheduleProblemsRefresh(includeList = true): void {
  if (problemsRefreshRunning) {
    problemsRefreshQueued = true;
    problemsListRefreshQueued ||= includeList;
    return;
  }
  problemsRefreshRunning = true;
  problemsListRefreshQueued = includeList;
  void (async () => {
    do {
      problemsRefreshQueued = false;
      const refreshList = problemsListRefreshQueued;
      problemsListRefreshQueued = false;
      let summaryChanged = false;
      try {
        summaryChanged = await refreshProblemsSummary();
      } catch (error) {
        console.warn('Problems summary refresh failed', error);
      }
      if ((refreshList || summaryChanged) && activeView === 'problems') {
        await loadProblems(true);
      }
    } while (problemsRefreshQueued);
    problemsRefreshRunning = false;
  })();
}

function showProblemsView(): void {
  if (activeView === 'problems') return;
  saveActiveScroll();
  showChrome();
  suppressedPreviewRestoreId = activeTab().lastImageId;
  closePreview(false);
  closeGraph();
  toggleSettings(false);
  activeView = 'problems';
  document.body.classList.add('problems-view');
  requiredHtml('problems-wrap').setAttribute('aria-hidden', 'false');
  requiredHtml('gallery-nav').classList.remove('active');
  requiredHtml('problems-nav').classList.add('active');
  window.scrollTo({top: 0});
  scheduleProblemsRefresh();
}

function showGalleryView(): void {
  if (activeView === 'gallery') return;
  activeView = 'gallery';
  document.body.classList.remove('problems-view');
  requiredHtml('problems-wrap').setAttribute('aria-hidden', 'true');
  requiredHtml('gallery-nav').classList.add('active');
  requiredHtml('problems-nav').classList.remove('active');
  setTimeout(() => window.scrollTo({top: activeTab().scrollTop || 0}), 0);
}

function setProblemsFilter(value: string | undefined): void {
  problemsSeverity = value === 'error' || value === 'warning' ? value : 'all';
  void loadProblems(true);
}

async function recheckProblem(issueId: number): Promise<void> {
  if (!Number.isInteger(issueId) || problemRowRechecks.has(issueId)) return;
  problemRowRechecks.add(issueId);
  renderProblems();
  try {
    const response = await fetch(`/api/problems/${issueId}/recheck`, {method: 'POST'});
    if (!response.ok) throw new Error(await readError(response));
    const result = await readJsonRecord(response);
    applyProblemRecheckResult(issueId, result);
    scheduleProblemsRefresh();
  } catch (error) {
    problemsNotice = errorMessage(error);
    problemsNoticeIsError = true;
  } finally {
    problemRowRechecks.delete(issueId);
    renderProblems();
  }
}

function applyProblemRecheckResult(issueId: number, result: JsonRecord): void {
  const existingIndex = problemsItems.findIndex(problem => problem.id === issueId);
  const issue = normalizeProblemItem(result.issue);
  const status = String(result.status || '');
  const keep = issue
    && status !== 'resolved'
    && (problemsSeverity === 'all' || issue.severity === problemsSeverity);
  if (keep) {
    if (existingIndex >= 0) problemsItems[existingIndex] = issue;
    else problemsItems.push(issue);
  } else if (existingIndex >= 0) {
    problemsItems.splice(existingIndex, 1);
    problemsTotal = Math.max(0, problemsTotal - 1);
  }
  problemsNotice = status === 'resolved'
    ? 'Проблема устранена.'
    : status === 'warning'
      ? 'Файл доступен, предупреждение обновлено.'
      : '';
  problemsNoticeIsError = false;
}

async function recheckAllProblems(): Promise<void> {
  if (problemsRecheckAllRunning) return;
  problemsRecheckAllRunning = true;
  problemsNotice = '';
  problemsNoticeIsError = false;
  renderProblems();
  try {
    const response = await fetch('/api/problems/recheck-all', {method: 'POST'});
    if (response.status === 409) {
      problemsRecheckAllRunning = false;
      problemsNotice = 'Проверка уже выполняется.';
      problemsNoticeIsError = false;
      renderProblems();
      return;
    }
    if (!response.ok) throw new Error(await readError(response));
  } catch (error) {
    problemsRecheckAllRunning = false;
    problemsNotice = errorMessage(error);
    problemsNoticeIsError = true;
    renderProblems();
  }
}

function isTauriRuntime(): boolean {
  return Boolean((window as Window & {__TAURI_INTERNALS__?: unknown}).__TAURI_INTERNALS__);
}

async function revealProblem(issueId: number): Promise<void> {
  const problem = problemsItems.find(item => item.id === issueId);
  if (!problem) return;
  const errorTarget = document.querySelector<HTMLElement>(`[data-problem-error="${issueId}"]`);
  if (errorTarget) errorTarget.textContent = '';
  try {
    if (isTauriRuntime()) {
      const tauri = window as Window & {__TAURI__?: {core?: {invoke?: (command: string, args: JsonRecord) => Promise<unknown>}}};
      const invoke = tauri.__TAURI__?.core?.invoke;
      if (!invoke) throw new Error('Native file reveal is unavailable');
      await invoke('reveal_problem', {issueId});
    } else {
      await navigator.clipboard.writeText(problem.absolutePath);
      if (errorTarget) errorTarget.textContent = 'Путь скопирован.';
    }
  } catch (error) {
    if (errorTarget) errorTarget.textContent = errorMessage(error);
  }
}

function startProblemsPolling(): void {
  scheduleProblemsRefresh(false);
  if (problemsPollTimer) clearInterval(problemsPollTimer);
  problemsPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') scheduleProblemsRefresh(false);
  }, 10_000);
}

function pageTotalValue(page: ImagePage | null | undefined): number | null {
  if (!page || page.total === null || page.total === undefined || page.total === '') return null;
  const total = Number(page.total);
  return Number.isFinite(total) ? total : null;
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

function mergeRefreshedPageIntoLoadedImages(existing: ImageItem[], refreshedPage: ImageItem[]): ImageItem[] {
  if (!existing.length) return refreshedPage.slice();
  if (!refreshedPage.length) return existing.slice();

  const refreshedById = new Map(refreshedPage.map(img => [img.id, img]));
  const retained = existing
    .map(img => refreshedById.get(img.id) || img)
    .filter(img => !refreshedById.has(img.id));

  return [...refreshedPage, ...retained];
}

function updateImageCounter(): void {
  const count = serverTotalKnown ? serverTotal : visibleImages.length;
  const suffix = !serverTotalKnown && hasMorePages ? '+' : '';
  requiredHtml('count-text').textContent = `${count}${suffix} фото`;
}

async function refreshImages(clear = true): Promise<void> {
  const requestId = ++activeImagesRequest;
  const tab = activeTab();
  const params = new URLSearchParams();
  if (tab.includeTags && tab.includeTags.length) params.set('include_tags', tab.includeTags.join(','));
  if (tab.excludeTags && tab.excludeTags.length) params.set('exclude_tags', tab.excludeTags.join(','));
  params.set('match_mode', tab.matchMode === 'all' ? 'all' : 'any');
  params.set('limit', String(PAGE));
  params.set('sort', tab.sortMode || DEFAULT_SORT_MODE);
  params.set('include_total', '1');
  try {
    const r = await fetch('/api/images?' + params.toString());
    if (!r.ok) throw new Error(await readError(r));
    const d = await readJsonRecord(r);
    if (requestId !== activeImagesRequest) return;
    const refreshedPage = imagesFromRecord(d);
    refreshedPage.forEach(image => acceptActiveImage(image.id));
    allImages = clear
      ? refreshedPage
      : mergeRefreshedPageIntoLoadedImages(allImages, refreshedPage);
    visibleImages = allImages.slice();
    const page = imagePage(d.page);
    setServerTotalFromPage(page, visibleImages.length, true);
    nextCursor = page ? page.next_cursor || null : null;
    hasMorePages = Boolean(page && page.has_more);
    isLoadingPage = false;
    await refreshTagPool();
    applyFilter(clear);
    restorePreviewIfNeeded();
  } catch (e) {
    console.error(e);
    requiredHtml('status-text').textContent = errorMessage(e);
  }
}

function applyFilter(clear = true): void {
  const tab = activeTab();
  visibleImages = allImages.slice();
  updateImageCounter();
  updateTabTitle(tab);
  renderTabs();
  renderFilterControls();
  if (clear) {
    loadedIds.clear();
    renderedCount = 0;
    requiredHtml('gallery').innerHTML = '';
    resetMasonryLayout();
  }
  renderBatch();
  requiredHtml('empty-state').style.display = visibleImages.length ? 'none' : 'flex';
  requestGraphRebuild();
}

async function loadNextImagesPage(): Promise<void> {
  if (!hasMorePages || !nextCursor || isLoadingPage) return;
  isLoadingPage = true;
  const tab = activeTab();
  const params = new URLSearchParams();
  if (tab.includeTags && tab.includeTags.length) params.set('include_tags', tab.includeTags.join(','));
  if (tab.excludeTags && tab.excludeTags.length) params.set('exclude_tags', tab.excludeTags.join(','));
  params.set('match_mode', tab.matchMode === 'all' ? 'all' : 'any');
  params.set('limit', String(PAGE));
  params.set('sort', tab.sortMode || DEFAULT_SORT_MODE);
  params.set('include_total', '0');
  params.set('cursor', nextCursor);
  try {
    const r = await fetch('/api/images?' + params.toString());
    if (!r.ok) throw new Error(await readError(r));
    const d = await readJsonRecord(r);
    const items = imagesFromRecord(d);
    items.forEach(image => acceptActiveImage(image.id));
    const seen = new Set(allImages.map(img => img.id));
    items.forEach(img => {
      if (!seen.has(img.id)) allImages.push(img);
    });
    visibleImages = allImages.slice();
    const page = imagePage(d.page);
    setServerTotalFromPage(page, visibleImages.length, false);
    nextCursor = page ? page.next_cursor || null : null;
    hasMorePages = Boolean(page && page.has_more);
    updateImageCounter();
    renderBatch();
  } catch (e) {
    console.error(e);
  } finally {
    isLoadingPage = false;
  }
}

function renderBatch(): void {
  ensureMasonryLayout(false);
  const start = renderedCount;
  const end = Math.min(start + PAGE, visibleImages.length);
  for (let i = start; i < end; i++) {
    const img = visibleImages[i];
    if (loadedIds.has(img.id)) continue;
    loadedIds.add(img.id);
    placeMasonryCard(makeCard(img), img);
  }
  renderedCount = end;
  setupLazyLoad();
}

function makeCard(img: ImageItem): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = img.id;
  const name = fileName(img.path);
  const ph = document.createElement('img');
  ph.className = 'lazy';
  ph.dataset.imageId = img.id;
  const version = Number(img.mtime || 0);
  ph.dataset.src = `${img.thumb_url || `/thumb-file/${img.id}.jpg`}?v=${version}`;
  ph.dataset.fallbackSrc = `/thumb/${img.id}?v=${version}`;
  ph.alt = name;
  ph.decoding = 'async';
  ph.loading = 'lazy';
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
  card.appendChild(ph);
  card.appendChild(overlay);
  card.addEventListener('click', () => openLightboxById(img.id));
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
  const card = document.querySelector(`.card[data-id="${cssEscape(img.id)}"]`);
  if (!card) return;
  const tags = card.querySelector('.card-tags');
  if (tags) tags.innerHTML = renderTagChips(img);
}

function setupLazyLoad(): void {
  if (observer) observer.disconnect();
  const lazyObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (img.dataset.src) {
        img.onload = () => img.classList.add('loaded');
        img.onerror = () => {
          const fallback = img.dataset.fallbackSrc;
          if (fallback && img.src !== fallback) {
            loadThumbWithRetry(img, fallback);
            return;
          }
          img.classList.add('loaded');
          img.alt = 'Ошибка загрузки';
        };
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
        lazyObserver.unobserve(img);
      }
    });
  }, {rootMargin: '320px'});
  observer = lazyObserver;
  document.querySelectorAll<HTMLImageElement>('img.lazy').forEach(img => lazyObserver.observe(img));
  const galleryWrap = requiredHtml('gallery-wrap');
  const old = galleryWrap.querySelector('.sentinel');
  if (old) old.remove();
  if (renderedCount < visibleImages.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'sentinel';
    sentinel.style.height = '1px';
    galleryWrap.appendChild(sentinel);
    const sentinelObs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        sentinelObs.disconnect();
        if (renderedCount < visibleImages.length) {
          renderBatch();
        } else if (hasMorePages) {
          loadNextImagesPage();
        }
      }
    }, {rootMargin: '620px'});
    sentinelObs.observe(sentinel);
  } else if (hasMorePages) {
    const sentinel = document.createElement('div');
    sentinel.className = 'sentinel';
    sentinel.style.height = '1px';
    galleryWrap.appendChild(sentinel);
    const sentinelObs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        sentinelObs.disconnect();
        loadNextImagesPage();
      }
    }, {rootMargin: '620px'});
    sentinelObs.observe(sentinel);
  }
}

async function loadThumbWithRetry(img: HTMLImageElement, url: string, attempt = 0): Promise<void> {
  const imageId = String(img.dataset.imageId || img.closest<HTMLElement>('.card[data-id]')?.dataset.id || '');
  if (!imageId || terminalThumbIds.has(imageId)) return;
  thumbRetryTimers.delete(imageId);
  const maxAttempts = 120;
  try {
    const r = await fetch(url, {cache: 'no-store'});
    if (terminalThumbIds.has(imageId)) return;
    if (r.status === 200) {
      img.src = url;
      img.onload = () => img.classList.add('loaded');
      img.onerror = () => {
        img.classList.add('loaded');
        img.alt = 'Ошибка загрузки';
      };
      return;
    }
    if (r.status === 202 && attempt < maxAttempts) {
      let retryAfter = 180;
      try {
        const p = await readJsonRecord(r);
        retryAfter = Math.min(1500, Math.max(80, Number(p.retry_after_ms || retryAfter)));
      } catch {}
      const timer = setTimeout(() => {
        thumbRetryTimers.delete(imageId);
        if (img.isConnected && !terminalThumbIds.has(imageId)) void loadThumbWithRetry(img, url, attempt + 1);
      }, retryAfter);
      thumbRetryTimers.set(imageId, timer);
      return;
    }
    if (r.status === 422) {
      const payload = await readJsonRecord(r).catch((): JsonRecord => ({}));
      if (payload.error === 'image_unavailable') {
        handleTerminalImageUnavailable(imageId);
        return;
      }
    }
    console.warn('Thumbnail request failed', {url, status: r.status, attempt});
  } catch (error) {
    console.warn('Thumbnail request failed', {url, attempt, error});
  }
  img.classList.add('loaded');
  img.alt = 'Ошибка загрузки';
}

function acceptActiveImage(imageId: string): void {
  terminalThumbIds.delete(imageId);
  const timer = thumbRetryTimers.get(imageId);
  if (timer) clearTimeout(timer);
  thumbRetryTimers.delete(imageId);
}

function handleTerminalImageUnavailable(imageId: string): void {
  if (!imageId || terminalThumbIds.has(imageId)) return;
  terminalThumbIds.add(imageId);
  const timer = thumbRetryTimers.get(imageId);
  if (timer) clearTimeout(timer);
  thumbRetryTimers.delete(imageId);
  canvasCache.delete(imageId);
  if (activeTab().lastImageId === imageId || lightboxImages[lbIndex]?.id === imageId) {
    previewRequestToken += 1;
    closePreview(true);
  }
  removeLiveImage(imageId, null);
  scheduleProblemsRefresh();
  if (!terminalGalleryRefreshTimer) {
    terminalGalleryRefreshTimer = setTimeout(() => {
      terminalGalleryRefreshTimer = null;
      void refreshImages(true);
    }, 100);
  }
}

async function refreshTagPool() {
  try {
    const r = await fetch('/api/tags');
    if (!r.ok) throw new Error(await readError(r));
    const d = await readJsonRecord(r);
    setTagPool(d.tags || []);
    updateFishGhosts();
    renderFilterSuggestions();
    renderTagAdmin();
  } catch {}
}

function addTab() {
  saveActiveScroll();
  const tab = makeDefaultTab();
  tabs.push(tab);
  activeTabId = tab.id;
  closePreview(false);
  refreshImages(true);
  window.scrollTo({top: 0});
  saveSessionSoon();
}

function switchTab(id: string): void {
  if (id === activeTabId) return;
  saveActiveScroll();
  activeTabId = id;
  closePreview(false);
  refreshImages(true);
  const tab = activeTab();
  setTimeout(() => window.scrollTo({top: tab.scrollTop || 0}), 0);
  saveSessionSoon();
}

function closeTab(id: string): void {
  if (tabs.length <= 1) {
    tabs = [makeDefaultTab()];
    activeTabId = tabs[0].id;
  } else {
    const idx = tabs.findIndex(tab => tab.id === id);
    tabs = tabs.filter(tab => tab.id !== id);
    if (activeTabId === id) {
      const next = tabs[Math.max(0, idx - 1)] || tabs[0];
      activeTabId = next.id;
    }
  }
  closePreview(false);
  refreshImages(true);
  saveSessionSoon();
}

function renderTabs(): void {
  const el = requiredHtml('tabs');
  el.innerHTML = tabs.map(tab => `
    <button class="tab ${tab.id === activeTabId ? 'active' : ''}" data-tab="${escAttr(tab.id)}" title="${escAttr(tab.title)}">
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

function updateTabTitle(tab: GalleryTab): void {
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

function saveActiveScroll(): void {
  if (!tabs.length) return;
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
  return {kind, tag: findDisplayTag(value)};
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
  const value = findDisplayTag(tag);
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
    ? allTagPool.find(tag => normalizeTag(tag).startsWith(q) && normalizeTag(tag) !== q)
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
  const matches = allTagPool
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

function openTagManager(): void {
  const tab = activeTab();
  tagManagerSelection = {
    includeTags: [...(tab.includeTags || [])],
    excludeTags: [...(tab.excludeTags || [])]
  };
  requiredHtml('tag-overlay').classList.add('open');
  toggleCreateTagPanel(false);
  renderTagManager();
}

function closeTagManager(): void {
  requiredHtml('tag-overlay').classList.remove('open');
}

function renderTagManager(): void {
  const selectedInclude = new Set((tagManagerSelection.includeTags || []).map(normalizeTag));
  const selectedExclude = new Set((tagManagerSelection.excludeTags || []).map(normalizeTag));
  const selectedEl = requiredHtml('tag-manager-selected');
  selectedEl.innerHTML = [
    ...(tagManagerSelection.includeTags || []).map(tag => renderTagChip(tag, {
      removable: true,
      actionKind: 'include',
      className: 'filter-chip'
    })),
    ...(tagManagerSelection.excludeTags || []).map(tag => renderTagChip(tag, {
      removable: true,
      exclude: true,
      actionKind: 'exclude',
      className: 'filter-chip'
    }))
  ].join('') || '<span class="muted-inline">Выберите теги ниже</span>';
  selectedEl.querySelectorAll<HTMLElement>('button[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      removeManagerTag(btn.dataset.kind, btn.dataset.tag);
      renderTagManager();
    });
  });
  const list = requiredHtml('tag-list');
  list.innerHTML = `<button class="tag-option add" data-action="toggle-create-tag-panel" data-open="true" title="Создать тег">+</button>` +
    allTagPool.map(tag => `
      <span class="tag-choice ${selectedInclude.has(normalizeTag(tag)) ? 'include' : ''} ${selectedExclude.has(normalizeTag(tag)) ? 'exclude' : ''}">
        <button class="tag-choice-name" data-kind="include" data-tag="${escAttr(tag)}">${renderTagChip(tag, {count: true})}</button>
        <button class="tag-choice-anti" data-kind="exclude" data-tag="${escAttr(tag)}">!</button>
      </span>
    `).join('');
  list.querySelectorAll<HTMLElement>('.tag-choice button[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => toggleManagerTag(btn.dataset.kind, btn.dataset.tag));
  });
}

function removeManagerTag(kind: string | undefined, tag: string | undefined): void {
  if (!tag) return;
  const norm = normalizeTag(tag);
  const key: 'includeTags' | 'excludeTags' = normalizeTagKind(kind) === 'exclude' ? 'excludeTags' : 'includeTags';
  tagManagerSelection[key] = (tagManagerSelection[key] || []).filter(item => normalizeTag(item) !== norm);
}

function toggleManagerTag(kind: string | undefined, tag: string | undefined): void {
  if (!tag) return;
  const value = findDisplayTag(tag);
  const norm = normalizeTag(value);
  const normalizedKind = normalizeTagKind(kind);
  const key: 'includeTags' | 'excludeTags' = normalizedKind === 'exclude' ? 'excludeTags' : 'includeTags';
  const oppositeKey: 'includeTags' | 'excludeTags' = normalizedKind === 'exclude' ? 'includeTags' : 'excludeTags';
  if ((tagManagerSelection[key] || []).some(item => normalizeTag(item) === norm)) {
    removeManagerTag(kind, value);
  } else {
    tagManagerSelection[oppositeKey] = (tagManagerSelection[oppositeKey] || []).filter(item => normalizeTag(item) !== norm);
    tagManagerSelection[key] = dedupeDisplayTags([...(tagManagerSelection[key] || []), value]);
  }
  renderTagManager();
}

function applyTagManagerSelection(): void {
  activeTab().includeTags = dedupeDisplayTags(tagManagerSelection.includeTags || []);
  activeTab().excludeTags = dedupeDisplayTags(tagManagerSelection.excludeTags || []);
  closeTagManager();
  refreshImages(true);
  saveSessionSoon();
}

function toggleCreateTagPanel(open?: boolean): void {
  const panel = requiredHtml('tag-create-panel');
  panel.classList.toggle('open', Boolean(open));
  if (open) {
    requiredInput('tag-create-input').value = '';
    updateFishGhosts();
    setTimeout(() => requiredInput('tag-create-input').focus(), 0);
  }
}

async function createTagFromManager(): Promise<void> {
  const input = requiredInput('tag-create-input');
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
    setTagPool(d.tags || [...allTagPool, d.tag || value]);
    const createdName = tagName(d.tag || value);
    tagManagerSelection.includeTags = dedupeDisplayTags([...(tagManagerSelection.includeTags || []), createdName]);
    tagManagerSelection.excludeTags = (tagManagerSelection.excludeTags || []).filter(tag => normalizeTag(tag) !== normalizeTag(createdName));
    input.value = '';
    toggleCreateTagPanel(false);
    renderTagManager();
    renderTagAdmin();
    updateFishGhosts();
  } catch (e) {
    alert('Ошибка: ' + errorMessage(e));
  }
}

function renderAllTagSurfaces(): void {
  renderFilterControls();
  if (requiredHtml('tag-overlay').classList.contains('open')) renderTagManager();
  renderTagAdmin();
  visibleImages.forEach(updateCardForImage);
  const previewImage = (lightboxImages.length ? lightboxImages : visibleImages)[lbIndex];
  if (previewImage) renderPreviewTags(previewImage);
}

function renderTagAdmin(): void {
  const list = optionalHtml('tag-admin-list');
  if (!list) return;
  const query = normalizeTag(optionalInput('tag-admin-search')?.value || '');
  const tags = allTagPool
    .filter(tag => !query || normalizeTag(tag).includes(query))
    .sort((a, b) => {
      const metaA = getTagMeta(a);
      const metaB = getTagMeta(b);
      if (tagAdminSort === 'image_count' || tagAdminSort === 'user_count' || tagAdminSort === 'auto_count') {
        return Number(metaB[tagAdminSort] || 0) - Number(metaA[tagAdminSort] || 0) || a.localeCompare(b);
      }
      return a.localeCompare(b);
    });
  list.innerHTML = tags.length ? tags.map(tag => {
    const meta = getTagMeta(tag);
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
    setTagPool(d.tags || [...allTagPool, d.tag || value]);
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
  const meta = getTagMeta(tag);
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

function hasActiveModal(): boolean {
  return Boolean(
    requiredHtml('settings-panel').classList.contains('open') ||
    requiredHtml('tag-overlay').classList.contains('open') ||
    requiredHtml('graph-overlay').classList.contains('open') ||
    (previewModal && previewModal.isOpen)
  );
}

function showChrome(): void {
  document.body.classList.remove('chrome-hidden');
  document.documentElement.classList.remove('chrome-hidden');
}

function hideChrome(): void {
  document.body.classList.add('chrome-hidden');
  document.documentElement.classList.add('chrome-hidden');
}

function handleChromeScroll(): void {
  const y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  updateScrollTopButton();
  if (y < 64 || y < lastScrollY || hasActiveModal()) {
    showChrome();
  } else if (y > lastScrollY + 4) {
    hideChrome();
  }
  lastScrollY = y;
}

function ensureGraphState(): GraphState {
  if (graphState) return graphState;
  const canvas = requireElement('graph-canvas', HTMLCanvasElement, "Graph canvas is missing");
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Graph canvas 2D context is unavailable.');
  graphState = {
    open: false,
    scope: 'current',
    nodes: [],
    edges: [],
    scale: 1,
    panX: 0,
    panY: 0,
    dragNode: null,
    isPanning: false,
    pointerMoved: false,
    lastX: 0,
    lastY: 0,
    tick: 0,
    raf: null,
    needsRebuild: false,
    query: '',
    nodeLimit: 1000,
    canvas,
    ctx
  };
  const state = graphState;
  canvas.addEventListener('wheel', handleGraphWheel, {passive: false});
  canvas.addEventListener('mousedown', handleGraphMouseDown);
  window.addEventListener('mousemove', handleGraphMouseMove);
  window.addEventListener('mouseup', handleGraphMouseUp);
  canvas.addEventListener('dblclick', resetGraphLayout);
  requiredInput('graph-search').addEventListener('input', e => {
    const input = e.target as HTMLInputElement;
    state.query = normalizeTag(input.value);
    renderGraph();
  });
  return state;
}

function openGraph(scope: GraphScope | null = null): void {
  const state = ensureGraphState();
  if (requiredHtml('settings-panel').classList.contains('open')) toggleSettings(false);
  state.open = true;
  if (scope) state.scope = scope;
  requiredHtml('graph-overlay').classList.add('open');
  requiredHtml('graph-overlay').setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  showChrome();
  updateGraphScopeButtons();
  rebuildGraph();
}

function closeGraph(): void {
  if (!graphState) return;
  graphState.open = false;
  if (graphState.raf) cancelAnimationFrame(graphState.raf);
  graphState.raf = null;
  requiredHtml('graph-overlay').classList.remove('open');
  requiredHtml('graph-overlay').setAttribute('aria-hidden', 'true');
  if (!requiredHtml('settings-panel').classList.contains('open')) {
    document.body.classList.remove('modal-open');
  }
}

function setGraphScope(scope: string | undefined): void {
  const state = ensureGraphState();
  state.scope = scope === 'all' ? 'all' : 'current';
  document.querySelectorAll<HTMLInputElement>('input[name="settings-graph-scope"]').forEach(input => {
    input.checked = input.value === state.scope;
  });
  updateGraphScopeButtons();
  if (state.open) rebuildGraph();
}

function updateGraphScopeButtons(): void {
  const state = ensureGraphState();
  requiredHtml('graph-scope-current').classList.toggle('active', state.scope !== 'all');
  requiredHtml('graph-scope-all').classList.toggle('active', state.scope === 'all');
}

function requestGraphRebuild(): void {
  if (!graphState || !graphState.open) return;
  graphState.needsRebuild = true;
  requestAnimationFrame(() => {
    if (graphState && graphState.open && graphState.needsRebuild) rebuildGraph();
  });
}

function graphImages(): ImageItem[] {
  const state = ensureGraphState();
  return state.scope === 'all' ? allImages : visibleImages;
}

function rebuildGraph(): void {
  const state = ensureGraphState();
  state.needsRebuild = false;
  resizeGraphCanvas();
  const images = graphImages();
  const tagMap = new Map<string, GraphTagNode>();
  const imageNodes: GraphImageNode[] = [];
  const edges: GraphEdge[] = [];

  images.forEach(img => {
    const tags = dedupeDisplayTags(img.tags || []);
    if (!tags.length) return;
    const imageNode: GraphImageNode = {
      id: `img:${img.id}`,
      type: 'image',
      imageId: img.id,
      image: img,
      tags,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: 3.6
    };
    imageNodes.push(imageNode);
    tags.forEach(tag => {
      const norm = normalizeTag(tag);
      if (!tagMap.has(norm)) {
        tagMap.set(norm, {
          id: `tag:${norm}`,
          type: 'tag',
          tag,
          label: tag,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          r: 10
        });
      }
      edges.push({source: imageNode.id, target: `tag:${norm}`});
    });
  });

  const tagNodes = Array.from(tagMap.values());
  const totalNodes = tagNodes.length + imageNodes.length;
  const notice = requiredHtml('graph-notice');
  if (totalNodes > state.nodeLimit) {
    state.nodes = [];
    state.edges = [];
    notice.textContent = `Граф скрыт: ${totalNodes} узлов. Сузьте фильтр или переключитесь на текущую выборку.`;
    notice.classList.add('open');
    renderGraph();
    return;
  }
  notice.classList.remove('open');
  notice.textContent = '';

  const radius = Math.min(state.canvas.width, state.canvas.height) * 0.34;
  tagNodes.forEach((node, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(1, tagNodes.length);
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  });
  const tagById = new Map(tagNodes.map(node => [node.id, node]));
  imageNodes.forEach((node, i) => {
    const linked = node.tags
      .map(tag => tagById.get(`tag:${normalizeTag(tag)}`))
      .filter((tag): tag is GraphTagNode => Boolean(tag));
    const baseX = linked.reduce((sum, tag) => sum + tag.x, 0) / Math.max(1, linked.length);
    const baseY = linked.reduce((sum, tag) => sum + tag.y, 0) / Math.max(1, linked.length);
    const jitter = 18 + (i % 23);
    node.x = baseX + Math.cos(i * 2.399) * jitter;
    node.y = baseY + Math.sin(i * 2.399) * jitter;
  });
  state.nodes = [...tagNodes, ...imageNodes];
  state.edges = edges;
  state.tick = 0;
  if (!state.panX && !state.panY) {
    state.panX = state.canvas.width / 2;
    state.panY = state.canvas.height / 2;
  }
  startGraphAnimation();
}

function resizeGraphCanvas(): void {
  const state = ensureGraphState();
  const rect = state.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (state.canvas.width !== width || state.canvas.height !== height) {
    state.canvas.width = width;
    state.canvas.height = height;
    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.panX = width / 2;
    state.panY = height / 2;
  }
}

function startGraphAnimation(): void {
  const state = ensureGraphState();
  if (state.raf) cancelAnimationFrame(state.raf);
  const step = () => {
    if (!state.open) return;
    if (state.tick < 180 && !state.dragNode) {
      simulateGraphTick();
      state.tick += 1;
      renderGraph();
      state.raf = requestAnimationFrame(step);
    } else {
      state.raf = null;
      renderGraph();
    }
  };
  state.raf = requestAnimationFrame(step);
}

function simulateGraphTick(): void {
  const state = ensureGraphState();
  const nodeById = new Map(state.nodes.map(node => [node.id, node]));
  const tagNodes = state.nodes.filter(node => node.type === 'tag');
  const imageNodes = state.nodes.filter(node => node.type === 'image');
  const alpha = Math.max(0.02, 0.16 * (1 - state.tick / 190));

  state.edges.forEach(edge => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    source.vx += dx * 0.0024 * alpha;
    source.vy += dy * 0.0024 * alpha;
    target.vx -= dx * 0.0007 * alpha;
    target.vy -= dy * 0.0007 * alpha;
  });

  for (let i = 0; i < tagNodes.length; i++) {
    for (let j = i + 1; j < tagNodes.length; j++) {
      const a = tagNodes[i];
      const b = tagNodes[j];
      const dx = b.x - a.x || 0.1;
      const dy = b.y - a.y || 0.1;
      const distSq = dx * dx + dy * dy;
      const force = Math.min(1.8, 1700 / Math.max(80, distSq)) * alpha;
      a.vx -= dx * force * 0.002;
      a.vy -= dy * force * 0.002;
      b.vx += dx * force * 0.002;
      b.vy += dy * force * 0.002;
    }
  }

  imageNodes.forEach(node => {
    node.vx += -node.x * 0.00002;
    node.vy += -node.y * 0.00002;
  });
  state.nodes.forEach(node => {
    node.vx *= 0.82;
    node.vy *= 0.82;
    node.x += node.vx;
    node.y += node.vy;
  });
}

function renderGraph(): void {
  const state = ensureGraphState();
  const ctx = state.ctx;
  resizeGraphCanvas();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, state.canvas.width, state.canvas.height);
  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.scale, state.scale);

  const nodeById = new Map(state.nodes.map(node => [node.id, node]));
  ctx.lineWidth = 1 / state.scale;
  ctx.strokeStyle = 'rgba(180,180,180,.16)';
  state.edges.forEach(edge => {
    const a = nodeById.get(edge.source);
    const b = nodeById.get(edge.target);
    if (!a || !b) return;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  });

  const activeIncludes = new Set((activeTab().includeTags || []).map(normalizeTag));
  state.nodes.forEach(node => {
    if (node.type === 'image') {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(210,210,210,.55)';
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const norm = normalizeTag(node.tag);
    const highlighted = state.query && norm.includes(state.query);
    const active = activeIncludes.has(norm);
    const size = highlighted || active ? 13 : 10;
    ctx.save();
    ctx.translate(node.x, node.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = active ? '#FFFFFF' : highlighted ? '#CFCFCF' : '#111111';
    ctx.strokeStyle = active ? '#FFFFFF' : '#D4D4D4';
    ctx.lineWidth = (active || highlighted ? 1.8 : 1.1) / state.scale;
    ctx.beginPath();
    ctx.rect(-size, -size, size * 2, size * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.font = `${11 / state.scale}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    ctx.fillStyle = active ? '#FFFFFF' : '#D4D4D4';
    ctx.textAlign = 'center';
    ctx.fillText(node.label, node.x, node.y - 17);
  });
  ctx.restore();
}

function graphPoint(event: MouseEvent | WheelEvent): GraphPoint {
  const state = ensureGraphState();
  const rect = state.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const x = (event.clientX - rect.left) * dpr;
  const y = (event.clientY - rect.top) * dpr;
  return {
    screenX: x,
    screenY: y,
    x: (x - state.panX) / state.scale,
    y: (y - state.panY) / state.scale
  };
}

function findGraphNode(point: GraphPoint): GraphNode | null {
  const state = ensureGraphState();
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const node = state.nodes[i];
    const size = node.type === 'tag' ? 14 : 7;
    if (Math.abs(point.x - node.x) <= size && Math.abs(point.y - node.y) <= size) return node;
  }
  return null;
}

function handleGraphWheel(event: WheelEvent): void {
  const state = ensureGraphState();
  if (!state.open) return;
  event.preventDefault();
  const point = graphPoint(event);
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  const nextScale = Math.max(0.22, Math.min(4, state.scale * factor));
  state.panX = point.screenX - point.x * nextScale;
  state.panY = point.screenY - point.y * nextScale;
  state.scale = nextScale;
  renderGraph();
}

function handleGraphMouseDown(event: MouseEvent): void {
  const state = ensureGraphState();
  if (!state.open || event.button !== 0) return;
  const point = graphPoint(event);
  state.pointerMoved = false;
  state.lastX = point.screenX;
  state.lastY = point.screenY;
  state.dragNode = findGraphNode(point);
  state.isPanning = !state.dragNode;
  state.canvas.classList.add('dragging');
}

function handleGraphMouseMove(event: MouseEvent): void {
  const state = ensureGraphState();
  if (!state.open || (!state.dragNode && !state.isPanning)) return;
  const point = graphPoint(event);
  const dx = point.screenX - state.lastX;
  const dy = point.screenY - state.lastY;
  if (Math.abs(dx) + Math.abs(dy) > 2) state.pointerMoved = true;
  if (state.dragNode) {
    state.dragNode.x = point.x;
    state.dragNode.y = point.y;
    state.dragNode.vx = 0;
    state.dragNode.vy = 0;
  } else {
    state.panX += dx;
    state.panY += dy;
  }
  state.lastX = point.screenX;
  state.lastY = point.screenY;
  renderGraph();
}

function handleGraphMouseUp(event: MouseEvent): void {
  const state = ensureGraphState();
  if (!state.open) return;
  const clickedNode = state.dragNode;
  state.canvas.classList.remove('dragging');
  state.dragNode = null;
  state.isPanning = false;
  if (!clickedNode || state.pointerMoved) return;
  if (clickedNode.type === 'tag') {
    toggleGraphTagFilter(clickedNode.tag);
  } else {
    openGraphImage(clickedNode.imageId);
  }
}

function toggleGraphTagFilter(tag: string): void {
  const tab = activeTab();
  const norm = normalizeTag(tag);
  if ((tab.includeTags || []).some(item => normalizeTag(item) === norm)) {
    removeFilterTag('include', tag);
  } else {
    addFilterTag('include', tag, false);
  }
  renderGraph();
}

function openGraphImage(imageId: string): void {
  const source = graphImages();
  const idx = source.findIndex(img => img.id === imageId);
  if (idx < 0) return;
  closeGraph();
  openLightbox(idx, true, source);
}

function resetGraphLayout(): void {
  if (!graphState) return;
  graphState.scale = 1;
  graphState.panX = 0;
  graphState.panY = 0;
  if (graphState.open) rebuildGraph();
}

function initFishInput(
  inputId: string,
  ghostId: string,
  getExcluded: (value: string) => string[],
  onCommit: (tag: string) => void | Promise<void>
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
      ? allTagPool.find(tag => normalizeTag(tag).startsWith(q) && normalizeTag(tag) !== q && !excluded.has(normalizeTag(tag)))
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
        onCommit(controller.suggestion && normalizeTag(value) !== normalizeTag(controller.suggestion) ? value : (controller.suggestion || value));
        input.value = '';
        update();
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
      const img = (lightboxImages.length ? lightboxImages : visibleImages)[lbIndex];
      return img ? img.tags || [] : [];
    }, tag => addTagToPreview(tag)),
    initFishInput('tag-create-input', 'tag-create-ghost', () => [], tag => {
      requiredInput('tag-create-input').value = tag;
      createTagFromManager();
    })
  ];
}

function updateFishGhosts(): void {
  fishControllers.forEach(controller => controller.update && controller.update());
}

function openLightboxById(imageId: string, persist = true): void {
  const sourceList = visibleImages.find(img => img.id === imageId) ? visibleImages : allImages;
  const idx = sourceList.findIndex(img => img.id === imageId);
  if (idx < 0) {
    console.warn('openLightboxById: image not found in current gallery state', {
      imageId,
      visibleCount: visibleImages.length,
      allCount: allImages.length,
      renderedCardCount: document.querySelectorAll('.card[data-id]').length
    });
    return;
  }
  void openLightbox(idx, persist, sourceList);
}

async function openLightbox(idx: number, persist = true, sourceList: ImageItem[] = visibleImages): Promise<void> {
  const nextSource = Array.isArray(sourceList) && sourceList.length ? sourceList : visibleImages;
  if (!Number.isInteger(idx) || idx < 0 || idx >= nextSource.length) {
    console.warn('openLightbox: invalid image index', {
      idx,
      sourceLength: nextSource.length
    });
    return;
  }
  lightboxImages = nextSource;
  if (persist) suppressedPreviewRestoreId = null;
  togglePreviewTagDropdown(false);
  lbIndex = idx;
  const img = lightboxImages[lbIndex];
  activeTab().lastImageId = img.id;
  renderPreviewMeta(img, true);
  document.body.style.overflow = 'hidden';
  const token = ++previewRequestToken;
  try {
    const canvas = await getOriginalCanvas(img);
    if (token !== previewRequestToken || !lightboxImages[lbIndex] || lightboxImages[lbIndex].id !== img.id) return;
    if (!previewModal) return;
    previewModal.open(canvas);
    renderPreviewMeta(img, false);
    if (persist) saveSessionSoon();
    preloadPreviewNeighbors(idx);
  } catch (e) {
    console.error(e);
    if (e instanceof TerminalImageUnavailableError) return;
    alert('Не удалось открыть изображение: ' + errorMessage(e));
  }
}

function closePreview(clearLast = true): void {
  suppressPreviewCloseClear = !clearLast;
  if (previewModal && previewModal.isOpen) previewModal.close();
  suppressPreviewCloseClear = false;
  if (clearLast) {
    activeTab().lastImageId = null;
    saveSessionSoon();
  }
}

function handlePreviewClosed(): void {
  document.body.style.overflow = '';
  togglePreviewTagDropdown(false);
  lightboxImages = [];
  if (!suppressPreviewCloseClear && tabs.length && activeTab().lastImageId) {
    activeTab().lastImageId = null;
    saveSessionSoon();
  }
}

function previewNav(dir: number): void {
  const source = lightboxImages.length ? lightboxImages : visibleImages;
  if (!source.length) return;
  lbIndex = (lbIndex + dir + source.length) % source.length;
  openLightbox(lbIndex, true, source);
}

function renderPreviewMeta(img: ImageItem, loading: boolean): void {
  const name = fileName(img.path);
  requiredHtml('preview-name').textContent = loading ? `Загрузка: ${name}` : name;
  requiredHtml('preview-size').textContent = `${fmtSize(img.size)} · ${img.width || '?'}×${img.height || '?'}`;
  requiredAnchor('preview-open').href = `/file/${img.id}`;
  renderPreviewTags(img);
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
    btn.addEventListener('click', () => removeTagFromPreview(btn.dataset.tag));
  });
  renderPreviewTagDropdown();
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
  const img = (lightboxImages.length ? lightboxImages : visibleImages)[lbIndex];
  const used = new Set((img ? img.tags || [] : []).map(normalizeTag));
  const tags = allTagPool.filter(tag => !used.has(normalizeTag(tag)));
  dropdown.innerHTML = tags.length
    ? tags.map(tag => `<button class="preview-pick-tag" type="button" data-tag="${escAttr(tag)}">${renderTagChip(tag, {count: true})}</button>`).join('')
    : `<span class="muted-inline">Нет доступных тегов для добавления</span>`;
  dropdown.querySelectorAll<HTMLElement>('button[data-tag]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await addTagToPreview(btn.dataset.tag);
      togglePreviewTagDropdown(false);
    });
  });
}

async function addTagFromPreviewInput(): Promise<void> {
  const input = requiredInput('preview-tag-input');
  const value = input.value.trim();
  if (!value) return;
  await addTagToPreview(value);
  input.value = '';
  updateFishGhosts();
}

async function addTagToPreview(tag: string | undefined): Promise<void> {
  if (!tag) return;
  const img = (lightboxImages.length ? lightboxImages : visibleImages)[lbIndex];
  if (!img) return;
  const newTags = dedupeDisplayTags([...(img.user_tags || []), findDisplayTag(tag)]);
  await saveTags(img.id, newTags);
}

async function removeTagFromPreview(tag: string | undefined): Promise<void> {
  if (!tag) return;
  const img = (lightboxImages.length ? lightboxImages : visibleImages)[lbIndex];
  if (!img) return;
  const newTags = (img.user_tags || []).filter(t => normalizeTag(t) !== normalizeTag(tag));
  await saveTags(img.id, newTags);
}

async function saveTags(id: string, userTags: string[]): Promise<void> {
  try {
    const r = await fetch(`/api/tag/${id}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tags: userTags})
    });
    if (!r.ok) throw new Error(await readError(r));
    const updated = await readJsonRecord(r);
    updateImageTags(id, updated);
    await refreshTagPool();
  } catch (e) {
    console.error(e);
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
    setTagPool([...allTagPool, ...(updatedImage.tags || [])]);
    const previewImage = (lightboxImages.length ? lightboxImages : visibleImages)[lbIndex];
    if (previewImage && previewImage.id === id) renderPreviewTags(previewImage);
    updateCardForImage(updatedImage);
    updateFishGhosts();
  }
}

function getOriginalCanvas(img: ImageItem): Promise<HTMLCanvasElement> {
  const cached = canvasCache.get(img.id);
  if (cached) return cached;
  const originalUrl = `/file/${img.id}`;
  const promise = (async () => {
    const response = await fetch(originalUrl);
    if (!response.ok) {
      if (response.status === 422) {
        const payload = await readJsonRecord(response).catch((): JsonRecord => ({}));
        if (payload.error === 'image_unavailable') {
          handleTerminalImageUnavailable(img.id);
          throw new TerminalImageUnavailableError(img.id);
        }
      }
      if (response.status === 404) {
        throw new Error(`Оригинал недоступен: ${img.path} (${originalUrl})`);
      }
      throw new Error(`Не удалось загрузить оригинал (${response.status}): ${img.path} (${originalUrl})`);
    }
    const blob = await response.blob();
    return await new Promise<HTMLCanvasElement>((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(blob);
      image.decoding = 'async';
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || img.width || 1;
        canvas.height = image.naturalHeight || img.height || 1;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error(`Не удалось открыть canvas для ${img.path}`));
          return;
        }
        ctx.drawImage(image, 0, 0);
        resolve(canvas);
        trimCanvasCache();
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`Не удалось декодировать оригинал: ${img.path} (${originalUrl})`));
      };
      image.src = objectUrl;
    });
  })();
  canvasCache.set(img.id, promise);
  promise.catch(() => {
    if (canvasCache.get(img.id) === promise) canvasCache.delete(img.id);
  });
  trimCanvasCache();
  return promise;
}

function trimCanvasCache() {
  while (canvasCache.size > MAX_CANVAS_CACHE) {
    const first = canvasCache.keys().next().value;
    if (first !== undefined) canvasCache.delete(first);
  }
}

function preloadPreviewNeighbors(idx: number): void {
  const source = lightboxImages.length ? lightboxImages : visibleImages;
  [-2, -1, 1, 2].forEach(offset => {
    const img = source[idx + offset];
    if (img) getOriginalCanvas(img).catch(() => {});
  });
}

function restorePreviewIfNeeded(): void {
  if (activeView !== 'gallery') return;
  const tab = activeTab();
  if (!tab.lastImageId) return;
  if (tab.lastImageId === suppressedPreviewRestoreId) return;
  if (previewModal && !previewModal.isOpen) openLightboxById(tab.lastImageId, false);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (graphState && graphState.open) closeGraph();
    if (requiredHtml('settings-panel').classList.contains('open')) toggleSettings(false);
  }
  if (!previewModal || !previewModal.isOpen) return;
  if (isTextEntryTarget(e.target)) return;
  if (e.key === 'ArrowLeft') previewNav(-1);
  else if (e.key === 'ArrowRight') previewNav(1);
});

function saveSessionSoon(): void {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, 250);
}

async function saveSession(): Promise<void> {
  saveActiveScroll();
  const tab = activeTab();
  const body = {
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
    search_tags: tab.includeTags || [],
    last_image_id: tab.lastImageId || null
  };
  try {
    await fetch('/api/session', {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
  } catch {}
}

async function loadSession(): Promise<void> {
  try {
    const r = await fetch('/api/session');
    if (!r.ok) throw new Error(await readError(r));
    const s = await readJsonRecord(r);
    folderTagSync = s.folder_tag_sync !== false;
    renderFolderTagSyncSetting();
    tabs = normalizeTabs(s.tabs, s);
    const activeId = typeof s.active_tab_id === 'string' ? s.active_tab_id : null;
    activeTabId = activeId && tabs.some(tab => tab.id === activeId) ? activeId : tabs[0].id;
    renderTabs();
    renderFilterControls();
    const rootPath = typeof s.root_path === 'string' ? s.root_path : '';
    scannedRoots = Array.isArray(s.root_paths) && s.root_paths.length ? stringArray(s.root_paths) : (rootPath ? [rootPath] : []);
    const currentRoot = scannedRoots[scannedRoots.length - 1] || rootPath;
    if (currentRoot) {
      setFolderInputValues(currentRoot);
      updateRootSummary();
      await refreshFolderTree();
      showGallery();
      startStatusPolling();
      await refreshImages(true);
      const tab = activeTab();
      setTimeout(() => window.scrollTo({top: tab.scrollTop || 0}), 0);
    } else {
      showSetup();
      pollStatus();
    }
  } catch (e) {
    tabs = [makeDefaultTab()];
    activeTabId = tabs[0].id;
    renderTabs();
    renderFilterControls();
    showSetup();
    setDbStatus(false, errorMessage(e));
  }
}

function normalizeTabs(rawTabs: unknown, session: JsonRecord): GalleryTab[] {
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

function initPreview(): void {
  previewModal = new PreviewModal({}, handlePreviewClosed);
}

function aspectCss(img: ImageItem): string {
  const w = Number(img.width || 0);
  const h = Number(img.height || 0);
  if (w > 0 && h > 0) return `${w} / ${h}`;
  const ratio = Number(img.aspect_ratio || 1);
  return `${Math.max(1, Math.round(ratio * 1000))} / 1000`;
}

function imageAspectRatio(img: ImageItem): number {
  const width = Number(img.width || 0);
  const height = Number(img.height || 0);
  if (width > 0 && height > 0) return width / height;
  const ratio = Number(img.aspect_ratio || 1);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

function masonryColumnTarget(): number {
  const gallery = optionalHtml('gallery');
  if (!gallery) return 1;
  const width = gallery.clientWidth || window.innerWidth || MASONRY_COL_MIN;
  const styles = getComputedStyle(gallery);
  const gap = Number.parseFloat(styles.gap || styles.columnGap || '') || 10;
  if (width < 720) return 1;
  return Math.max(1, Math.floor((width + gap) / (MASONRY_COL_MIN + gap)));
}

function resetMasonryLayout(): void {
  masonryColumns = [];
  masonryHeights = [];
  masonryColumnCount = 0;
}

function ensureMasonryLayout(force = false): void {
  const gallery = optionalHtml('gallery');
  if (!gallery) return;
  const columnCount = masonryColumnTarget();
  if (!force && masonryColumnCount === columnCount && masonryColumns.length === columnCount) return;
  gallery.innerHTML = '';
  masonryColumns = [];
  masonryHeights = [];
  masonryColumnCount = columnCount;
  for (let i = 0; i < columnCount; i++) {
    const column = document.createElement('div');
    column.className = 'masonry-column';
    gallery.appendChild(column);
    masonryColumns.push(column);
    masonryHeights.push(0);
  }
}

function estimateCardHeight(img: ImageItem): number {
  const gallery = optionalHtml('gallery');
  if (!gallery) return MASONRY_COL_MIN;
  const gap = Number.parseFloat(getComputedStyle(gallery).gap || '') || 10;
  const columnWidth = masonryColumns[0] ? masonryColumns[0].clientWidth : MASONRY_COL_MIN;
  return Math.max(48, columnWidth / imageAspectRatio(img)) + gap;
}

function placeMasonryCard(card: HTMLElement, img: ImageItem): void {
  ensureMasonryLayout(false);
  if (!masonryColumns.length) return;
  let bestIndex = 0;
  for (let i = 1; i < masonryHeights.length; i++) {
    if (masonryHeights[i] < masonryHeights[bestIndex]) bestIndex = i;
  }
  masonryColumns[bestIndex].appendChild(card);
  masonryHeights[bestIndex] += estimateCardHeight(img);
}

function layoutGallery(): void {
  const count = renderedCount;
  if (!count) {
    resetMasonryLayout();
    ensureMasonryLayout(true);
    return;
  }
  const renderedImages = visibleImages.slice(0, count);
  loadedIds.clear();
  renderedCount = 0;
  resetMasonryLayout();
  ensureMasonryLayout(true);
  renderedImages.forEach(img => {
    if (loadedIds.has(img.id)) return;
    loadedIds.add(img.id);
    placeMasonryCard(makeCard(img), img);
    renderedCount += 1;
  });
  setupLazyLoad();
}

function normalizeTag(tag: unknown): string {
  return String(tag || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function tagName(tag: unknown): string {
  if (isRecord(tag)) return String(tag.name || '').trim().replace(/\s+/g, ' ');
  return String(tag || '').trim().replace(/\s+/g, ' ');
}

function setTagPool(rawTags: unknown): void {
  const previous = allTagMeta;
  const nextMeta = new Map<string, TagMeta>();
  const names: string[] = [];
  const source = Array.isArray(rawTags) ? rawTags : [];
  for (const item of source) {
    const name = tagName(item);
    const norm = normalizeTag(name);
    if (!name || nextMeta.has(norm)) continue;
    const old = (previous.get(norm) || {}) as Partial<TagMeta>;
    const meta: TagMeta = isRecord(item)
      ? {
        name,
        normalized: String(item.normalized || norm),
        color: typeof item.color === 'string' ? item.color : null,
        image_count: Number(item.image_count || 0),
        auto_count: Number(item.auto_count || 0),
        user_count: Number(item.user_count || 0),
        user_defined: Boolean(item.user_defined || Number(item.user_count || 0) > 0),
        is_auto: Boolean(item.is_auto || Number(item.auto_count || 0) > 0),
        source: item.source === 'auto' || Number(item.auto_count || 0) > 0 ? 'auto' : 'user',
        sources: Array.isArray(item.sources)
          ? item.sources.filter((value): value is 'auto' | 'user' => value === 'auto' || value === 'user')
          : [
            ...(Number(item.auto_count || 0) > 0 ? ['auto' as const] : []),
            ...(Boolean(item.user_defined) || Number(item.user_count || 0) > 0 ? ['user' as const] : []),
          ]
      }
      : {
        name,
        normalized: norm,
        color: old.color || null,
        image_count: Number(old.image_count || 0),
        auto_count: Number(old.auto_count || 0),
        user_count: Number(old.user_count || 0),
        user_defined: Boolean(old.user_defined),
        is_auto: Boolean(old.is_auto),
        source: old.source === 'auto' ? 'auto' : 'user',
        sources: old.sources || []
      };
    nextMeta.set(norm, meta);
    names.push(name);
  }
  allTagMeta = nextMeta;
  allTagPool = names;
  renderSidebarTags();
}

function getTagMeta(tag: unknown): TagMeta {
  const name = tagName(tag);
  const norm = normalizeTag(name);
  return allTagMeta.get(norm) || {
    name,
    normalized: norm,
    color: null,
    image_count: 0,
    auto_count: 0,
    user_count: 0,
    user_defined: false,
    is_auto: false,
    source: 'user',
    sources: []
  };
}

function renderSidebarTags(): void {
  const autoTarget = optionalHtml('sidebar-auto-tags');
  const userTarget = optionalHtml('sidebar-user-tags');
  if (!autoTarget || !userTarget) return;
  const query = normalizeTag(optionalInput('sidebar-tag-search')?.value || '');
  const tab = tabs.length ? activeTab() : null;
  const included = new Set((tab?.includeTags || []).map(normalizeTag));
  const excluded = new Set((tab?.excludeTags || []).map(normalizeTag));
  const tags = Array.from(allTagMeta.values())
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
  const meta = getTagMeta(name);
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

function splitTagPrefix(value: unknown): TagInputParse {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (raw.startsWith('!') || raw.startsWith('-')) {
    return {prefix: raw[0], value: raw.slice(1).trim()};
  }
  return {prefix: '', value: raw};
}

function dedupeDisplayTags(tags: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const source = Array.isArray(tags) ? tags : [];
  for (const tag of source) {
    const value = tagName(tag);
    const norm = normalizeTag(value);
    if (!value || seen.has(norm)) continue;
    seen.add(norm);
    result.push(value);
  }
  return result;
}

function findDisplayTag(tag: unknown): string {
  const value = tagName(tag);
  const norm = normalizeTag(value);
  return allTagPool.find(item => normalizeTag(item) === norm) || value;
}

function cssEscape(value: unknown): string {
  const text = String(value);
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
  return text.replace(/"/g, '\\"');
}

function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(s: unknown): string {
  return escHtml(s);
}

function fileName(path: unknown): string {
  return String(path || '').split(/[/\\]/).pop() || '';
}

function fmtSize(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return '';
  if (value < 1024) return value + ' B';
  if (value < 1048576) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1048576).toFixed(1) + ' MB';
}

async function readError(response: Response): Promise<string> {
  try {
    const data = await readJsonRecord(response);
    return String(data.detail || data.error || response.statusText);
  } catch {
    return response.statusText;
  }
}

function runAction(actionEl: HTMLElement): void {
  const action = actionEl.dataset.action;
  switch (action) {
    case 'add-tab':
      addTab();
      break;
    case 'add-tag-from-preview-input':
      addTagFromPreviewInput();
      break;
    case 'apply-tag-manager-selection':
      applyTagManagerSelection();
      break;
    case 'clear-active-filters':
      clearActiveFilters();
      break;
    case 'close-graph':
      closeGraph();
      break;
    case 'close-tag-manager':
      closeTagManager();
      break;
    case 'create-tag-from-manager':
      createTagFromManager();
      break;
    case 'create-tag-from-settings':
      createTagFromSettings();
      break;
    case 'delete-all-auto-tags':
      void deleteAllAutoTags();
      break;
    case 'open-folder':
      openFolder();
      break;
    case 'open-graph':
      openGraph();
      break;
    case 'open-tag-manager':
      openTagManager();
      break;
    case 'show-gallery-view':
      showGalleryView();
      break;
    case 'show-problems-view':
      showProblemsView();
      break;
    case 'set-problems-filter':
      setProblemsFilter(actionEl.dataset.severity);
      break;
    case 'load-more-problems':
      void loadProblems(false);
      break;
    case 'retry-problems':
      scheduleProblemsRefresh();
      break;
    case 'recheck-problem':
      void recheckProblem(Number(actionEl.dataset.problemId));
      break;
    case 'recheck-all-problems':
      void recheckAllProblems();
      break;
    case 'reveal-problem':
      void revealProblem(Number(actionEl.dataset.problemId));
      break;
    case 'pick-folder':
      pickFolder();
      break;
    case 'preview-nav':
      previewNav(Number(actionEl.dataset.dir || 0));
      break;
    case 'reset-graph-layout':
      resetGraphLayout();
      break;
    case 'scroll-to-top':
      scrollToTop();
      break;
    case 'set-graph-scope':
      setGraphScope(actionEl.dataset.scope || actionValue(actionEl));
      break;
    case 'set-match-mode':
      setMatchMode(actionEl.dataset.mode);
      break;
    case 'set-settings-tab':
      setSettingsTab(actionEl.dataset.settingsTab);
      break;
    case 'toggle-create-tag-panel':
      toggleCreateTagPanel(actionEl.dataset.open !== 'false');
      break;
    case 'toggle-folder-sidebar':
      toggleFolderSidebar();
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
    else if (actionEl.dataset.action === 'set-graph-scope') setGraphScope(actionEl.dataset.scope || actionValue(actionEl));
    else if (actionEl.dataset.action === 'toggle-folder-tag-sync' && actionEl instanceof HTMLInputElement) {
      void setFolderTagSync(actionEl.checked);
    }
  });
}

requiredHtml('tag-overlay').addEventListener('click', e => {
  if (e.target === requiredHtml('tag-overlay')) closeTagManager();
});

requiredHtml('settings-panel').addEventListener('click', e => {
  if (e.target === requiredHtml('settings-panel')) toggleSettings(false);
});

requiredHtml('graph-overlay').addEventListener('click', e => {
  if (e.target === requiredHtml('graph-overlay')) closeGraph();
});

document.addEventListener('click', e => {
  const targetNode = e.target instanceof Node ? e.target : null;
  const settings = requiredHtml('settings-panel');
  const settingsToggle = requiredHtml('settings-toggle');
  if (targetNode && settings.classList.contains('open') && !settings.contains(targetNode) && targetNode !== settingsToggle && !settingsToggle.contains(targetNode)) {
    toggleSettings(false);
  }
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
requiredInput('problems-search').addEventListener('input', () => {
  if (problemsSearchTimer) clearTimeout(problemsSearchTimer);
  problemsSearchTimer = setTimeout(() => {
    problemsSearchTimer = null;
    void loadProblems(true);
  }, 250);
});
requiredInput('tag-admin-create').addEventListener('keydown', e => {
  if (e.key === 'Enter') createTagFromSettings();
});
window.addEventListener('scroll', handleChromeScroll, {passive: true});
document.addEventListener('scroll', handleChromeScroll, {passive: true, capture: true});
window.addEventListener('wheel', () => requestAnimationFrame(handleChromeScroll), {passive: true});
window.addEventListener('touchmove', () => requestAnimationFrame(handleChromeScroll), {passive: true});
window.addEventListener('resize', () => {
  layoutGallery();
  if (graphState && graphState.open) rebuildGraph();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleProblemsRefresh(false);
});

initActionBindings();
initPreview();
initFilterInput();
initFishInputs();
startLiveEvents();
startProblemsPolling();
updateScrollTopButton();
handleChromeScroll();
loadSession();
