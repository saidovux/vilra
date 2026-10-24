import {isRecord} from '../shared/helpers';

export interface TagMeta {
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

export interface TagInputParse {
  prefix: string;
  value: string;
}

export function normalizeTag(tag: unknown): string {
  return String(tag || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function tagName(tag: unknown): string {
  if (isRecord(tag)) return String(tag.name || '').trim().replace(/\s+/g, ' ');
  return String(tag || '').trim().replace(/\s+/g, ' ');
}

export function splitTagPrefix(value: unknown): TagInputParse {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (raw.startsWith('!') || raw.startsWith('-')) {
    return {prefix: raw[0], value: raw.slice(1).trim()};
  }
  return {prefix: '', value: raw};
}

export function dedupeDisplayTags(tags: unknown): string[] {
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

export class TagCatalog {
  private tagNames: string[] = [];
  private tagMetadata = new Map<string, TagMeta>();

  get names(): readonly string[] {
    return this.tagNames;
  }

  replace(rawTags: unknown): void {
    const previous = this.tagMetadata;
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
            ],
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
          sources: old.sources || [],
        };
      nextMeta.set(norm, meta);
      names.push(name);
    }
    this.tagMetadata = nextMeta;
    this.tagNames = names;
  }

  getMeta(tag: unknown): TagMeta {
    const name = tagName(tag);
    const norm = normalizeTag(name);
    return this.tagMetadata.get(norm) || {
      name,
      normalized: norm,
      color: null,
      image_count: 0,
      auto_count: 0,
      user_count: 0,
      user_defined: false,
      is_auto: false,
      source: 'user',
      sources: [],
    };
  }

  findDisplayTag(tag: unknown): string {
    const value = tagName(tag);
    const norm = normalizeTag(value);
    return this.tagNames.find(item => normalizeTag(item) === norm) || value;
  }
}
