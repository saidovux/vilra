export type MatchMode = 'any' | 'all';
export type SortMode = 'path_asc' | 'path_desc' | 'date_desc' | 'date_asc' | 'size_desc' | 'size_asc';

export interface ImageQueryOptions {
  includeTags: readonly string[];
  excludeTags: readonly string[];
  matchMode: MatchMode;
  limit: number;
  sortMode: SortMode;
  includeTotal: boolean;
  cursor?: string | null;
}

export function buildImageQueryParams(options: ImageQueryOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (options.includeTags.length) params.set('include_tags', options.includeTags.join(','));
  if (options.excludeTags.length) params.set('exclude_tags', options.excludeTags.join(','));
  params.set('match_mode', options.matchMode === 'all' ? 'all' : 'any');
  params.set('limit', String(options.limit));
  params.set('sort', options.sortMode);
  params.set('include_total', options.includeTotal ? '1' : '0');
  if (options.cursor !== undefined && options.cursor !== null) params.set('cursor', options.cursor);
  return params;
}
