import {isDesktopRuntime, revealFileNative} from '../desktop-runtime';
import {
  errorMessage,
  escHtml,
  fileName,
  fmtSize,
  isRecord,
  readError,
  readJsonRecord,
  requireElement,
  type JsonRecord,
} from '../shared/helpers';

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

interface ProblemsWorkspaceOptions {
  isProblemsActive: () => boolean;
}

function requiredHtml(id: string): HTMLElement {
  return requireElement(id, HTMLElement, 'Required page element is missing');
}

function requiredInput(id: string): HTMLInputElement {
  return requireElement(id, HTMLInputElement, 'Required input is missing');
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
    updatedAt: String(value.updated_at || ''),
  };
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

export class ProblemsWorkspace {
  private summary: ProblemSummary = {total: 0, errors: 0, warnings: 0, latestUpdatedAt: null};
  private severity: ProblemSeverity = 'all';
  private items: ProblemItem[] = [];
  private total = 0;
  private loading = false;
  private loadError = '';
  private notice = '';
  private noticeIsError = false;
  private recheckAllRunning = false;
  private refreshRunning = false;
  private refreshQueued = false;
  private listRefreshQueued = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private requestToken = 0;
  private listReloadQueued = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly rowRechecks = new Set<number>();

  constructor(private readonly options: ProblemsWorkspaceOptions) {}

  scheduleRefresh(includeList = true): void {
    if (this.refreshRunning) {
      this.refreshQueued = true;
      this.listRefreshQueued ||= includeList;
      return;
    }
    this.refreshRunning = true;
    this.listRefreshQueued = includeList;
    void (async () => {
      do {
        this.refreshQueued = false;
        const refreshList = this.listRefreshQueued;
        this.listRefreshQueued = false;
        let summaryChanged = false;
        try {
          summaryChanged = await this.refreshSummary();
        } catch (error) {
          console.warn('Problems summary refresh failed', error);
        }
        if ((refreshList || summaryChanged) && this.options.isProblemsActive()) {
          await this.load(true);
        }
      } while (this.refreshQueued);
      this.refreshRunning = false;
    })();
  }

  async load(reset = true): Promise<void> {
    if (this.loading) {
      this.listReloadQueued ||= reset;
      return;
    }
    const token = ++this.requestToken;
    const offset = reset ? 0 : this.items.length;
    const search = requiredInput('problems-search').value.trim();
    this.loading = true;
    this.loadError = '';
    this.render();
    const params = new URLSearchParams({
      severity: this.severity,
      search,
      limit: '100',
      offset: String(offset),
    });
    try {
      const response = await fetch(`/api/problems?${params}`);
      if (!response.ok) throw new Error(await readError(response));
      const data = await readJsonRecord(response);
      if (token !== this.requestToken) return;
      const items = Array.isArray(data.items)
        ? data.items.map(normalizeProblemItem).filter((item): item is ProblemItem => Boolean(item))
        : [];
      this.items = reset ? items : [...this.items, ...items];
      const page = isRecord(data.page) ? data.page : {};
      this.total = Number(page.total || this.items.length);
    } catch (error) {
      if (token !== this.requestToken) return;
      this.loadError = errorMessage(error);
    } finally {
      if (token === this.requestToken) {
        this.loading = false;
        this.render();
        if (this.listReloadQueued) {
          this.listReloadQueued = false;
          void this.load(true);
        }
      }
    }
  }

  setFilter(value: string | undefined): void {
    this.severity = value === 'error' || value === 'warning' ? value : 'all';
    void this.load(true);
  }

