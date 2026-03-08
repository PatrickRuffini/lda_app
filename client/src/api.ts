const BASE = '/api';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export interface FilingSummary {
  filing_uuid: string;
  filing_type: string;
  filing_type_display: string;
  filing_year: number;
  filing_period: string;
  filing_period_display: string;
  filing_date: string | null;
  dt_posted: string | null;
  added_to_db: string | null;
  income: number | null;
  expenses: number | null;
  url: string | null;
  registrant: { name: string; senate_id: number } | null;
  client: { name: string; senate_id: number } | null;
  issue_codes: string[];
}

export interface LobbyingActivityDetail {
  general_issue_code: string;
  general_issue_code_display: string;
  description: string;
  specific_issues: string;
  government_entities: Array<{ name?: string } | string>;
  lobbyists: Array<{ lobbyist?: { first_name?: string; last_name?: string }; covered_position?: string } | string>;
}

export interface FilingDetail extends FilingSummary {
  expenses_method: string;
  expenses_method_display: string;
  posted_by_name: string;
  registrant_detail: {
    name: string;
    senate_id: number;
    description: string;
    address: string;
    country: string;
    state: string;
  } | null;
  client_detail: {
    name: string;
    senate_id: number;
    description: string;
    country: string;
    state: string;
  } | null;
  lobbying_activities: LobbyingActivityDetail[];
}

