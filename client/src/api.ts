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
  stored?: number;
  skipped?: number;
  pages?: number;
  error?: string;
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

  triggerSync: (params: Partial<SearchParams & { max_pages?: number }>) =>
    postJson<SyncStatus>(`${BASE}/sync`, params),

  getSyncStatus: () =>
    fetchJson<SyncStatus>(`${BASE}/sync/status`),
};
