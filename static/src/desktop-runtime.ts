export type DesktopRuntimeKind = 'tauri' | 'electron' | 'browser';

type TauriApi = {
  dialog?: {
    open?: (options: {
      directory: boolean;
      multiple: boolean;
      title: string;
      defaultPath?: string;
    }) => Promise<string | string[] | null>;
  };
  core?: {
    invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
};

type ElectronBridge = {
  runtime: 'electron';
  pickFolder: (defaultPath?: string) => Promise<string | null>;
  revealPath: (path: string) => Promise<void>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: TauriApi;
    vilraDesktop?: ElectronBridge;
  }
}

export function desktopRuntimeKind(): DesktopRuntimeKind {
  if (window.vilraDesktop?.runtime === 'electron') return 'electron';
  if (window.__TAURI_INTERNALS__) return 'tauri';
  return 'browser';
}

export function isDesktopRuntime(): boolean {
  return desktopRuntimeKind() !== 'browser';
}

export function supportsNativeDiagnosticsPersistence(): boolean {
  return desktopRuntimeKind() === 'tauri';
}

export function diagnosticRuntimeLabel(): 'Tauri/WebKitGTK' | 'Electron/Chromium' | 'browser' {
  switch (desktopRuntimeKind()) {
    case 'tauri': return 'Tauri/WebKitGTK';
    case 'electron': return 'Electron/Chromium';
    default: return 'browser';
  }
}

export async function pickFolderNative(defaultPath = ''): Promise<string | null> {
  switch (desktopRuntimeKind()) {
    case 'electron':
      return window.vilraDesktop!.pickFolder(defaultPath || undefined);
    case 'tauri': {
      const openDialog = window.__TAURI__?.dialog?.open;
      if (!openDialog) throw new Error('Нативный диалог выбора папки недоступен');
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Выберите папку с изображениями',
        ...(defaultPath ? {defaultPath} : {}),
      });
      return Array.isArray(selected) ? (selected[0] || null) : selected;
    }
    default:
      throw new Error('Нативный диалог выбора папки недоступен');
  }
}

export async function revealFileNative(issueId: number, absolutePath: string): Promise<void> {
  switch (desktopRuntimeKind()) {
    case 'electron':
      await window.vilraDesktop!.revealPath(absolutePath);
      return;
    case 'tauri':
      await invokeTauriCommand('reveal_problem', {issueId});
      return;
    default:
      throw new Error('Native file reveal is unavailable');
  }
}

export async function invokeTauriCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (desktopRuntimeKind() !== 'tauri') {
    throw new Error('Native Tauri persistence is unavailable');
  }
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('Native Tauri persistence is unavailable');
  return invoke<T>(command, args);
}