export interface PaginatedResponse<T> {
  results: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface IssueSummary {
  code: string;
  display: string;
  count: number;
}

export interface TopEntity {
  name: string;
  senate_id: number;
  filing_count: number;
  total_income: number;
}

export interface Stats {
  total_filings: number;
  total_registrants: number;
  total_clients: number;
  latest_filing: string | null;
  filings_by_year: Array<{ year: number; count: number }>;
}

export interface SyncStatus {
  status: string;
  mode?: string;
  stored?: number;
  skipped?: number;
  duplicates?: number;
  pages?: number;
  current_year?: number;
  years_completed?: number[];
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export interface SyncCoverage {
  years: Array<{ year: number; count: number }>;
  total: number;
}

export interface SearchParams {
  q?: string;
  filing_year?: number;
  filing_period?: string;
  filing_type?: string;
  issue_code?: string;
  registrant?: string;
  client?: string;
  min_income?: number;
  min_expenses?: number;
  sort?: string;
  page?: number;
  page_size?: number;
}

function toQuery(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  return sp.toString();
}

// ---------- Politico Influence types ----------

export interface NewsletterSummary {
  id: number;
  url: string;
  title: string;
  published_date: string | null;
  scraped_at: string | null;
  entities_extracted: boolean;
  body_preview: string;
}

export interface NewsletterDetail {
  id: number;
  url: string;
  title: string;
  published_date: string | null;
  body_text: string;
  body_html: string | null;
  entities: Array<{
    id: number;
    name: string;
    entity_type: string;
    is_consultant: boolean;
    is_client: boolean;
    display_name: string;
    paragraph_index: number;
    context: string;
    section_heading: string | null;
  }>;
}

export interface EntitySummary {
  id: number;
  name: string;
  entity_type: string;
  is_consultant?: boolean;
  is_client?: boolean;
  is_lobbyist?: boolean;
  display_name: string;
  mention_count: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface LdaFilingSummary {
  filing_uuid: string;
  filing_type: string;
  filing_type_display: string;
  filing_year: number;
  filing_period_display: string;
  dt_posted: string | null;
  income: number | null;
  expenses: number | null;
  url: string | null;
  registrant_name: string | null;
  client_name: string | null;
}

export interface EntityDetail extends EntitySummary {
  registrant_id: number | null;
  client_id: number | null;
  lda_match_method: string | null;
  connections: Array<{
    entity: EntitySummary;
    relationship_type: string;
    weight: number;
    first_seen: string | null;
    last_seen: string | null;
    context_snippets: string[];
    match_confidence: string | null;
    filing_id: number | null;
    filing_uuid: string | null;
    filing_type: string | null;
    filing_url: string | null;
    filing_date: string | null;
  }>;
  newsletter_mentions: Array<{
    newsletter_id: number;
    newsletter_title: string;
    published_date: string | null;
    context: string;
  }>;
  lda_filings: LdaFilingSummary[];
}

export interface NetworkData {
  nodes: Array<{
    id: number;
    name: string;
    entity_type: string;
    display_name: string;
    mention_count: number;
  }>;
  edges: Array<{
    source: number;
    target: number;
    weight: number;
    relationship_type: string;
  }>;
  total_entities: number;
  total_relationships: number;
}

export interface InfluenceStats {
  total_newsletters: number;
  total_entities: number;
  total_persons: number;
  total_organizations: number;
  total_relationships: number;
  total_affiliations: number;
  latest_newsletter: string | null;
}

export interface ReportSeries {
  series: Array<{
    name: string;
    data: Array<{ period: string; count: number }>;
  }>;
  granularity: string;
  periods?: string[];
}

export const api = {
  searchFilings: (params: SearchParams) =>
    fetchJson<PaginatedResponse<FilingSummary>>(`${BASE}/filings?${toQuery(params)}`),

  getFiling: (uuid: string) =>
    fetchJson<FilingDetail>(`${BASE}/filings/${uuid}`),

  getIssues: () =>
    fetchJson<IssueSummary[]>(`${BASE}/issues`),

  getFilingsByIssue: (code: string, page = 1) =>
    fetchJson<PaginatedResponse<FilingSummary>>(`${BASE}/issues/${code}/filings?page=${page}`),

  getTopRegistrants: (limit = 20) =>
    fetchJson<TopEntity[]>(`${BASE}/top-registrants?limit=${limit}`),

  getTopClients: (limit = 20) =>
    fetchJson<TopEntity[]>(`${BASE}/top-clients?limit=${limit}`),

  getStats: () =>
    fetchJson<Stats>(`${BASE}/stats`),

  triggerSync: (params: { mode?: string; max_pages?: number }) =>
    postJson<SyncStatus>(`${BASE}/sync`, params),

  cancelSync: () =>
    postJson<{ status: string }>(`${BASE}/sync/cancel`, {}),

  getSyncStatus: () =>
    fetchJson<SyncStatus>(`${BASE}/sync/status`),

  getSyncCoverage: () =>
    fetchJson<SyncCoverage>(`${BASE}/sync/coverage`),

  // Politico Influence
  triggerInfluenceScrape: (params: { max_newsletters?: number; max_discovery_pages?: number }) =>
    postJson<{ status: string }>(`${BASE}/influence/scrape`, params),

  getInfluenceScrapeStatus: () =>
    fetchJson<{ status: string; stored?: number; skipped?: number; errors?: number }>(`${BASE}/influence/scrape/status`),

  getNewsletters: (page = 1, pageSize = 25, q?: string) =>
    fetchJson<PaginatedResponse<NewsletterSummary>>(`${BASE}/influence/newsletters?page=${page}&page_size=${pageSize}${q ? `&q=${encodeURIComponent(q)}` : ''}`),

  getNewsletter: (id: number) =>
    fetchJson<NewsletterDetail>(`${BASE}/influence/newsletters/${id}`),

  getEntities: (params: { q?: string; entity_type?: string; sort?: string; page?: number; page_size?: number }) =>
    fetchJson<PaginatedResponse<EntitySummary>>(`${BASE}/influence/entities?${toQuery(params)}`),

  getEntity: (id: number) =>
    fetchJson<EntityDetail>(`${BASE}/influence/entities/${id}`),

  getNetwork: (params: { min_weight?: number; max_nodes?: number; entity_type?: string; center_entity_id?: number; depth?: number }) =>
    fetchJson<NetworkData>(`${BASE}/influence/network?${toQuery(params)}`),

  getInfluenceStats: () =>
    fetchJson<InfluenceStats>(`${BASE}/influence/stats`),

  updateEntityType: (id: number, entity_type: string, display_name?: string) =>
    fetch(`${BASE}/influence/entities/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type, ...(display_name ? { display_name } : {}) }),
    }).then(r => r.json()),

  reprocessEntities: () =>
    fetch(`${BASE}/influence/reprocess`, { method: 'POST' }).then(r => r.json()),

  getReprocessStatus: () =>
    fetchJson<{ status?: string; processed?: number; total?: number }>(`${BASE}/influence/reprocess/status`),

  linkLda: () =>
    fetch(`${BASE}/influence/link-lda`, { method: 'POST' }).then(r => r.json()),

  // AI
  getAiStatus: () =>
    fetchJson<{ available: boolean }>(`${BASE}/ai/status`),

  getEntitySummary: (id: number) =>
    postJson<{ summary: string }>(`${BASE}/ai/entity-summary/${id}`, {}),

  aiChat: (message: string, conversationId?: number, entityId?: number) =>
    postJson<{ response: string; conversation_id: number; message_id: number }>(
      `${BASE}/ai/chat`,
      { message, conversation_id: conversationId, entity_id: entityId },
    ),

  getConversations: (page = 1) =>
    fetchJson<{ results: Array<{ id: number; title: string; entity_id: number | null; message_count: number; created_at: string | null; updated_at: string | null }>; total: number; page: number; page_size: number }>(`${BASE}/ai/conversations?page=${page}`),

  getConversation: (id: number) =>
    fetchJson<{ id: number; title: string; entity_id: number | null; created_at: string | null; updated_at: string | null; messages: Array<{ id: number; role: string; content: string; created_at: string | null }> }>(`${BASE}/ai/conversations/${id}`),

  deleteConversation: (id: number) =>
    fetch(`${BASE}/ai/conversations/${id}`, { method: 'DELETE' }).then(r => r.json()),

  // Reports
  getRegistrationsByPeriod: (params: { granularity?: string; start_date?: string; end_date?: string; limit?: number }) =>
    fetchJson<ReportSeries>(`${BASE}/reports/registrations-by-period?${toQuery(params)}`),

  getIssuesByPeriod: (params: { granularity?: string; start_date?: string; end_date?: string; limit?: number }) =>
    fetchJson<ReportSeries>(`${BASE}/reports/issues-by-period?${toQuery(params)}`),

  getActivityHeatmap: () =>
    fetchJson<{ days: Array<{ date: string; count: number }> }>(`${BASE}/reports/activity-heatmap`),
};
