export type DesktopRuntimeKind = 'electron' | 'browser';
export type GalleryArrowDirection = 'up' | 'down';
export type GalleryArrowPhase = 'down' | 'up';

type ElectronBridge = {
  runtime: 'electron';
  pickFolder: (defaultPath?: string) => Promise<string | null>;
  revealPath: (path: string) => Promise<void>;
  sendGalleryArrowInput: (
    direction: GalleryArrowDirection,
    phase: GalleryArrowPhase,
    repeat: boolean,
  ) => void;
  diagnosticsBegin: () => Promise<unknown>;
  diagnosticsCheckpoint: (sessionId: string, reportJson: string) => Promise<unknown>;
  diagnosticsFinalize: (sessionId: string, reportJson: string) => Promise<unknown>;
  diagnosticsStatus: () => Promise<unknown>;
};

declare global {
  interface Window {
    vilraDesktop?: ElectronBridge;
  }
}

export function desktopRuntimeKind(): DesktopRuntimeKind {
  if (window.vilraDesktop?.runtime === 'electron') return 'electron';
  return 'browser';
}

export function isDesktopRuntime(): boolean {
  return desktopRuntimeKind() !== 'browser';
}

export function supportsNativeDiagnosticsPersistence(): boolean {
  return desktopRuntimeKind() === 'electron';
}

export function diagnosticRuntimeLabel(): 'Electron/Chromium' | 'browser' {
  return desktopRuntimeKind() === 'electron' ? 'Electron/Chromium' : 'browser';
}

export async function pickFolderNative(defaultPath = ''): Promise<string | null> {
  if (desktopRuntimeKind() !== 'electron') {
    throw new Error('Нативный диалог выбора папки недоступен');
  }
  return window.vilraDesktop!.pickFolder(defaultPath || undefined);
}

export async function revealFileNative(absolutePath: string): Promise<void> {
  if (desktopRuntimeKind() !== 'electron') {
    throw new Error('Native file reveal is unavailable');
  }
  await window.vilraDesktop!.revealPath(absolutePath);
}

export function sendGalleryArrowInputNative(
  direction: GalleryArrowDirection,
  phase: GalleryArrowPhase,
  repeat: boolean,
): boolean {
  if (desktopRuntimeKind() !== 'electron') return false;
  electronBridge().sendGalleryArrowInput(direction, phase, repeat);
  return true;
}

function electronBridge(): ElectronBridge {
  if (desktopRuntimeKind() !== 'electron' || !window.vilraDesktop) {
    throw new Error('Native Electron persistence is unavailable');
  }
  return window.vilraDesktop;
}

export async function beginNativeDiagnosticSession<T>(): Promise<T> {
  return electronBridge().diagnosticsBegin() as Promise<T>;
}

export async function checkpointNativeDiagnosticSession<T>(
  sessionId: string,
  reportJson: string,
): Promise<T> {
  return electronBridge().diagnosticsCheckpoint(sessionId, reportJson) as Promise<T>;
}

export async function finalizeNativeDiagnosticSession<T>(
  sessionId: string,
  reportJson: string,
): Promise<T> {
  return electronBridge().diagnosticsFinalize(sessionId, reportJson) as Promise<T>;
}

export async function nativeDiagnosticStatus<T>(): Promise<T> {
  return electronBridge().diagnosticsStatus() as Promise<T>;
}
