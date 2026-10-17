export type JsonRecord = Record<string, unknown>;

type ElementConstructor<T extends Element> = {new (...args: never[]): T};

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function escHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fileName(path: unknown): string {
  return String(path || '').split(/[/\\]/).pop() || '';
}

export function fmtSize(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return '';
  if (value < 1024) return value + ' B';
  if (value < 1048576) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1048576).toFixed(1) + ' MB';
}

export function requireElement<T extends Element>(
  id: string,
  expected: ElementConstructor<T>,
  message: string,
): T {
  const node = document.getElementById(id);
  if (!(node instanceof expected)) {
    throw new Error(`${message} (id="${id}")`);
  }
  return node;
}

export function optionalElement<T extends Element>(
  id: string,
  expected: ElementConstructor<T>,
): T | null {
  const node = document.getElementById(id);
  return node instanceof expected ? node : null;
}

export function optionalHtml(id: string): HTMLElement | null {
  return optionalElement(id, HTMLElement);
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

export function optionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export async function readJsonRecord(response: Response): Promise<JsonRecord> {
  const value: unknown = await response.json();
  return isRecord(value) ? value : {};
}

export async function readError(response: Response): Promise<string> {
  try {
    const data = await readJsonRecord(response);
    return String(data.detail || data.error || response.statusText);
  } catch {
    return response.statusText;
  }
}
