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
  unique_clients?: number;
  unique_registrants?: number;
  total_income: number;
}

export interface EntityAppearance {
  id: number;
  name: string;
  entity_type: string;
  display_name: string;
  mention_count: number;
  newsletter_count: number;
}

export interface RevenueByQuarter {
  overall: Array<{ year: number; period: string; revenue: number; filing_count: number }>;
  series: Array<{ name: string; data: Array<{ period: string; revenue: number }> }>;
  periods: string[];
}

export interface IssueFirmHeatmap {
  firms: string[];
  issues: string[];
  cells: number[][];
}

export interface EntityLdaStats {
  has_lda_data: boolean;
  registrant_name?: string;
  filing_count?: number;
  total_revenue?: number;
  unique_clients?: number;
  rank?: number;
  total_registrants?: number;
  issues?: Array<{
    issue: string;
    count: number;
    pct: number;
    avg_pct: number;
    overindex: number;
  }>;
}

export interface Stats {
  total_filings: number;
  total_registrants: number;
  total_clients: number;
  total_lobbyists: number;
  total_revenue: number;
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
  lobbyist?: string;
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

// ---------- Ad Tracking types ----------

export interface AdCaptureSummary {
  id: number;
  site: string;
  page_url: string;
  ad_slot: string;
  destination_url: string | null;
  destination_domain: string | null;
  resolved_url: string | null;
  resolved_domain: string | null;
  landing_page_title: string | null;
  landing_page_type: string | null;
  ad_text: string | null;
  has_screenshot: boolean;
  width: number | null;
  height: number | null;
  captured_at: string | null;
  campaign_id: number | null;
}

export interface AdCaptureDetail extends AdCaptureSummary {
  screenshot_base64: string | null;
  landing_page_description: string | null;
  landing_page_og_image: string | null;
  landing_page_keywords: string | null;
}

export interface AdCampaignSummary {
  id: number;
  advertiser_name: string;
  advertiser_domain: string | null;
  entity_id: number | null;
  first_seen: string | null;
  last_seen: string | null;
  capture_count: number;
  sites_seen_on: string[];
}

export interface AdStats {
  total_captures: number;
  total_campaigns: number;
  unique_domains: number;
  latest_capture: string | null;
  top_advertisers: Array<{ name: string; capture_count: number; domain: string | null }>;
  captures_by_site: Record<string, number>;
}

export const api = {
  searchFilings: (params: SearchParams) =>
    fetchJson<PaginatedResponse<FilingSummary>>(`${BASE}/filings?${toQuery(params)}`),

  getFiling: (uuid: string) =>
    fetchJson<FilingDetail>(`${BASE}/filings/${uuid}`),

  getIssues: () =>
    fetchJson<IssueSummary[]>(`${BASE}/issues`),

  getFilingsByIssue: (code: string, page = 1, filters?: { registrant_id?: number; client_id?: number; lobbyist_name?: string }) => {
    const params = new URLSearchParams({ page: String(page) });
    if (filters?.registrant_id) params.set('registrant_id', String(filters.registrant_id));
    if (filters?.client_id) params.set('client_id', String(filters.client_id));
    if (filters?.lobbyist_name) params.set('lobbyist_name', filters.lobbyist_name);
    return fetchJson<PaginatedResponse<FilingSummary>>(`${BASE}/issues/${code}/filings?${params}`);
  },

  getIssueSidebar: (code: string, limit = 10) =>
    fetchJson<{
      firms: Array<{ id: number; name: string; filing_count: number; total_income: number }>;
      clients: Array<{ id: number; name: string; filing_count: number; total_spending: number }>;
      lobbyists: Array<{ name: string; filing_count: number }>;
    }>(`${BASE}/issues/${code}/sidebar?limit=${limit}`),

  getTopRegistrants: (limit = 20, sort = 'filings') =>
    fetchJson<TopEntity[]>(`${BASE}/top-registrants?limit=${limit}&sort=${sort}`),

  getTopClients: (limit = 20, sort = 'filings') =>
    fetchJson<TopEntity[]>(`${BASE}/top-clients?limit=${limit}&sort=${sort}`),

  getRevenuePerLobbyist: (limit = 15, minClients = 0) =>
    fetchJson<Array<{ id: number; name: string; filing_count: number; total_revenue: number; unique_clients: number; lobbyist_count: number; revenue_per_lobbyist: number | null }>>(`${BASE}/revenue-per-lobbyist?limit=${limit}&min_clients=${minClients}`),

  getTopLobbyistsByClients: (limit = 15) =>
    fetchJson<Array<{ name: string; unique_clients: number; firms: string[] }>>(`${BASE}/top-lobbyists-by-clients?limit=${limit}`),

  getTopConsultants: (limit = 10, sort = 'mention_count') =>
    fetchJson<Array<{ id: number; name: string; display_name: string; mention_count: number; filing_count: number; unique_clients: number }>>(`${BASE}/top-consultants?limit=${limit}&sort=${sort}`),

  getTopLobbyists: (limit = 10, sort = 'mention_count') =>
    fetchJson<Array<{ id: number; name: string; display_name: string; mention_count: number }>>(`${BASE}/top-lobbyists?limit=${limit}&sort=${sort}`),

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
  getRegistrants: () =>
    fetchJson<Array<{ id: number; name: string; filing_count: number }>>(`${BASE}/registrants`),

  getRegistrationsByPeriod: (params: { granularity?: string; start_date?: string; end_date?: string; limit?: number; registrant_id?: number; issue_code?: string }) =>
    fetchJson<ReportSeries>(`${BASE}/reports/registrations-by-period?${toQuery(params)}`),

  getIssuesByPeriod: (params: { granularity?: string; start_date?: string; end_date?: string; limit?: number; registrant_id?: number; issue_code?: string }) =>
    fetchJson<ReportSeries>(`${BASE}/reports/issues-by-period?${toQuery(params)}`),

  getActivityHeatmap: (params?: { registrant_id?: number; issue_code?: string }) =>
    fetchJson<{ days: Array<{ date: string; count: number }> }>(`${BASE}/reports/activity-heatmap${params ? '?' + toQuery(params) : ''}`),

  getRevenueByQuarter: (limit = 10, params?: { registrant_id?: number; issue_code?: string }) =>
    fetchJson<RevenueByQuarter>(`${BASE}/reports/revenue-by-quarter?limit=${limit}${params ? '&' + toQuery(params) : ''}`),

  getEntityAppearances: (limit = 25, entityType?: string) =>
    fetchJson<EntityAppearance[]>(`${BASE}/reports/entity-appearances?limit=${limit}${entityType ? `&entity_type=${entityType}` : ''}`),

  getIssueFirmHeatmap: (limit = 15) =>
    fetchJson<IssueFirmHeatmap>(`${BASE}/reports/issue-firm-heatmap?limit=${limit}`),

  getEntityLdaStats: (entityId: number) =>
    fetchJson<EntityLdaStats>(`${BASE}/influence/entities/${entityId}/lda-stats`),

  getTopConsultantsByRevenue: (limit = 15) =>
    fetchJson<Array<{ id: number; display_name: string; name: string; total_revenue: number; filing_count: number; unique_clients: number }>>(`${BASE}/reports/top-consultants-by-revenue?limit=${limit}`),

  getTopClientsBySpend: (limit = 15) =>
    fetchJson<Array<{ name: string; total_spend: number; filing_count: number; firm_count: number }>>(`${BASE}/reports/top-clients-by-spend?limit=${limit}`),

  getFilingTypeBreakdown: (params?: { registrant_id?: number; issue_code?: string }) =>
    fetchJson<Array<{ type: string; display: string; count: number }>>(`${BASE}/reports/filing-type-breakdown${params ? '?' + toQuery(params) : ''}`),

  getRegistrationTrend: (granularity = 'month', params?: { registrant_id?: number; issue_code?: string }) =>
    fetchJson<{ periods: string[]; registrations: number[]; terminations: number[]; granularity: string }>(`${BASE}/reports/registration-trend?granularity=${granularity}${params ? '&' + toQuery(params) : ''}`),

  getTopIssuesByRevenue: (limit = 15) =>
    fetchJson<Array<{ issue: string; total_revenue: number; filing_count: number; firm_count: number }>>(`${BASE}/reports/top-issues-by-revenue?limit=${limit}`),

  // Ad Tracking
  triggerAdScrape: (params?: { sites?: string; max_pages_per_site?: number }) =>
    postJson<{ status: string }>(`${BASE}/ads/scrape`, params ?? {}),

  getAdScrapeStatus: () =>
    fetchJson<{ status: string; captured?: number; errors?: number; sites_completed?: string[]; log?: string[]; error?: string }>(`${BASE}/ads/scrape/status`),

  getAdCaptures: (params?: { site?: string; domain?: string; page?: number; page_size?: number }) =>
    fetchJson<PaginatedResponse<AdCaptureSummary>>(`${BASE}/ads/captures?${toQuery(params ?? {})}`),

  getAdCapture: (id: number) =>
    fetchJson<AdCaptureDetail>(`${BASE}/ads/captures/${id}`),

  getAdCampaigns: (params?: { sort?: string; page?: number; page_size?: number }) =>
    fetchJson<PaginatedResponse<AdCampaignSummary>>(`${BASE}/ads/campaigns?${toQuery(params ?? {})}`),

  getAdStats: () =>
    fetchJson<AdStats>(`${BASE}/ads/stats`),
};