  handleSearchInput(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.load(true);
    }, 250);
  }

  handleProblemsChanged(): void {
    this.scheduleRefresh();
  }

  handleRecheckFinished(data: JsonRecord): void {
    this.recheckAllRunning = false;
    this.notice = Number(data.failed || 0) > 0
      ? `Проверка завершена, ошибок выполнения: ${Number(data.failed || 0)}.`
      : 'Проверка завершена.';
    this.noticeIsError = Number(data.failed || 0) > 0;
    this.render();
    this.scheduleRefresh();
  }

  handleVisibilityChange(): void {
    if (document.visibilityState === 'visible') this.scheduleRefresh(false);
  }

  async recheck(issueId: number): Promise<void> {
    if (!Number.isInteger(issueId) || this.rowRechecks.has(issueId)) return;
    this.rowRechecks.add(issueId);
    this.render();
    try {
      const response = await fetch(`/api/problems/${issueId}/recheck`, {method: 'POST'});
      if (!response.ok) throw new Error(await readError(response));
      const result = await readJsonRecord(response);
      this.applyRecheckResult(issueId, result);
      this.scheduleRefresh();
    } catch (error) {
      this.notice = errorMessage(error);
      this.noticeIsError = true;
    } finally {
      this.rowRechecks.delete(issueId);
      this.render();
    }
  }

  async recheckAll(): Promise<void> {
    if (this.recheckAllRunning) return;
    this.recheckAllRunning = true;
    this.notice = '';
    this.noticeIsError = false;
    this.render();
    try {
      const response = await fetch('/api/problems/recheck-all', {method: 'POST'});
      if (response.status === 409) {
        this.recheckAllRunning = false;
        this.notice = 'Проверка уже выполняется.';
        this.noticeIsError = false;
        this.render();
        return;
      }
      if (!response.ok) throw new Error(await readError(response));
    } catch (error) {
      this.recheckAllRunning = false;
      this.notice = errorMessage(error);
      this.noticeIsError = true;
      this.render();
    }
  }

  async reveal(issueId: number): Promise<void> {
    const problem = this.items.find(item => item.id === issueId);
    if (!problem) return;
    const errorTarget = document.querySelector<HTMLElement>(`[data-problem-error="${issueId}"]`);
    if (errorTarget) errorTarget.textContent = '';
    try {
      if (isDesktopRuntime()) {
        await revealFileNative(problem.absolutePath);
      } else {
        await navigator.clipboard.writeText(problem.absolutePath);
        if (errorTarget) errorTarget.textContent = 'Путь скопирован.';
      }
    } catch (error) {
      if (errorTarget) errorTarget.textContent = errorMessage(error);
    }
  }

  startPolling(): void {
    this.scheduleRefresh(false);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.scheduleRefresh(false);
    }, 10_000);
  }

  private renderSummary(): void {
    requiredHtml('problems-total').textContent = String(this.summary.total);
    requiredHtml('problems-errors').textContent = String(this.summary.errors);
    requiredHtml('problems-warnings').textContent = String(this.summary.warnings);
    const badge = requiredHtml('problems-badge');
    badge.textContent = String(this.summary.errors);
    badge.classList.toggle('muted', this.summary.errors === 0);
  }

  private render(): void {
    document.querySelectorAll<HTMLElement>('.problems-filter').forEach(button => {
      button.classList.toggle('active', button.dataset.severity === this.severity);
    });
    const list = requiredHtml('problems-list');
    list.innerHTML = this.items.map(problem => `
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
          <button class="btn btn-ghost btn-sm" type="button" data-action="reveal-problem" data-problem-id="${problem.id}">${isDesktopRuntime() ? 'Показать в папке' : 'Копировать путь'}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="recheck-problem" data-problem-id="${problem.id}" ${this.rowRechecks.has(problem.id) ? 'disabled' : ''}>${this.rowRechecks.has(problem.id) ? 'Проверка…' : 'Проверить'}</button>
        </div>
      </article>
    `).join('');
    const feedback = requiredHtml('problems-feedback');
    feedback.classList.toggle('error', Boolean(this.loadError || (this.notice && this.noticeIsError)));
    if (this.loadError) feedback.innerHTML = `${escHtml(this.loadError)} <button class="btn btn-ghost btn-sm" type="button" data-action="retry-problems">Повторить</button>`;
    else if (this.notice) feedback.textContent = this.notice;
    else if (this.loading && !this.items.length) feedback.textContent = 'Загрузка…';
    else if (!this.items.length) feedback.textContent = 'Проблем не найдено.';
    else feedback.textContent = `Показано ${this.items.length} из ${this.total}`;
    const more = requireElement('problems-load-more', HTMLButtonElement, 'Problems load button is missing');
    more.hidden = this.items.length >= this.total;
    more.disabled = this.loading;
    const all = requireElement('problems-recheck-all', HTMLButtonElement, 'Problems recheck button is missing');
    all.disabled = this.recheckAllRunning || this.summary.total === 0;
    all.textContent = this.recheckAllRunning ? 'Проверка…' : 'Проверить все';
  }

  private async refreshSummary(): Promise<boolean> {
    const previous = this.summary;
    const response = await fetch('/api/problems/summary');
    if (!response.ok) throw new Error(await readError(response));
    const data = await readJsonRecord(response);
    const next: ProblemSummary = {
      total: Number(data.total || 0),
      errors: Number(data.errors || 0),
      warnings: Number(data.warnings || 0),
      latestUpdatedAt: typeof data.latest_updated_at === 'string' ? data.latest_updated_at : null,
    };
    const changed = previous.total !== next.total
      || previous.errors !== next.errors
      || previous.warnings !== next.warnings
      || previous.latestUpdatedAt !== next.latestUpdatedAt;
    this.summary = next;
    this.renderSummary();
    return changed;
  }

  private applyRecheckResult(issueId: number, result: JsonRecord): void {
    const existingIndex = this.items.findIndex(problem => problem.id === issueId);
    const issue = normalizeProblemItem(result.issue);
    const status = String(result.status || '');
    const keep = issue
      && status !== 'resolved'
      && (this.severity === 'all' || issue.severity === this.severity);
    if (keep) {
      if (existingIndex >= 0) this.items[existingIndex] = issue;
      else this.items.push(issue);
    } else if (existingIndex >= 0) {
      this.items.splice(existingIndex, 1);
      this.total = Math.max(0, this.total - 1);
    }
    this.notice = status === 'resolved'
      ? 'Проблема устранена.'
      : status === 'warning'
        ? 'Файл доступен, предупреждение обновлено.'
        : '';
    this.noticeIsError = false;
  }
}
