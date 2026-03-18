import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, FileText, Tag, BarChart3, RefreshCw, Building2, Users, ChevronLeft, ChevronRight, ExternalLink, DollarSign, Calendar, Loader2, Network, Newspaper, User, Briefcase, Menu, X, Download, Square, ChevronDown, Target, Sparkles, Send, MessageCircle, Bot, PanelLeftOpen, PanelLeftClose, TrendingUp, Settings, Eye } from 'lucide-react';
import { api, type FilingSummary, type FilingDetail, type IssueSummary, type Stats, type SyncStatus, type SyncCoverage, type SearchParams, type TopEntity, type NewsletterSummary, type NewsletterDetail, type EntitySummary, type EntityDetail, type NetworkData, type InfluenceStats, type ReportSeries, type EntityAppearance, type RevenueByQuarter, type IssueFirmHeatmap, type EntityLdaStats, type AdCaptureSummary, type AdCaptureDetail, type AdCampaignSummary, type AdStats } from './api';
import { formatDistanceToNow, format } from 'date-fns';
import NetworkGraph, { computeEigenvectorCentrality, type SizeMode } from './NetworkGraph';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type Page = 'dashboard' | 'search' | 'issues' | 'filing' | 'influence' | 'network' | 'entity' | 'newsletter' | 'leaderboard' | 'chat' | 'reports' | 'utilities' | 'ads';

function formatMoney(val: number | null | undefined): string {
  if (val === null || val === undefined) return '-';
  const abs = Math.abs(val);
  if (abs >= 1e9) return `$${(val / 1e9).toFixed(3)}B`;
  if (abs >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function timeAgo(dt: string | null): string {
  if (!dt) return '-';
  try { return formatDistanceToNow(new Date(dt), { addSuffix: true }); } catch { return dt; }
}

function formatDate(dt: string | null): string {
  if (!dt) return '-';
  try { return format(new Date(dt), 'MMM d, yyyy'); } catch { return dt; }
}

// ---------- Nav ----------
function Nav({ page, setPage }: { page: Page; setPage: (p: Page) => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const links: { id: Page; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 size={18} /> },
    { id: 'search', label: 'Search', icon: <Search size={18} /> },
    { id: 'influence', label: 'Influence', icon: <Newspaper size={18} /> },
    { id: 'network', label: 'Network', icon: <Network size={18} /> },
    { id: 'reports', label: 'Reports', icon: <TrendingUp size={18} /> },
    { id: 'ads', label: 'Ad Tracker', icon: <Eye size={18} /> },
    { id: 'chat', label: 'AI Chat', icon: <Bot size={18} /> },
  ];
  const allLinks = [...links, { id: 'utilities' as Page, label: 'Utilities', icon: <Settings size={18} /> }];
  const handleNav = (p: Page) => { setPage(p); setMobileOpen(false); };
  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center h-14 gap-6">
        <button onClick={() => handleNav('dashboard')} data-testid="link-home" className="flex items-center gap-2 font-bold text-indigo-700 text-lg shrink-0 cursor-pointer">
          <FileText size={22} /> LDA Tracker
        </button>
        <nav className="hidden md:flex gap-1">
          {allLinks.map(l => (
            <button
              key={l.id}
              data-testid={`link-nav-${l.id}`}
              onClick={() => handleNav(l.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition cursor-pointer ${page === l.id ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              {l.icon} {l.label}
            </button>
          ))}
        </nav>
        <button
          data-testid="button-mobile-menu"
          onClick={() => setMobileOpen(o => !o)}
          className="md:hidden ml-auto p-2 rounded-md text-gray-600 hover:bg-gray-100 cursor-pointer"
        >
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {mobileOpen && (
        <nav className="md:hidden border-t border-gray-100 bg-white px-4 pb-3 pt-1" data-testid="nav-mobile-menu">
          {allLinks.map(l => (
            <button
              key={l.id}
              data-testid={`link-mobile-nav-${l.id}`}
              onClick={() => handleNav(l.id)}
              className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-md text-sm font-medium transition cursor-pointer ${page === l.id ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              {l.icon} {l.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}

// ---------- Filing Card ----------
function FilingCard({ filing, onClick }: { filing: FilingSummary; onClick: () => void }) {
  return (
    <div onClick={onClick} className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition cursor-pointer">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{filing.client?.name || 'Unknown Client'}</p>
          <p className="text-sm text-gray-500 truncate">{filing.registrant?.name || 'Unknown Registrant'}</p>
        </div>
        <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full whitespace-nowrap">
          {filing.filing_type_display || filing.filing_type}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {filing.issue_codes.slice(0, 3).map(code => (
          <span key={code} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{code}</span>
        ))}
        {filing.issue_codes.length > 3 && (
          <span className="text-xs text-gray-400">+{filing.issue_codes.length - 3} more</span>
        )}
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><Calendar size={12} />{timeAgo(filing.dt_posted)}</span>
        {filing.income != null && filing.income > 0 && (
          <span className="flex items-center gap-1 text-green-600">{formatMoney(filing.income)}</span>
        )}
        {filing.expenses != null && filing.expenses > 0 && (
          <span className="flex items-center gap-1 text-orange-600">{formatMoney(filing.expenses)} exp.</span>
        )}
        <span>{filing.filing_year} {filing.filing_period_display}</span>
      </div>
    </div>
  );
}

// ---------- Pagination ----------
function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between mt-4">
      <p className="text-sm text-gray-500">{total.toLocaleString()} results</p>
      <div className="flex items-center gap-2">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="p-1.5 rounded border border-gray-300 disabled:opacity-40 cursor-pointer hover:bg-gray-50"><ChevronLeft size={16} /></button>
        <span className="text-sm text-gray-600">Page {page} of {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="p-1.5 rounded border border-gray-300 disabled:opacity-40 cursor-pointer hover:bg-gray-50"><ChevronRight size={16} /></button>
      </div>
    </div>
  );
}

// Shared leaderboard table component for consistent formatting across all 4 dashboard tables
function LeaderboardTable({ title, icon, rows, loading: isLoading, error: hasError, valueLabel, valueKey, secondaryLabel, secondaryKey, tooltip, onRowClick }: {
  title: string;
  icon: React.ReactNode;
  rows: Array<{ name: string; [k: string]: unknown }>;
  loading: boolean;
  error?: boolean;
  valueLabel: string;
  valueKey: string;
  secondaryLabel?: string;
  secondaryKey?: string;
  tooltip?: (row: { name: string; [k: string]: unknown }) => string;
  onRowClick?: (row: { name: string; [k: string]: unknown }) => void;
}) {
  if (isLoading) return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">{icon} {title}</h3>
      <div className="flex justify-center py-8">
        <Loader2 className="animate-spin text-gray-300" size={20} />
      </div>
    </div>
  );
  if (hasError || !rows.length) return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">{icon} {title}</h3>
      <p className="text-sm text-gray-400 py-8 text-center">{hasError ? 'Failed to load data' : 'No data available'}</p>
    </div>
  );
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">{icon} {title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-100">
              <th className="pb-2 pr-3 font-medium w-8">#</th>
              <th className="pb-2 pr-3 font-medium">Name</th>
              {secondaryLabel && <th className="pb-2 pr-3 font-medium text-right">{secondaryLabel}</th>}
              <th className="pb-2 font-medium text-right">{valueLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name + i} className="border-b border-gray-50 last:border-0" title={tooltip ? tooltip(r) : undefined}>
                <td className="py-1.5 pr-3 text-gray-400">{i + 1}</td>
                <td className="py-1.5 pr-3 text-gray-700 truncate max-w-[220px]">{onRowClick ? <button onClick={() => onRowClick(r)} className="hover:text-indigo-600 transition cursor-pointer text-left">{r.name}</button> : r.name}</td>
                {secondaryKey && <td className="py-1.5 pr-3 text-right text-gray-500">{typeof r[secondaryKey] === 'number' ? (r[secondaryKey] as number).toLocaleString() : r[secondaryKey] as string}</td>}
                <td className="py-1.5 text-right font-medium text-indigo-600">
                  {typeof r[valueKey] === 'number'
                    ? (valueKey.includes('revenue') || valueKey.includes('income') || valueKey.includes('spend')
                        ? formatMoney(r[valueKey] as number)
                        : (r[valueKey] as number).toLocaleString())
                    : (r[valueKey] as string) ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Dashboard ----------
function Dashboard({ onNavigate }: { onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<FilingSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // 4 chart datasets — each loads independently
  const [firmsByRevenue, setFirmsByRevenue] = useState<TopEntity[]>([]);
  const [firmsByRevenueLoading, setFirmsByRevenueLoading] = useState(true);
  const [firmsByRevenueError, setFirmsByRevenueError] = useState(false);
  const [firmsByClients, setFirmsByClients] = useState<TopEntity[]>([]);
  const [firmsByClientsLoading, setFirmsByClientsLoading] = useState(true);
  const [firmsByClientsError, setFirmsByClientsError] = useState(false);
  const [lobbyistsByClients, setLobbyistsByClients] = useState<Array<{ name: string; unique_clients: number; firms: string[] }>>([]);
  const [lobbyistsByClientsLoading, setLobbyistsByClientsLoading] = useState(true);
  const [lobbyistsByClientsError, setLobbyistsByClientsError] = useState(false);
  const [topClientsBySpend, setTopClientsBySpend] = useState<Array<{ name: string; total_spend: number; filing_count: number; firm_count: number; [k: string]: unknown }>>([]);
  const [topClientsBySpendLoading, setTopClientsBySpendLoading] = useState(true);
  const [topClientsBySpendError, setTopClientsBySpendError] = useState(false);


  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        api.getStats().then(setStats).catch(console.error);
        const [r] = await Promise.all([
          api.searchFilings({ sort: '-dt_posted', page_size: 10 }),
        ]);
        if (cancelled) return;
        setRecent(r.results);
        setLoading(false);
        // Load each chart independently so one slow endpoint doesn't block others
        api.getTopRegistrants(15, 'revenue').then(d => { if (!cancelled) { setFirmsByRevenue(d); setFirmsByRevenueLoading(false); } }).catch(e => { console.error('firmsByRevenue failed:', e); if (!cancelled) { setFirmsByRevenueError(true); setFirmsByRevenueLoading(false); } });
        api.getTopRegistrants(15, 'unique_clients').then(d => { if (!cancelled) { setFirmsByClients(d); setFirmsByClientsLoading(false); } }).catch(e => { console.error('firmsByClients failed:', e); if (!cancelled) { setFirmsByClientsError(true); setFirmsByClientsLoading(false); } });
        api.getTopLobbyistsByClients(15).then(d => { if (!cancelled) { setLobbyistsByClients(d); setLobbyistsByClientsLoading(false); } }).catch(e => { console.error('lobbyistsByClients failed:', e); if (!cancelled) { setLobbyistsByClientsError(true); setLobbyistsByClientsLoading(false); } });
        api.getTopClientsBySpend(15).then(d => { if (!cancelled) { setTopClientsBySpend(d); setTopClientsBySpendLoading(false); } }).catch(e => { console.error('topClientsBySpend failed:', e); if (!cancelled) { setTopClientsBySpendError(true); setTopClientsBySpendLoading(false); } });
      } catch (e) {
        console.error(e);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);


  return (
    <div className="space-y-6">
      {/* Stats cards */}
      {stats && stats.total_filings > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-2xl font-bold text-indigo-700">{stats.total_filings.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Total Filings</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-2xl font-bold text-indigo-700">{stats.total_registrants.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Registrants</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-2xl font-bold text-indigo-700">{stats.total_clients.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Clients</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-2xl font-bold text-indigo-700">{stats.total_lobbyists.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Lobbyists</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-2xl font-bold text-indigo-700">{formatMoney(stats.total_revenue)}</p>
            <p className="text-sm text-gray-500">Total Revenue</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-2xl font-bold text-green-700">{stats.total_lobbyists > 0 ? formatMoney(stats.total_revenue / stats.total_lobbyists) : '$0'}</p>
            <p className="text-sm text-gray-500">Rev / Lobbyist</p>
          </div>
        </div>
      )}

      {stats && (
        <p className="text-sm text-gray-500 -mt-4">
          {stats.total_filings.toLocaleString()} filings stored
          {stats.latest_filing && <> · Latest: {formatDate(stats.latest_filing)}</>}
        </p>
      )}

      {/* 2x2 Leaderboard Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <LeaderboardTable
          title="Lobbying Firms by Revenue"
          icon={<DollarSign size={16} />}
          rows={firmsByRevenue}
          loading={firmsByRevenueLoading}
          error={firmsByRevenueError}
          valueLabel="Revenue"
          valueKey="total_income"
          onRowClick={(r) => onNavigate('search', { registrant: r.name })}
        />
        <LeaderboardTable
          title="Lobbying Firms by # of Clients"
          icon={<Users size={16} />}
          rows={firmsByClients}
          loading={firmsByClientsLoading}
          error={firmsByClientsError}
          valueLabel="Clients"
          valueKey="unique_clients"
          onRowClick={(r) => onNavigate('search', { registrant: r.name })}
        />
        <LeaderboardTable
          title="Top Lobbyists by Unique Clients"
          icon={<User size={16} />}
          rows={lobbyistsByClients}
          loading={lobbyistsByClientsLoading}
          error={lobbyistsByClientsError}
          valueLabel="Clients"
          valueKey="unique_clients"
          tooltip={(r) => `Firms: ${(r.firms as string[] || []).join(', ')}`}
          onRowClick={(r) => onNavigate('search', { q: r.name })}
        />
        <LeaderboardTable
          title="Top Clients by Lobbying Spend"
          icon={<TrendingUp size={16} />}
          rows={topClientsBySpend}
          loading={topClientsBySpendLoading}
          error={topClientsBySpendError}
          valueLabel="Total Spend"
          valueKey="total_spend"
          onRowClick={(r) => onNavigate('search', { client: r.name })}
        />
      </div>

      {/* Recent filings */}
      {loading && <div className="flex items-center justify-center py-8"><Loader2 className="animate-spin text-gray-300" size={24} /></div>}
      {!loading && recent.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900">Recent Filings</h2>
            <button onClick={() => onNavigate('search')} className="text-sm text-indigo-600 hover:underline cursor-pointer">View all</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {recent.map(f => (
              <FilingCard key={f.filing_uuid} filing={f} onClick={() => onNavigate('filing', f.filing_uuid)} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {stats && stats.total_filings === 0 && (
        <div className="text-center py-16">
          <FileText size={48} className="mx-auto text-gray-300 mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">No filings yet</h2>
          <p className="text-gray-500 mb-4">Go to <button onClick={() => onNavigate('utilities')} className="text-indigo-600 hover:underline cursor-pointer">Utilities</button> to sync filings from the Senate LDA API.</p>
        </div>
      )}
    </div>
  );
}

// Compact sidebar mini-bar row for issue insights
function IssueSidebarItem({ rank, name, value, maxValue, formatValue, onClick, active }: {
  rank: number; name: string; value: number; maxValue: number; formatValue: (v: number) => string; onClick: () => void; active?: boolean;
}) {
  const pct = maxValue > 0 ? Math.max(4, (value / maxValue) * 100) : 0;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 rounded cursor-pointer transition group ${active ? 'bg-indigo-50 ring-1 ring-indigo-300' : 'hover:bg-gray-50'}`}
    >
      <div className="flex items-baseline justify-between gap-1 mb-0.5">
        <span className="text-xs text-gray-700 truncate leading-tight"><span className="text-gray-400 mr-1">{rank}.</span>{name}</span>
        <span className="text-[10px] text-gray-500 shrink-0 tabular-nums">{formatValue(value)}</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-1">
        <div className="bg-indigo-400 h-1 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </button>
  );
}

// ---------- Search Page ----------
function SearchPage({ onNavigate, initialFilter }: { onNavigate: (page: Page, ctx?: unknown) => void; initialFilter?: { registrant?: string; client?: string; lobbyist?: string; government_entity?: string; q?: string } }) {
  const [params, setParams] = useState<SearchParams>(() => ({
    sort: '-dt_posted', page: 1, page_size: 25,
    ...(initialFilter?.registrant ? { registrant: initialFilter.registrant } : {}),
    ...(initialFilter?.client ? { client: initialFilter.client } : {}),
    ...(initialFilter?.lobbyist ? { lobbyist: initialFilter.lobbyist } : {}),
    ...(initialFilter?.government_entity ? { government_entity: initialFilter.government_entity } : {}),
    ...(initialFilter?.q ? { q: initialFilter.q } : {}),
  }));
  const [results, setResults] = useState<FilingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [searchText, setSearchText] = useState(initialFilter?.q || '');
  const [issuesLoading, setIssuesLoading] = useState(true);

  // Issue filter
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);

  // Unified sidebar state — recomputes when any filter changes
  const [sidebar, setSidebar] = useState<{
    firms: Array<{ id: number; name: string; filing_count: number; total_income: number }>;
    clients: Array<{ id: number; name: string; filing_count: number; total_spending: number }>;
    lobbyists: Array<{ name: string; filing_count: number }>;
  } | null>(null);
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<{ type: 'firm' | 'client' | 'lobbyist'; id?: number; name: string } | null>(null);

  // Government entity filter state
  const [govEntities, setGovEntities] = useState<Array<{ name: string; count: number }>>([]);

  // Registrant + client typeahead lists
  const [registrantList, setRegistrantList] = useState<Array<{ id: number; name: string; filing_count: number }>>([]);
  const [clientList, setClientList] = useState<Array<{ id: number; name: string; filing_count: number }>>([]);
  const [registrantSearch, setRegistrantSearch] = useState(params.registrant || '');
  const [clientSearch, setClientSearch] = useState(params.client || '');
  const [showRegistrantDropdown, setShowRegistrantDropdown] = useState(false);
  const [showClientDropdown, setShowClientDropdown] = useState(false);

  useEffect(() => {
    api.getGovernmentEntities().then(d => setGovEntities(d.entities)).catch(() => {});
    api.getRegistrants().then(setRegistrantList).catch(() => {});
    api.getClients().then(setClientList).catch(() => {});
  }, []);

  // Re-fetch issue area counts whenever non-issue filters change
  useEffect(() => {
    setIssuesLoading(true);
    const filters: Record<string, unknown> = {};
    if (params.registrant) filters.registrant = params.registrant;
    if (params.client) filters.client = params.client;
    if (params.lobbyist) filters.lobbyist = params.lobbyist;
    if (params.government_entity) filters.government_entity = params.government_entity;
    if (params.filing_year) filters.filing_year = params.filing_year;
    if (params.filing_period) filters.filing_period = params.filing_period;
    if (params.q) filters.q = params.q;
    api.getIssues(Object.keys(filters).length > 0 ? filters as Parameters<typeof api.getIssues>[0] : undefined)
      .then(i => { setIssues(i); setIssuesLoading(false); })
      .catch(() => setIssuesLoading(false));
  }, [params.registrant, params.client, params.lobbyist, params.government_entity, params.filing_year, params.filing_period, params.q]);

  // Search filings
  const doSearch = useCallback(async (p: SearchParams) => {
    setLoading(true);
    try {
      const res = await api.searchFilings(p);
      setResults(res.results);
      setTotal(res.total);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { doSearch(params); }, [params, doSearch]);

  // Fetch sidebar whenever search-driving params change (excluding page/sort/page_size)
  useEffect(() => {
    setSidebarLoading(true);
    api.getFilingsSidebar({
      issue_code: params.issue_code,
      registrant: params.registrant,
      client: params.client,
      lobbyist: params.lobbyist,
      government_entity: params.government_entity,
      filing_year: params.filing_year,
      filing_period: params.filing_period,
      q: params.q,
    }).then(d => { setSidebar(d); setSidebarLoading(false); }).catch(() => setSidebarLoading(false));
  }, [params.issue_code, params.registrant, params.client, params.lobbyist, params.government_entity, params.filing_year, params.filing_period, params.q]);

  // When issue selection changes, update params and clear any sidebar filter
  useEffect(() => {
    setParams(p => ({ ...p, issue_code: selectedIssue || undefined, page: 1 }));
    setActiveFilter(null);
  }, [selectedIssue]);

  // When a sidebar insight filter is clicked, apply as additive filter
  useEffect(() => {
    if (!activeFilter) return;
    if (activeFilter.type === 'firm') {
      setRegistrantSearch(activeFilter.name);
      setParams(p => ({ ...p, registrant: activeFilter.name, page: 1 }));
    } else if (activeFilter.type === 'client') {
      setClientSearch(activeFilter.name);
      setParams(p => ({ ...p, client: activeFilter.name, page: 1 }));
    } else if (activeFilter.type === 'lobbyist') {
      setParams(p => ({ ...p, lobbyist: activeFilter.name, page: 1 }));
    }
  }, [activeFilter]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setParams(p => ({ ...p, q: searchText || undefined, page: 1 }));
  };

  const clearFilter = () => {
    if (!activeFilter) return;
    if (activeFilter.type === 'firm') {
      setRegistrantSearch('');
      setParams(p => ({ ...p, registrant: undefined, page: 1 }));
    } else if (activeFilter.type === 'client') {
      setClientSearch('');
      setParams(p => ({ ...p, client: undefined, page: 1 }));
    } else if (activeFilter.type === 'lobbyist') {
      setParams(p => ({ ...p, lobbyist: undefined, page: 1 }));
    }
    setActiveFilter(null);
  };
  const applyFilter = (f: typeof activeFilter) => {
    if (!f) { clearFilter(); return; }
    setActiveFilter(f);
  };

  const issueName = issues.find(i => i.code === selectedIssue)?.display;

  return (
    <div className="space-y-4">
      {/* Search bar + filters */}
      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="Search filings, clients, registrants, issues..."
              className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
          <button type="submit" className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 cursor-pointer">Search</button>
        </div>
        <div className="flex flex-wrap gap-3">
          <select
            value={params.filing_year || ''}
            onChange={e => setParams(p => ({ ...p, filing_year: e.target.value ? Number(e.target.value) : undefined, page: 1 }))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm cursor-pointer"
          >
            <option value="">All Years</option>
            {Array.from({ length: 10 }, (_, i) => new Date().getFullYear() - i).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <select
            value={params.filing_period || ''}
            onChange={e => setParams(p => ({ ...p, filing_period: e.target.value || undefined, page: 1 }))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm cursor-pointer"
          >
            <option value="">All Periods</option>
            <option value="first_quarter">Q1</option>
            <option value="second_quarter">Q2</option>
            <option value="third_quarter">Q3</option>
            <option value="fourth_quarter">Q4</option>
            <option value="mid_year">Mid-Year</option>
            <option value="year_end">Year-End</option>
          </select>
          <div className="relative">
            <input
              type="text"
              placeholder="Registrant name"
              value={registrantSearch}
              onChange={e => {
                setRegistrantSearch(e.target.value);
                setShowRegistrantDropdown(true);
                if (!e.target.value) {
                  setParams(p => ({ ...p, registrant: undefined, page: 1 }));
                  if (activeFilter?.type === 'firm') setActiveFilter(null);
                }
              }}
              onFocus={() => setShowRegistrantDropdown(true)}
              onBlur={() => setTimeout(() => setShowRegistrantDropdown(false), 200)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-44"
            />
            {showRegistrantDropdown && registrantSearch.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto z-30">
                {registrantList
                  .filter(r => r.name.toLowerCase().includes(registrantSearch.toLowerCase()))
                  .slice(0, 15)
                  .map(r => (
                    <button
                      key={r.id}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => {
                        setRegistrantSearch(r.name);
                        setShowRegistrantDropdown(false);
                        setParams(p => ({ ...p, registrant: r.name, page: 1 }));
                        if (activeFilter?.type === 'firm') setActiveFilter(null);
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 cursor-pointer flex justify-between"
                    >
                      <span className="truncate">{r.name}</span>
                      <span className="text-xs text-gray-400 ml-2 shrink-0">{r.filing_count}</span>
                    </button>
                  ))}
                {registrantList.filter(r => r.name.toLowerCase().includes(registrantSearch.toLowerCase())).length === 0 && (
                  <div className="px-3 py-2 text-xs text-gray-400">No matching registrants</div>
                )}
              </div>
            )}
            {params.registrant && (
              <button
                onClick={() => { setRegistrantSearch(''); setParams(p => ({ ...p, registrant: undefined, page: 1 })); if (activeFilter?.type === 'firm') setActiveFilter(null); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 cursor-pointer"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="relative">
            <input
              type="text"
              placeholder="Client name"
              value={clientSearch}
              onChange={e => {
                setClientSearch(e.target.value);
                setShowClientDropdown(true);
                if (!e.target.value) {
                  setParams(p => ({ ...p, client: undefined, page: 1 }));
                  if (activeFilter?.type === 'client') setActiveFilter(null);
                }
              }}
              onFocus={() => setShowClientDropdown(true)}
              onBlur={() => setTimeout(() => setShowClientDropdown(false), 200)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-44"
            />
            {showClientDropdown && clientSearch.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto z-30">
                {clientList
                  .filter(c => c.name.toLowerCase().includes(clientSearch.toLowerCase()))
                  .slice(0, 15)
                  .map(c => (
                    <button
                      key={c.id}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => {
                        setClientSearch(c.name);
                        setShowClientDropdown(false);
                        setParams(p => ({ ...p, client: c.name, page: 1 }));
                        if (activeFilter?.type === 'client') setActiveFilter(null);
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 cursor-pointer flex justify-between"
                    >
                      <span className="truncate">{c.name}</span>
                      <span className="text-xs text-gray-400 ml-2 shrink-0">{c.filing_count}</span>
                    </button>
                  ))}
                {clientList.filter(c => c.name.toLowerCase().includes(clientSearch.toLowerCase())).length === 0 && (
                  <div className="px-3 py-2 text-xs text-gray-400">No matching clients</div>
                )}
              </div>
            )}
            {params.client && (
              <button
                onClick={() => { setClientSearch(''); setParams(p => ({ ...p, client: undefined, page: 1 })); if (activeFilter?.type === 'client') setActiveFilter(null); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 cursor-pointer"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <select
            value={params.government_entity || ''}
            onChange={e => setParams(p => ({ ...p, government_entity: e.target.value || undefined, page: 1 }))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm cursor-pointer max-w-52"
          >
            <option value="">All Gov. Entities</option>
            {govEntities.map(ge => (
              <option key={ge.name} value={ge.name}>{ge.name} ({ge.count})</option>
            ))}
          </select>
        </div>
      </form>

      {/* 3-column layout: issues | filings | insights */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(200px,1fr)_minmax(0,3fr)_minmax(200px,1.2fr)] gap-4">
        {/* Left: Issue list */}
        <div className="min-w-0">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900">Issue Areas</h2>
            {selectedIssue && (
              <button onClick={() => setSelectedIssue(null)} className="text-xs text-indigo-600 hover:text-indigo-800 cursor-pointer">Clear</button>
            )}
          </div>
          {issuesLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin text-gray-300" size={20} /></div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
              {issues.length === 0 && <p className="p-4 text-sm text-gray-400">No issues found. Sync filings first.</p>}
              {issues.map(i => (
                <button
                  key={i.code}
                  onClick={() => setSelectedIssue(selectedIssue === i.code ? null : i.code)}
                  className={`w-full text-left px-4 py-2.5 text-sm flex items-center justify-between cursor-pointer transition ${selectedIssue === i.code ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  <span className="truncate">{i.display}</span>
                  <span className="text-xs text-gray-400 ml-2 shrink-0">{i.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Center: Filings */}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">
            {issueName || 'All Filings'} <span className="text-sm font-normal text-gray-400">({total} filings)</span>
          </h2>
          {/* Active filter badges */}
          {(() => {
            const badges: Array<{ label: string; value: string; onClear: () => void }> = [];
            if (selectedIssue) badges.push({ label: 'Issue', value: issueName || selectedIssue, onClear: () => setSelectedIssue(null) });
            if (params.q) badges.push({ label: 'Search', value: params.q, onClear: () => { setSearchText(''); setParams(p => ({ ...p, q: undefined, page: 1 })); } });
            if (params.registrant) badges.push({ label: 'Firm', value: params.registrant, onClear: () => { setRegistrantSearch(''); setActiveFilter(f => f?.type === 'firm' ? null : f); setParams(p => ({ ...p, registrant: undefined, page: 1 })); } });
            if (params.client) badges.push({ label: 'Client', value: params.client, onClear: () => { setClientSearch(''); setActiveFilter(f => f?.type === 'client' ? null : f); setParams(p => ({ ...p, client: undefined, page: 1 })); } });
            if (params.lobbyist) badges.push({ label: 'Lobbyist', value: params.lobbyist, onClear: () => { setActiveFilter(f => f?.type === 'lobbyist' ? null : f); setParams(p => ({ ...p, lobbyist: undefined, page: 1 })); } });
            if (params.government_entity) badges.push({ label: 'Gov. Entity', value: params.government_entity, onClear: () => setParams(p => ({ ...p, government_entity: undefined, page: 1 })) });
            if (params.filing_year) badges.push({ label: 'Year', value: String(params.filing_year), onClear: () => setParams(p => ({ ...p, filing_year: undefined, page: 1 })) });
            if (params.filing_period) badges.push({ label: 'Period', value: params.filing_period.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), onClear: () => setParams(p => ({ ...p, filing_period: undefined, page: 1 })) });
            if (badges.length === 0) return null;
            return (
              <div className="flex flex-wrap gap-2 mb-3">
                {badges.map(b => (
                  <div key={b.label} className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 rounded-lg px-2.5 py-1 text-sm">
                    <span className="text-indigo-500 text-xs">{b.label}:</span>
                    <span className="text-indigo-700 font-medium">{b.value}</span>
                    <button onClick={b.onClear} className="text-indigo-400 hover:text-indigo-600 cursor-pointer ml-0.5"><X size={12} /></button>
                  </div>
                ))}
                {badges.length > 1 && (
                  <button
                    onClick={() => { setSearchText(''); setRegistrantSearch(''); setClientSearch(''); setActiveFilter(null); setSelectedIssue(null); setParams({ sort: '-dt_posted', page: 1, page_size: 25 }); }}
                    className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer px-2 py-1"
                  >
                    Clear all
                  </button>
                )}
              </div>
            );
          })()}
          {loading ? (
            <div className="flex items-center justify-center h-32"><Loader2 className="animate-spin text-indigo-600" size={24} /></div>
          ) : results.length > 0 ? (
            <>
              <div className="space-y-3">
                {results.map(f => (
                  <FilingCard key={f.filing_uuid} filing={f} onClick={() => onNavigate('filing', f.filing_uuid)} />
                ))}
              </div>
              <Pagination page={params.page || 1} pageSize={params.page_size || 25} total={total} onPage={p => setParams(prev => ({ ...prev, page: p }))} />
            </>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <Search size={32} className="mx-auto mb-3 text-gray-300" />
              <p>No filings found. Try adjusting your filters.</p>
            </div>
          )}
        </div>

        {/* Right: Insights sidebar */}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Insights</h2>
          <div className="space-y-4">
            {sidebarLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="animate-spin text-gray-300" size={20} /></div>
            ) : sidebar ? (
              <>
                <div className="bg-white rounded-lg border border-gray-200 p-3">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><Building2 size={12} /> Top Firms</h3>
                  <div className="space-y-1">
                    {sidebar.firms.map((f, i) => (
                      <IssueSidebarItem
                        key={f.id}
                        rank={i + 1}
                        name={f.name}
                        value={f.filing_count}
                        maxValue={sidebar.firms[0]?.filing_count || 1}
                        formatValue={v => `${v} filings`}
                        active={activeFilter?.type === 'firm' && activeFilter.name === f.name}
                        onClick={() => applyFilter(activeFilter?.type === 'firm' && activeFilter.name === f.name ? null : { type: 'firm', id: f.id, name: f.name })}
                      />
                    ))}
                    {sidebar.firms.length === 0 && <p className="text-xs text-gray-400 py-1">No data</p>}
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-3">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><DollarSign size={12} /> Top Clients by Spending</h3>
                  <div className="space-y-1">
                    {sidebar.clients.map((c, i) => (
                      <IssueSidebarItem
                        key={c.id}
                        rank={i + 1}
                        name={c.name}
                        value={c.total_spending}
                        maxValue={sidebar.clients[0]?.total_spending || 1}
                        formatValue={formatMoney}
                        active={activeFilter?.type === 'client' && activeFilter.name === c.name}
                        onClick={() => applyFilter(activeFilter?.type === 'client' && activeFilter.name === c.name ? null : { type: 'client', id: c.id, name: c.name })}
                      />
                    ))}
                    {sidebar.clients.length === 0 && <p className="text-xs text-gray-400 py-1">No data</p>}
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-3">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><User size={12} /> Top Lobbyists</h3>
                  <div className="space-y-1">
                    {sidebar.lobbyists.map((l, i) => (
                      <IssueSidebarItem
                        key={l.name}
                        rank={i + 1}
                        name={l.name}
                        value={l.filing_count}
                        maxValue={sidebar.lobbyists[0]?.filing_count || 1}
                        formatValue={v => `${v} filings`}
                        active={activeFilter?.type === 'lobbyist' && activeFilter.name === l.name}
                        onClick={() => applyFilter(activeFilter?.type === 'lobbyist' && activeFilter.name === l.name ? null : { type: 'lobbyist', name: l.name })}
                      />
                    ))}
                    {sidebar.lobbyists.length === 0 && <p className="text-xs text-gray-400 py-1">No data</p>}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Filing Detail ----------
function FilingDetailPage({ filingUuid, onBack, onNavigate }: { filingUuid: string; onBack: () => void; onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [filing, setFiling] = useState<FilingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [entityMatches, setEntityMatches] = useState<Record<string, number>>({});

  useEffect(() => {
    api.getFiling(filingUuid).then(f => { setFiling(f); setLoading(false); }).catch(() => setLoading(false));
  }, [filingUuid]);

  // Look up entity matches for registrant and client names
  useEffect(() => {
    if (!filing) return;
    const names: string[] = [];
    if (filing.registrant?.name) names.push(filing.registrant.name);
    if (filing.client?.name) names.push(filing.client.name);
    names.forEach(name => {
      api.getEntities({ q: name, page_size: 1 }).then(res => {
        if (res.results.length > 0 && res.results[0].name.toLowerCase() === name.toLowerCase()) {
          setEntityMatches(prev => ({ ...prev, [name.toLowerCase()]: res.results[0].id }));
        }
      }).catch(() => {});
    });
  }, [filing]);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>;
  if (!filing) return <div className="text-center py-12 text-gray-500">Filing not found.</div>;

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-sm text-indigo-600 hover:underline flex items-center gap-1 cursor-pointer">
        <ChevronLeft size={14} /> Back to results
      </button>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              {filing.client?.name ? (
                <button onClick={() => onNavigate('search', { client: filing.client!.name })} className="hover:text-indigo-600 transition cursor-pointer">{filing.client.name}</button>
              ) : 'Unknown Client'}
              {filing.client?.name && entityMatches[filing.client.name.toLowerCase()] && (
                <button onClick={() => onNavigate('entity', entityMatches[filing.client!.name.toLowerCase()])} className="text-gray-400 hover:text-indigo-600 cursor-pointer" title="View Influence profile"><Newspaper size={14} /></button>
              )}
            </h1>
            <p className="text-gray-500 flex items-center gap-1">Filed by {filing.registrant?.name ? (
              <button onClick={() => onNavigate('search', { registrant: filing.registrant!.name })} className="hover:text-indigo-600 transition cursor-pointer">{filing.registrant.name}</button>
            ) : 'Unknown Registrant'}
              {filing.registrant?.name && entityMatches[filing.registrant.name.toLowerCase()] && (
                <button onClick={() => onNavigate('entity', entityMatches[filing.registrant!.name.toLowerCase()])} className="text-gray-400 hover:text-indigo-600 cursor-pointer" title="View Influence profile"><Newspaper size={14} /></button>
              )}
            </p>
          </div>
          <div className="text-right shrink-0">
            <span className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-sm font-medium">
              {filing.filing_type_display || filing.filing_type}
            </span>
            {filing.url && (
              <a href={filing.url} target="_blank" rel="noopener noreferrer" className="block mt-2 text-sm text-indigo-600 hover:underline flex items-center justify-end gap-1">
                View on Senate.gov <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
          <div>
            <p className="text-gray-400 text-xs uppercase">Year / Period</p>
            <p className="font-medium">{filing.filing_year} {filing.filing_period_display}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase">Date Posted</p>
            <p className="font-medium">{formatDate(filing.dt_posted)}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase" data-testid="label-added-to-db">Added to DB</p>
            <p className="font-medium" data-testid="text-added-to-db">{formatDate(filing.added_to_db)}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase">Income</p>
            <p className="font-medium text-green-700">{formatMoney(filing.income)}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase">Expenses</p>
            <p className="font-medium text-orange-700">{formatMoney(filing.expenses)}</p>
          </div>
        </div>
      </div>

      {/* Registrant & Client Detail */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filing.registrant_detail && (
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2"><Building2 size={16} /> Registrant</h3>
            <p className="text-sm font-medium flex items-center gap-1">
              <button onClick={() => onNavigate('search', { registrant: filing.registrant_detail!.name })} className="hover:text-indigo-600 transition cursor-pointer">{filing.registrant_detail.name}</button>
              {entityMatches[filing.registrant_detail.name.toLowerCase()] && (
                <button onClick={() => onNavigate('entity', entityMatches[filing.registrant_detail!.name.toLowerCase()])} className="text-gray-400 hover:text-indigo-600 cursor-pointer" title="View Influence profile"><Newspaper size={14} /></button>
              )}
            </p>
            {filing.registrant_detail.description && <p className="text-sm text-gray-500 mt-1">{filing.registrant_detail.description}</p>}
            {filing.registrant_detail.address && <p className="text-xs text-gray-400 mt-1">{filing.registrant_detail.address}</p>}
            {(filing.registrant_detail.state || filing.registrant_detail.country) && (
              <p className="text-xs text-gray-400">{[filing.registrant_detail.state, filing.registrant_detail.country].filter(Boolean).join(', ')}</p>
            )}
          </div>
        )}
        {filing.client_detail && (
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2"><Users size={16} /> Client</h3>
            <p className="text-sm font-medium flex items-center gap-1">
              <button onClick={() => onNavigate('search', { client: filing.client_detail!.name })} className="hover:text-indigo-600 transition cursor-pointer">{filing.client_detail.name}</button>
              {entityMatches[filing.client_detail.name.toLowerCase()] && (
                <button onClick={() => onNavigate('entity', entityMatches[filing.client_detail!.name.toLowerCase()])} className="text-gray-400 hover:text-indigo-600 cursor-pointer" title="View Influence profile"><Newspaper size={14} /></button>
              )}
            </p>
            {filing.client_detail.description && <p className="text-sm text-gray-500 mt-1">{filing.client_detail.description}</p>}
            {(filing.client_detail.state || filing.client_detail.country) && (
              <p className="text-xs text-gray-400">{[filing.client_detail.state, filing.client_detail.country].filter(Boolean).join(', ')}</p>
            )}
          </div>
        )}
      </div>

      {/* Lobbying Activities */}
      {filing.lobbying_activities && filing.lobbying_activities.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Lobbying Activities</h2>
          <div className="space-y-4">
            {filing.lobbying_activities.map((act, i) => (
              <div key={i} className="bg-white rounded-lg border border-gray-200 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded text-xs font-medium">
                    {act.general_issue_code}
                  </span>
                  <span className="text-sm font-medium text-gray-900">{act.general_issue_code_display}</span>
                </div>
                {act.description && (
                  <p className="text-sm text-gray-700 mb-2">{act.description}</p>
                )}
                {act.specific_issues && (
                  <div className="mb-2">
                    <p className="text-xs text-gray-400 uppercase mb-1">Specific Issues</p>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{act.specific_issues}</p>
                  </div>
                )}
                {act.government_entities && act.government_entities.length > 0 && (
                  <div className="mb-2">
                    <p className="text-xs text-gray-400 uppercase mb-1">Government Entities Contacted</p>
                    <div className="flex flex-wrap gap-1">
                      {act.government_entities.map((e, j) => (
                        <span key={j} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                          {typeof e === 'string' ? e : e.name || JSON.stringify(e)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {act.lobbyists && act.lobbyists.length > 0 && (
                  <div>
                    <p className="text-xs text-gray-400 uppercase mb-1">Lobbyists</p>
                    <div className="space-y-1">
                      {act.lobbyists.map((l, j) => {
                        if (typeof l === 'string') return <p key={j} className="text-sm text-gray-700">{l}</p>;
                        const name = l.lobbyist ? `${l.lobbyist.first_name || ''} ${l.lobbyist.last_name || ''}`.trim() : '';
                        return (
                          <div key={j} className="text-sm text-gray-700 flex items-center gap-1">
                            <button onClick={() => onNavigate('search', { lobbyist: name })} className="hover:text-indigo-600 transition cursor-pointer text-left">{name}</button>
                            {l.covered_position ? <span className="text-gray-400 shrink-0">({l.covered_position})</span> : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Influence Page ----------
function InfluencePage({ onNavigate }: { onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [stats, setStats] = useState<InfluenceStats | null>(null);
  const [newsletters, setNewsletters] = useState<NewsletterSummary[]>([]);
  const [topEntities, setTopEntities] = useState<EntitySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPageNum] = useState(1);
  const [loading, setLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<{ entities: EntitySummary[]; newsletters: NewsletterSummary[]; entityTotal: number; newsletterTotal: number } | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, n, e] = await Promise.all([
        api.getInfluenceStats(),
        api.getNewsletters(page),
        api.getEntities({ sort: '-mention_count', page_size: 15 }),
      ]);
      setStats(s);
      setNewsletters(n.results);
      setTotal(n.total);
      setTopEntities(e.results);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const handleSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSearchResults(null);
      setSearchQuery('');
      return;
    }
    setSearching(true);
    setSearchQuery(q.trim());
    try {
      const [entities, nls] = await Promise.all([
        api.getEntities({ q: q.trim(), sort: '-mention_count', page_size: 20 }),
        api.getNewsletters(1, 10, q.trim()),
      ]);
      setSearchResults({
        entities: entities.results,
        newsletters: nls.results,
        entityTotal: entities.total,
        newsletterTotal: nls.total,
      });
    } catch (err) {
      console.error(err);
    }
    setSearching(false);
  }, []);

  const clearSearch = () => {
    setSearchInput('');
    setSearchQuery('');
    setSearchResults(null);
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Politico Influence</h1>
            <p className="text-sm text-gray-500">
              {stats?.total_newsletters ? `${stats.total_newsletters} newsletters scraped` : 'No newsletters yet'}
              {stats?.latest_newsletter && ` · Latest: ${formatDate(stats.latest_newsletter)}`}
            </p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <form onSubmit={e => { e.preventDefault(); handleSearch(searchInput); }} className="flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search entities and newsletters..."
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              data-testid="input-influence-search"
            />
          </div>
          <button
            type="submit"
            disabled={searching}
            className="bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 cursor-pointer"
            data-testid="button-influence-search"
          >
            {searching ? <Loader2 size={16} className="animate-spin" /> : 'Search'}
          </button>
          {searchResults && (
            <button
              type="button"
              onClick={clearSearch}
              className="text-gray-500 hover:text-gray-700 px-2 cursor-pointer"
              data-testid="button-influence-search-clear"
            >
              <X size={16} />
            </button>
          )}
        </form>
      </div>

      {/* Search Results */}
      {searchResults && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              Results for "{searchQuery}"
            </h2>
            <span className="text-sm text-gray-500">
              {searchResults.entityTotal} entities, {searchResults.newsletterTotal} newsletters
            </span>
          </div>

          {searchResults.entities.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Entities ({searchResults.entityTotal})</h3>
              <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
                {searchResults.entities.map(e => (
                  <button
                    key={e.id}
                    onClick={() => onNavigate('entity', e.id)}
                    className="w-full text-left px-4 py-2.5 text-sm flex items-center justify-between cursor-pointer hover:bg-gray-50 transition"
                    data-testid={`search-result-entity-${e.id}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {e.entity_type === 'person' ? <User size={14} className="text-indigo-500 shrink-0" /> :
                       e.entity_type === 'organization' ? <Briefcase size={14} className="text-amber-500 shrink-0" /> :
                       <Tag size={14} className="text-gray-400 shrink-0" />}
                      <span className="truncate">{e.display_name || e.name}</span>
                      <span className="text-xs text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 shrink-0">{e.entity_type}</span>
                      {e.is_consultant && <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0 text-blue-700 bg-blue-50">Consultant</span>}
                      {e.is_client && <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0 text-emerald-700 bg-emerald-50">Client</span>}
                    </div>
                    <span className="text-xs text-gray-400 shrink-0 ml-2">{e.mention_count} mentions</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {searchResults.newsletters.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Newsletters ({searchResults.newsletterTotal})</h3>
              <div className="space-y-2">
                {searchResults.newsletters.map(nl => (
                  <button
                    key={nl.id}
                    onClick={() => onNavigate('newsletter', nl.id)}
                    className="w-full text-left bg-white rounded-lg border border-gray-200 px-4 py-3 hover:shadow-md transition cursor-pointer"
                    data-testid={`search-result-newsletter-${nl.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-semibold text-gray-900 text-sm">{nl.title}</h3>
                      <span className="text-xs text-gray-400 shrink-0">{formatDate(nl.published_date)}</span>
                    </div>
                    <p className="text-xs text-gray-500 line-clamp-1 mt-1">{nl.body_preview}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {searchResults.entities.length === 0 && searchResults.newsletters.length === 0 && (
            <div className="text-center py-8 bg-white rounded-lg border border-gray-200">
              <Search size={32} className="mx-auto text-gray-300 mb-2" />
              <p className="text-gray-500 text-sm">No results found for "{searchQuery}"</p>
            </div>
          )}
        </div>
      )}

      {/* Stats */}
      {stats && stats.total_entities > 0 && !searchResults && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-2xl font-bold text-amber-600">{stats.total_entities.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Entities</p>
          </div>
          <button
            onClick={() => onNavigate('leaderboard', 'person')}
            className="bg-white rounded-lg border border-gray-200 p-4 text-left hover:bg-indigo-50 hover:border-indigo-200 transition cursor-pointer"
            data-testid="button-people-leaderboard"
          >
            <p className="text-2xl font-bold text-indigo-600">{stats.total_persons.toLocaleString()}</p>
            <p className="text-sm text-gray-500">People</p>
          </button>
          <button
            onClick={() => onNavigate('leaderboard', 'organization')}
            className="bg-white rounded-lg border border-gray-200 p-4 text-left hover:bg-amber-50 hover:border-amber-200 transition cursor-pointer"
            data-testid="button-org-leaderboard"
          >
            <p className="text-2xl font-bold text-amber-600">{stats.total_organizations.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Organizations</p>
          </button>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-2xl font-bold text-green-600">{stats.total_relationships.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Relationships</p>
          </div>
        </div>
      )}

      {!searchResults && <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Newsletter list */}
        <div className="md:col-span-2">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Newsletters</h2>
          {newsletters.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
              <Newspaper size={40} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No newsletters scraped yet. Click "Scrape Newsletters" to start.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {newsletters.map(nl => (
                <button
                  key={nl.id}
                  onClick={() => onNavigate('newsletter', nl.id)}
                  data-testid={`card-newsletter-${nl.id}`}
                  className="w-full text-left bg-white rounded-lg border border-gray-200 px-4 py-3 hover:shadow-md transition cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-gray-900 text-sm">{nl.title}</h3>
                    <span className="text-xs text-gray-400 shrink-0">{formatDate(nl.published_date)}</span>
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-1 mt-1">{nl.body_preview}</p>
                </button>
              ))}
              <Pagination page={page} pageSize={25} total={total} onPage={setPageNum} />
            </div>
          )}
        </div>

        {/* Top entities sidebar */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900">Top Entities</h2>
            <button onClick={() => onNavigate('network')} className="text-sm text-indigo-600 hover:underline cursor-pointer">View network</button>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {topEntities.length === 0 && <p className="p-4 text-sm text-gray-400">No entities found yet.</p>}
            {topEntities.map(e => (
              <button
                key={e.id}
                onClick={() => onNavigate('entity', e.id)}
                className="w-full text-left px-4 py-2.5 text-sm flex items-center justify-between cursor-pointer hover:bg-gray-50 transition"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {e.entity_type === 'person' ? <User size={14} className="text-indigo-500 shrink-0" /> :
                   e.entity_type === 'organization' ? <Briefcase size={14} className="text-amber-500 shrink-0" /> :
                   <Tag size={14} className="text-gray-400 shrink-0" />}
                  <span className="truncate">{e.display_name || e.name}</span>
                  {e.is_consultant && <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0 text-blue-700 bg-blue-50">Consultant</span>}
                  {e.is_client && <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0 text-emerald-700 bg-emerald-50">Client</span>}
                </div>
                <span className="text-xs text-gray-400 shrink-0 ml-2">{e.mention_count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>}

      {/* Empty state */}
      {(!stats || stats.total_newsletters === 0) && !searchResults && (
        <div className="text-center py-12">
          <Network size={48} className="mx-auto text-gray-300 mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">Build Your DC Network Map</h2>
          <p className="text-gray-500 max-w-lg mx-auto">
            Scrape Politico Influence newsletters to automatically extract entities (people, organizations) and map their relationships based on co-mentions.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- Network Map Page ----------
function NetworkMapPage({ onNavigate, centerEntityId }: { onNavigate: (page: Page, ctx?: unknown) => void; centerEntityId?: number }) {
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [minWeight, setMinWeight] = useState(centerEntityId ? 1 : 2);
  const [maxNodes, setMaxNodes] = useState(80);
  const [entityType, setEntityType] = useState('');
  const [sizeBy, setSizeBy] = useState<SizeMode>('centrality');
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const centralityScores = useMemo(() => {
    if (!network || network.nodes.length === 0) return new Map<number, number>();
    return computeEigenvectorCentrality(network.nodes, network.edges);
  }, [network]);

  const topByCentrality = useMemo(() => {
    if (centralityScores.size === 0 || !network) return [];
    return [...centralityScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([id, score]) => {
        const node = network.nodes.find(n => n.id === id);
        return { id, score, name: node?.name ?? '', entity_type: node?.entity_type ?? 'unknown' };
      });
  }, [centralityScores, network]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const { width } = entries[0].contentRect;
      setDimensions({ width: Math.max(280, width), height: Math.max(300, Math.min(700, window.innerHeight - 250)) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadNetwork = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getNetwork({
        min_weight: minWeight,
        max_nodes: maxNodes,
        entity_type: entityType || undefined,
        center_entity_id: centerEntityId,
        depth: centerEntityId ? 2 : undefined,
      });
      setNetwork(data);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [minWeight, maxNodes, entityType, centerEntityId]);

  useEffect(() => { loadNetwork(); }, [loadNetwork]);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3 sm:gap-4">
        <h1 className="text-lg font-semibold text-gray-900 w-full sm:w-auto sm:mr-auto">DC Network Map</h1>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <label className="text-gray-500 shrink-0">Min connections:</label>
          <input
            type="range"
            min={1}
            max={10}
            value={minWeight}
            onChange={e => setMinWeight(Number(e.target.value))}
            className="w-20 sm:w-24"
          />
          <span className="text-gray-700 w-4">{minWeight}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-gray-500 shrink-0">Max nodes:</label>
          <select
            value={maxNodes}
            onChange={e => setMaxNodes(Number(e.target.value))}
            className="border border-gray-300 rounded px-2 py-1 text-sm cursor-pointer"
          >
            <option value={30}>30</option>
            <option value={50}>50</option>
            <option value={80}>80</option>
            <option value={120}>120</option>
            <option value={200}>200</option>
          </select>
        </div>
        <select
          value={entityType}
          onChange={e => setEntityType(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm cursor-pointer"
        >
          <option value="">All types</option>
          <option value="person">People</option>
          <option value="organization">Organizations</option>
        </select>
        <button
          onClick={() => setSizeBy(s => s === 'mentions' ? 'centrality' : 'mentions')}
          className={`flex items-center gap-1 text-sm px-3 py-1 rounded border cursor-pointer transition ${
            sizeBy === 'centrality'
              ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
          }`}
          title="Toggle node sizing between mention count and eigenvector centrality"
        >
          <Target size={14} />
          <span className="hidden sm:inline">{sizeBy === 'centrality' ? 'Centrality' : 'Mentions'}</span>
        </button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 px-1">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-indigo-500 inline-block"></span> Person</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-amber-500 inline-block"></span> Organization</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-slate-400 inline-block"></span> Unknown type</span>
        <span className="flex items-center gap-1"><span className="w-6 border-t-2 border-amber-400 inline-block"></span> Affiliation</span>
        <span className="flex items-center gap-1"><span className="w-6 border-t-2 border-green-400 inline-block"></span> Registration</span>
        <span className="flex items-center gap-1"><span className="w-6 border-t border-slate-300 inline-block"></span> Co-mention</span>
        <span className="hidden sm:inline ml-auto text-gray-400">Scroll to zoom · Drag nodes to rearrange · Click for details</span>
      </div>

      <div ref={containerRef} className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-96 bg-white rounded-lg border border-gray-200">
            <Loader2 className="animate-spin text-indigo-600" size={32} />
          </div>
        ) : network && network.nodes.length > 0 ? (
          <NetworkGraph
            data={network}
            width={dimensions.width}
            height={dimensions.height}
            onNodeClick={id => onNavigate('entity', id)}
            sizeBy={sizeBy}
            centralityScores={centralityScores}
          />
        ) : (
          <div className="flex items-center justify-center h-96 bg-white rounded-lg border border-gray-200 text-gray-400">
            <div className="text-center">
              <Network size={40} className="mx-auto mb-3 text-gray-300" />
              <p>No network data yet. Scrape some newsletters first, or lower the minimum connections filter.</p>
            </div>
          </div>
        )}
      </div>

      {network && (
        <p className="text-xs text-gray-400 text-center">
          Showing {network.nodes.length} entities and {network.edges.length} relationships
        </p>
      )}

      {topByCentrality.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-1.5">
            <Target size={14} className="text-indigo-500" />
            Top Entities by Eigenvector Centrality
          </h2>
          <div className="divide-y divide-gray-100">
            {topByCentrality.map((entry, i) => (
              <button
                key={entry.id}
                onClick={() => onNavigate('entity', entry.id)}
                className="w-full text-left flex items-center gap-3 py-1.5 hover:bg-gray-50 cursor-pointer transition px-1 rounded"
              >
                <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}.</span>
                {entry.entity_type === 'person'
                  ? <User size={13} className="text-indigo-500 shrink-0" />
                  : <Briefcase size={13} className="text-amber-500 shrink-0" />}
                <span className="text-sm text-gray-800 truncate min-w-0">{entry.name}</span>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 rounded-full"
                      style={{ width: `${Math.round(entry.score * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 w-10 text-right">{(entry.score * 100).toFixed(0)}%</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Entity Detail Page ----------
function EntityDetailPage({ entityId, onBack, onNavigate }: { entityId: number; onBack: () => void; onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [entity, setEntity] = useState<EntityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatingType, setUpdatingType] = useState(false);
  const [ldaStats, setLdaStats] = useState<EntityLdaStats | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatConvoId, setChatConvoId] = useState<number | undefined>();
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { api.getAiStatus().then(s => setAiAvailable(s.available)).catch(() => {}); }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  const handleChatSend = async () => {
    const text = chatInput.trim();
    if (!text || chatSending) return;
    setChatInput('');
    setChatSending(true);
    setChatMessages(prev => [...prev, { role: 'user', content: text }]);
    try {
      const result = await api.aiChat(text, chatConvoId, entityId);
      setChatConvoId(result.conversation_id);
      setChatMessages(prev => [...prev, { role: 'assistant', content: result.response }]);
    } catch (err: unknown) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}` }]);
    }
    setChatSending(false);
  };

  const loadEntity = useCallback(() => {
    setLoading(true);
    api.getEntity(entityId).then(e => { setEntity(e); setLoading(false); }).catch(() => setLoading(false));
    api.getEntityLdaStats(entityId).then(setLdaStats).catch(() => setLdaStats(null));
  }, [entityId]);

  useEffect(() => { loadEntity(); }, [loadEntity]);

  const handleTypeChange = async (newType: string) => {
    if (!entity || newType === entity.entity_type) return;
    setUpdatingType(true);
    try {
      await api.updateEntityType(entity.id, newType);
      loadEntity();
    } catch (err) {
      console.error(err);
    }
    setUpdatingType(false);
  };

  const generateSummary = async () => {
    if (!entity) return;
    setAiLoading(true);
    setAiError(null);
    setAiSummary(null);
    try {
      const result = await api.getEntitySummary(entity.id);
      setAiSummary(result.summary);
      // Reset follow-up chat for new summary
      setChatOpen(false);
      setChatMessages([]);
      setChatConvoId(undefined);
      setChatInput('');
    } catch (err: unknown) {
      setAiError(err instanceof Error ? err.message : 'Failed to generate summary');
    }
    setAiLoading(false);
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>;
  if (!entity) return <div className="text-center py-12 text-gray-500">Entity not found.</div>;

  const affiliations = entity.connections.filter(c => c.relationship_type === 'affiliation');
  const registrations = entity.connections.filter(c => c.relationship_type === 'lobbying_registration' || c.relationship_type === 'lobbying_termination');
  const coMentions = entity.connections.filter(c => !['affiliation', 'lobbying_registration', 'lobbying_termination'].includes(c.relationship_type));

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-sm text-indigo-600 hover:underline flex items-center gap-1 cursor-pointer">
        <ChevronLeft size={14} /> Back
      </button>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 min-w-0">
              {entity.entity_type === 'person' ? <User size={20} className="text-indigo-500 shrink-0" /> :
               entity.entity_type === 'organization' ? <Briefcase size={20} className="text-amber-500 shrink-0" /> :
               <Tag size={20} className="text-gray-400 shrink-0" />}
              <h1 className="text-xl font-bold text-gray-900 break-words">{entity.display_name || entity.name}</h1>
            </div>
            <div className="text-sm text-gray-500">
              <span>{entity.mention_count} mentions · First seen {formatDate(entity.first_seen)} · Last seen {formatDate(entity.last_seen)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span className="text-xs text-gray-400">Type:</span>
              <select
                value={entity.entity_type}
                onChange={(e) => handleTypeChange(e.target.value)}
                disabled={updatingType}
                data-testid="select-entity-type"
                className="text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-300"
              >
                <option value="person">Person</option>
                <option value="organization">Organization</option>
                <option value="unknown">Unknown</option>
              </select>
              {updatingType && <Loader2 size={12} className="animate-spin text-gray-400" />}
              {entity.is_consultant && <span className="text-xs px-2 py-0.5 rounded-full text-blue-700 bg-blue-50">Consultant</span>}
              {entity.is_client && <span className="text-xs px-2 py-0.5 rounded-full text-emerald-700 bg-emerald-50">Client</span>}
              {entity.is_lobbyist && <span className="text-xs px-2 py-0.5 rounded-full text-purple-700 bg-purple-50">Registered Lobbyist</span>}
            </div>
          </div>
          <div className="flex gap-2 shrink-0 self-start">
            {aiAvailable && (
              <button
                onClick={generateSummary}
                disabled={aiLoading}
                className="text-sm text-purple-600 border border-purple-200 px-3 py-1.5 rounded-lg hover:bg-purple-50 cursor-pointer flex items-center gap-1 disabled:opacity-50"
              >
                {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {aiLoading ? 'Analyzing...' : 'AI Summary'}
              </button>
            )}
            <button
              onClick={() => onNavigate('network', entity.id)}
              className="text-sm text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-50 cursor-pointer flex items-center gap-1"
            >
              <Network size={14} /> View in network
            </button>
          </div>
        </div>
      </div>

      {/* AI Summary */}
      {(aiSummary || aiLoading || aiError) && (
        <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-lg border border-purple-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={16} className="text-purple-600" />
            <h2 className="text-sm font-semibold text-purple-900">AI Intelligence Brief</h2>
          </div>
          {aiLoading && (
            <div className="flex items-center gap-2 text-sm text-purple-600">
              <Loader2 size={14} className="animate-spin" /> Analyzing entity data, network connections, and filing history...
            </div>
          )}
          {aiError && (
            <p className="text-sm text-red-600">{aiError}</p>
          )}
          {aiSummary && (
            <div className="prose prose-sm max-w-none text-gray-800">
              {aiSummary.split('\n').map((line, i) => {
                if (!line.trim()) return <br key={i} />;
                if (line.startsWith('## ')) return <h3 key={i} className="text-sm font-bold text-gray-900 mt-3 mb-1">{line.slice(3)}</h3>;
                if (line.startsWith('### ')) return <h4 key={i} className="text-sm font-semibold text-gray-900 mt-2 mb-1">{line.slice(4)}</h4>;
                if (line.startsWith('**') && line.endsWith('**')) return <p key={i} className="text-sm font-semibold text-gray-900 mt-2 mb-1">{line.slice(2, -2)}</p>;
                if (line.startsWith('- ')) return <li key={i} className="text-sm text-gray-700 ml-4">{line.slice(2)}</li>;
                return <p key={i} className="text-sm text-gray-700 mb-1">{line}</p>;
              })}
            </div>
          )}

          {/* Follow-up chat after summary */}
          {aiSummary && aiAvailable && (
            <div className="mt-4 border-t border-purple-200 pt-4">
              {!chatOpen ? (
                <button
                  onClick={() => setChatOpen(true)}
                  className="text-sm text-purple-600 hover:text-purple-800 cursor-pointer flex items-center gap-1.5"
                >
                  <MessageCircle size={14} /> Ask follow-up questions about {entity.display_name || entity.name}
                </button>
              ) : (
                <>
                  <div className="max-h-64 overflow-y-auto space-y-2 mb-3">
                    {chatMessages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] rounded-lg px-3 py-2 ${
                          m.role === 'user'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-white border border-gray-200 text-gray-800'
                        }`}>
                          <p className="text-sm">{m.content}</p>
                        </div>
                      </div>
                    ))}
                    {chatSending && (
                      <div className="flex justify-start">
                        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2">
                          <div className="flex items-center gap-2 text-sm text-gray-500">
                            <Loader2 size={14} className="animate-spin" /> Thinking...
                          </div>
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend(); } }}
                      placeholder={`Ask about ${entity.display_name || entity.name}...`}
                      className="flex-1 text-sm border border-purple-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-300"
                      disabled={chatSending}
                    />
                    <button
                      onClick={handleChatSend}
                      disabled={!chatInput.trim() || chatSending}
                      className="bg-purple-600 text-white px-3 py-2 rounded-lg hover:bg-purple-700 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      <Send size={14} />
                    </button>
                  </div>
                  {chatConvoId && (
                    <button
                      onClick={() => onNavigate('chat', chatConvoId)}
                      className="mt-2 text-xs text-purple-500 hover:text-purple-700 cursor-pointer flex items-center gap-1"
                    >
                      <ExternalLink size={12} /> Continue in AI Chat
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* LDA Stats for consultants/registrants */}
      {ldaStats?.has_lda_data && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">LDA Overview{ldaStats.registrant_name ? ` — ${ldaStats.registrant_name}` : ''}</h2>

          {/* Key metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xl font-bold text-indigo-700">#{ldaStats.rank?.toLocaleString()}</p>
              <p className="text-xs text-gray-500">Rank of {ldaStats.total_registrants?.toLocaleString()}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xl font-bold text-indigo-700">{ldaStats.filing_count?.toLocaleString()}</p>
              <p className="text-xs text-gray-500">Total Filings</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xl font-bold text-indigo-700">{formatMoney(ldaStats.total_revenue)}</p>
              <p className="text-xs text-gray-500">Total Revenue</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xl font-bold text-indigo-700">{ldaStats.unique_clients?.toLocaleString()}</p>
              <p className="text-xs text-gray-500">Unique Clients</p>
            </div>
          </div>

          {/* Issue area breakdown */}
          {ldaStats.issues && ldaStats.issues.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Issue Areas</h3>
              <div className="space-y-1.5">
                {ldaStats.issues.map(iss => (
                  <div key={iss.issue} className="flex items-center gap-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-gray-700 truncate text-xs">{iss.issue}</span>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <span className="text-xs text-gray-500">{iss.pct}%</span>
                          {iss.overindex > 1.5 ? (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-50 text-green-700">{iss.overindex}x</span>
                          ) : iss.overindex < 0.5 && iss.overindex > 0 ? (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">{iss.overindex}x</span>
                          ) : (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-50 text-gray-500">{iss.overindex}x</span>
                          )}
                        </div>
                      </div>
                      <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${Math.min(iss.pct, 100)}%` }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">Overindex: firm's % vs. average across all registrants. {'>'}1.5x = strong specialization.</p>
            </div>
          )}
        </div>
      )}

      {/* Affiliations */}
      {affiliations.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Affiliations</h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {affiliations.map(c => {
              // Extract covered positions from context snippets
              const coveredPositions = c.context_snippets
                .filter(s => s.includes('Covered position:'))
                .map(s => s.split('Covered position:')[1]?.trim())
                .filter(Boolean);
              return (
                <div key={c.entity.id} className="px-4 py-2 hover:bg-gray-50 transition">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      onClick={() => onNavigate('entity', c.entity.id)}
                      className="flex items-center gap-2 cursor-pointer min-w-0 flex-wrap"
                    >
                      {c.entity.entity_type === 'person' ? <User size={14} className="text-indigo-500 shrink-0" /> : <Briefcase size={14} className="text-amber-500 shrink-0" />}
                      <span className="text-sm font-medium text-gray-900 text-left break-words">{c.entity.display_name || c.entity.name}</span>
                      {c.entity.is_lobbyist && <span className="text-xs px-1.5 py-0.5 rounded-full text-purple-700 bg-purple-50 shrink-0">Lobbyist</span>}
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      {c.match_confidence && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full whitespace-nowrap ${c.match_confidence === 'high' ? 'text-green-700 bg-green-50' : 'text-yellow-700 bg-yellow-50'}`}>
                          {c.match_confidence === 'high' ? 'High match' : 'Low match'}
                        </span>
                      )}
                      <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">{c.weight}x</span>
                    </div>
                  </div>
                  {coveredPositions.length > 0 && (
                    <div className="mt-1 ml-6">
                      {coveredPositions.map((pos, i) => (
                        <p key={i} className="text-xs text-gray-500 italic">{pos}</p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Lobbying Registrations */}
      {registrations.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Lobbying Registrations</h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {registrations.map(c => (
              <div key={c.entity.id} className="px-4 py-2 hover:bg-gray-50 transition flex items-center justify-between gap-2">
                <button
                  onClick={() => onNavigate('entity', c.entity.id)}
                  className="flex items-center gap-2 cursor-pointer min-w-0"
                >
                  <Briefcase size={14} className="text-green-500 shrink-0" />
                  <span className="text-sm font-medium text-gray-900 truncate">{c.entity.display_name || c.entity.name}</span>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  {c.filing_uuid && (
                    <button
                      onClick={() => onNavigate('filing', c.filing_uuid)}
                      className="text-xs text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded hover:bg-indigo-50 cursor-pointer flex items-center gap-1"
                    >
                      <FileText size={10} /> View Filing
                    </button>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${c.relationship_type === 'lobbying_termination' ? 'text-red-600 bg-red-50' : 'text-green-600 bg-green-50'}`}>
                    {c.relationship_type === 'lobbying_termination' ? 'Terminated' : 'Registered'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {coMentions.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Co-mentioned With</h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {coMentions.map(c => (
              <button
                key={c.entity.id}
                onClick={() => onNavigate('entity', c.entity.id)}
                className="w-full text-left px-4 py-2 hover:bg-gray-50 cursor-pointer transition flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  {c.entity.entity_type === 'person' ? <User size={14} className="text-indigo-500" /> :
                   c.entity.entity_type === 'organization' ? <Briefcase size={14} className="text-amber-500" /> :
                   <Tag size={14} className="text-gray-400" />}
                  <span className="text-sm font-medium text-gray-900">{c.entity.name}</span>
                </div>
                <span className="text-xs text-gray-500">{c.weight}x</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Newsletter appearances */}
      {entity.newsletter_mentions.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Newsletter Appearances</h2>
          <div className="space-y-2">
            {entity.newsletter_mentions.map((m, i) => (
              <button
                key={i}
                onClick={() => onNavigate('newsletter', m.newsletter_id)}
                data-testid={`link-newsletter-mention-${m.newsletter_id}`}
                className="w-full text-left bg-white rounded-lg border border-gray-200 p-3 hover:shadow-md transition cursor-pointer"
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-900 break-words min-w-0">{m.newsletter_title}</span>
                  <span className="text-xs text-gray-400 shrink-0">{formatDate(m.published_date)}</span>
                </div>
                <p className="text-xs text-gray-600 line-clamp-2">{m.context}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* LDA Filings */}
      {entity.lda_filings && entity.lda_filings.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">LDA Filings</h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {entity.lda_filings.map((f) => (
              <button
                key={f.filing_uuid}
                onClick={() => onNavigate('filing', f.filing_uuid)}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 cursor-pointer transition"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText size={14} className="text-indigo-500 shrink-0" />
                    <span className="text-sm font-medium text-gray-900 truncate">{f.filing_type_display}</span>
                    <span className="text-xs text-gray-400">{f.filing_year} {f.filing_period_display}</span>
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">{f.dt_posted ? new Date(f.dt_posted).toLocaleDateString() : ''}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  {f.registrant_name && <span>Registrant: {f.registrant_name}</span>}
                  {f.client_name && <span>Client: {f.client_name}</span>}
                  {f.income != null && f.income > 0 && (
                    <span className="text-green-600">${f.income.toLocaleString()}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Newsletter Reader Page ----------
function NewsletterReaderPage({ newsletterId, onBack, onNavigate }: { newsletterId: number; onBack: () => void; onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [newsletter, setNewsletter] = useState<NewsletterDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getNewsletter(newsletterId)
      .then(setNewsletter)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [newsletterId]);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>;
  if (!newsletter) return <div className="text-center py-12 text-gray-500">Newsletter not found.</div>;

  const entityMap = new Map<string, { id: number; entity_type: string; display_name: string }>();
  for (const e of newsletter.entities) {
    const key = e.name.toLowerCase();
    if (!entityMap.has(key)) {
      entityMap.set(key, { id: e.id, entity_type: e.entity_type, display_name: e.display_name });
    }
  }

  const sortedNames = Array.from(entityMap.keys()).sort((a, b) => b.length - a.length);

  const annotateText = (text: string) => {
    if (sortedNames.length === 0) return [text];

    const escapedNames = sortedNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(?<!\\w)(${escapedNames.join('|')})(?!\\w)`, 'gi');
    const parts = text.split(regex);

    return parts.map((part, i) => {
      const match = entityMap.get(part.toLowerCase());
      if (match) {
        const colorClass = match.entity_type === 'person'
          ? 'bg-indigo-100 text-indigo-800 border-indigo-200 hover:bg-indigo-200'
          : match.entity_type === 'organization'
          ? 'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-200'
          : 'bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-200';
        const IconComponent = match.entity_type === 'person' ? User : match.entity_type === 'organization' ? Briefcase : Tag;
        return (
          <span
            key={i}
            role="button"
            tabIndex={0}
            onClick={(ev) => { ev.stopPropagation(); onNavigate('entity', match.id); }}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onNavigate('entity', match.id); } }}
            data-testid={`badge-entity-${match.id}`}
            className={`inline-flex items-center gap-0.5 px-1 py-0 rounded border text-xs font-medium cursor-pointer transition align-baseline ${colorClass}`}
            style={{ lineHeight: 'inherit' }}
            title={`${match.display_name} (${match.entity_type})`}
          >
            <IconComponent size={9} className="inline" />
            {part}
          </span>
        );
      }
      return part;
    });
  };

  const knownSectionHeadings = ['jobs report', 'new joint fundraisers', 'new pacs', 'new lobbying registrations', 'new lobbying terminations'];
  const firstInPiRe = /^(FIRST IN PI(?:\s*I+)?(?:\s*(?:\u2014|\u2013|[\-–—])\s*[^:]+)?)\s*:\s*/;
  const sectionHeadingRe = /^([A-Z][A-Z\s'\u2019&,\-]+(?::|(?=\s?\u2014)))\s*\u2014?\s*/;
  const adStartRe = /^A message from\b/i;

  const paragraphs = newsletter.body_text.split('\n\n').filter(p => p.trim().length > 0);

  const isHeadingLike = (text: string) => {
    const t = text.trim();
    if (knownSectionHeadings.includes(t.toLowerCase())) return true;
    if (firstInPiRe.test(t)) return true;
    if (sectionHeadingRe.test(t)) return true;
    return false;
  };

  const adBlocks = new Set<number>();
  for (let i = 0; i < paragraphs.length; i++) {
    if (adStartRe.test(paragraphs[i].trim())) {
      adBlocks.add(i);
      for (let j = i + 1; j < paragraphs.length; j++) {
        if (isHeadingLike(paragraphs[j])) break;
        adBlocks.add(j);
      }
    }
  }

  const renderParagraph = (para: string, i: number) => {
    if (knownSectionHeadings.includes(para.trim().toLowerCase())) {
      return (
        <div key={i} data-testid={`text-paragraph-${i}`}>
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide mt-5 mb-1 pt-3 border-t border-gray-100">{para.trim()}</h3>
        </div>
      );
    }
    const piMatch = para.match(firstInPiRe);
    if (piMatch) {
      const heading = piMatch[1].trim();
      const rest = para.slice(piMatch[0].length).trim();
      return (
        <div key={i} data-testid={`text-paragraph-${i}`}>
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide mt-5 mb-1 pt-3 border-t border-gray-100">{heading}</h3>
          {rest && <p className="text-gray-800 leading-relaxed text-sm">{annotateText(rest)}</p>}
        </div>
      );
    }
    const headingMatch = para.match(sectionHeadingRe);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      const rest = para.slice(headingMatch[0].length).trim();
      return (
        <div key={i} data-testid={`text-paragraph-${i}`}>
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide mt-5 mb-1 pt-3 border-t border-gray-100">{heading}</h3>
          {rest && <p className="text-gray-800 leading-relaxed text-sm">{annotateText(rest)}</p>}
        </div>
      );
    }
    return (
      <p key={i} className="text-gray-800 leading-relaxed mb-3 text-sm" data-testid={`text-paragraph-${i}`}>
        {annotateText(para)}
      </p>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} data-testid="button-back-newsletter" className="text-sm text-indigo-600 hover:underline cursor-pointer flex items-center gap-1">
          <ChevronLeft size={16} /> Back
        </button>
      </div>

      <article className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100">
          <h1 className="text-xl font-bold text-gray-900 mb-2" data-testid="text-newsletter-title">{newsletter.title}</h1>
          <div className="flex items-center gap-4 text-sm text-gray-500">
            {newsletter.published_date && (
              <span className="flex items-center gap-1">
                <Calendar size={14} />
                {formatDate(newsletter.published_date)}
              </span>
            )}
            <a
              href={newsletter.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="link-politico-original"
              className="text-indigo-600 hover:underline flex items-center gap-1"
            >
              Read on Politico <ExternalLink size={12} />
            </a>
          </div>
        </div>

        {newsletter.entities.length > 0 && (
          <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-gray-500 mr-1">Extracted entities:</span>
              <span className="inline-flex items-center gap-1 text-xs text-indigo-600"><User size={12} /> People</span>
              <span className="inline-flex items-center gap-1 text-xs text-amber-600"><Briefcase size={12} /> Organizations</span>
              <span className="text-xs text-gray-400">· {newsletter.entities.length} mentions found</span>
            </div>
          </div>
        )}

        <div className="px-6 py-5 max-w-none">
          {(() => {
            const elements: React.ReactNode[] = [];
            let i = 0;
            while (i < paragraphs.length) {
              if (adBlocks.has(i) && adStartRe.test(paragraphs[i].trim())) {
                const adParas: string[] = [];
                const startIdx = i;
                while (i < paragraphs.length && adBlocks.has(i)) {
                  adParas.push(paragraphs[i]);
                  i++;
                }
                elements.push(
                  <div key={`ad-${startIdx}`} data-testid={`ad-block-${startIdx}`} className="my-4 border border-gray-200 rounded-lg bg-gray-50 overflow-hidden">
                    <div className="px-3 py-1.5 bg-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">Ad</div>
                    <div className="px-4 py-3 text-sm text-gray-500 space-y-2">
                      {adParas.map((p, j) => <p key={j}>{p}</p>)}
                    </div>
                  </div>
                );
              } else {
                elements.push(renderParagraph(paragraphs[i], i));
                i++;
              }
            }
            return elements;
          })()}
        </div>

        <div className="px-6 py-3 border-t border-gray-100 bg-gray-50">
          <a
            href={newsletter.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="link-politico-bottom"
            className="text-sm text-indigo-600 hover:underline flex items-center gap-1"
          >
            View original on Politico <ExternalLink size={14} />
          </a>
        </div>
      </article>
    </div>
  );
}

// ---------- Entity Leaderboard ----------
function EntityLeaderboard({ entityType, onBack, onNavigate }: { entityType: string; onBack: () => void; onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getEntities({ entity_type: entityType, sort: '-mention_count', page, page_size: pageSize });
      setEntities(data.results);
      setTotal(data.total);
    } catch (err) { console.error(err); }
    setLoading(false);
  }, [entityType, page]);

  useEffect(() => { load(); }, [load]);

  const isPerson = entityType === 'person';
  const label = isPerson ? 'People' : 'Organizations';
  const icon = isPerson ? <User size={16} /> : <Briefcase size={16} />;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-indigo-600 hover:underline flex items-center gap-1 cursor-pointer" data-testid="button-back-leaderboard">
        <ChevronLeft size={14} /> Back
      </button>
      <div className="flex items-center gap-2">
        <span className={isPerson ? 'text-indigo-600' : 'text-amber-600'}>{icon}</span>
        <h1 className="text-xl font-semibold text-gray-900">{label} by Mentions</h1>
        <span className="text-sm text-gray-400">({total.toLocaleString()} total)</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>
      ) : (
        <>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {entities.map((e, idx) => (
              <button
                key={e.id}
                onClick={() => onNavigate('entity', e.id)}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 cursor-pointer transition flex items-center gap-3"
                data-testid={`row-entity-${e.id}`}
              >
                <span className="text-sm font-mono text-gray-400 w-8 text-right">{(page - 1) * pageSize + idx + 1}</span>
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate">{e.display_name || e.name}</span>
                </div>
                <span className={isPerson ? 'text-sm font-semibold text-indigo-600' : 'text-sm font-semibold text-amber-600'}>{e.mention_count}</span>
                <span className="text-xs text-gray-400">mentions</span>
              </button>
            ))}
          </div>
          <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} />
        </>
      )}
    </div>
  );
}


// ---------- Reports Page ----------
// ---------- Utilities Page ----------
function UtilitiesPage({ onSyncComplete }: { onSyncComplete?: () => void }) {
  // LDA Sync state
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Influence scrape state
  const [scraping, setScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<any>(null);

  // Reprocess state
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<{ processed?: number; total?: number } | null>(null);

  useEffect(() => {
    api.getSyncStatus().then(ss => { setSyncStatus(ss); if (ss.status === 'running') setSyncing(true); }).catch(console.error);
  }, []);

  useEffect(() => {
    if (syncing && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const s = await api.getSyncStatus();
          setSyncStatus(s);
          if (s.status !== 'running' && s.status !== 'cancelling' && s.status !== 'started') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setSyncing(false);
            onSyncComplete?.();
          }
        } catch (e) { console.error(e); }
      }, 2000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [syncing]);

  const handleSync = async (mode: string) => {
    setSyncing(true);
    try { await api.triggerSync({ mode }); } catch (e) { console.error(e); setSyncing(false); }
  };
  const handleCancel = async () => {
    try { await api.cancelSync(); } catch (e) { console.error(e); }
  };

  const handleScrape = async () => {
    setScraping(true);
    setScrapeProgress(null);
    try {
      await api.triggerInfluenceScrape({ max_newsletters: 100, max_discovery_pages: 10 });
      const poll = setInterval(async () => {
        const s = await api.getInfluenceScrapeStatus();
        if (s.status === 'running' && s.progress) setScrapeProgress(s.progress);
        if (s.status !== 'running') { clearInterval(poll); setScraping(false); setScrapeProgress(null); }
      }, 3000);
    } catch (err) { console.error(err); setScraping(false); setScrapeProgress(null); }
  };

  const handleReprocess = async () => {
    if (!confirm('Re-run classification on all newsletters? This keeps existing entities but rebuilds all relationships.')) return;
    setReprocessing(true);
    setReprocessProgress(null);
    try {
      await api.reprocessEntities();
      const poll = setInterval(async () => {
        try {
          const p = await api.getReprocessStatus();
          if (p.status === 'running') setReprocessProgress({ processed: p.processed, total: p.total });
          if (p.status === 'done' || p.status === 'error') { clearInterval(poll); setReprocessProgress(null); setReprocessing(false); }
        } catch {}
      }, 2000);
    } catch (err) { console.error(err); setReprocessing(false); setReprocessProgress(null); }
  };

  const syncRunning = syncing || syncStatus?.status === 'running';

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Settings size={22} /> Utilities</h1>

      {/* LDA Filing Sync */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900 mb-3">LDA Filing Sync</h2>
        {syncStatus && syncStatus.status !== 'idle' && (
          <p className="text-xs text-gray-500 mb-3">
            {syncStatus.status === 'running' && syncStatus.mode === 'incremental' && (
              <>Fetching new filings… {syncStatus.stored || 0} stored, page {syncStatus.pages || 0}</>
            )}
            {syncStatus.status === 'running' && (syncStatus.mode === 'backfill' || syncStatus.mode === 'backfill_chunk') && (
              <>Backfilling {syncStatus.current_year || '…'} — {syncStatus.stored?.toLocaleString() || 0} new, {syncStatus.duplicates?.toLocaleString() || 0} skipped, page {syncStatus.pages || 0}</>
            )}
            {syncStatus.status === 'running' && syncStatus.mode === 'complete_years' && (
              <>Completing {syncStatus.current_year || '…'} — {syncStatus.stored?.toLocaleString() || 0} new, {syncStatus.duplicates?.toLocaleString() || 0} dupes, page {syncStatus.pages || 0}</>
            )}
            {syncStatus.status === 'cancelling' && 'Cancelling…'}
            {syncStatus.status === 'completed' && (
              <>Completed: {syncStatus.stored?.toLocaleString() || 0} new filings{syncStatus.duplicates ? `, ${syncStatus.duplicates.toLocaleString()} already had` : ''}</>
            )}
            {syncStatus.status === 'cancelled' && <>Cancelled: {syncStatus.stored?.toLocaleString() || 0} filings stored</>}
            {syncStatus.status === 'error' && <>Error: {syncStatus.error}</>}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {syncRunning ? (
            <button onClick={handleCancel} className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 cursor-pointer">
              <Square size={14} /> Stop
            </button>
          ) : (
            <>
              <button onClick={() => handleSync('incremental')} className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 cursor-pointer">
                <RefreshCw size={16} /> Sync New
              </button>
              <button onClick={() => handleSync('backfill')} className="flex items-center gap-2 bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 cursor-pointer">
                <Download size={16} /> Backfill 1,000 More
              </button>
              <button onClick={() => handleSync('complete_years')} className="flex items-center gap-2 bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 cursor-pointer">
                <Download size={16} /> Complete 2025+2026
              </button>
            </>
          )}
        </div>
        {syncRunning && (
          <div className="mt-3"><div className="w-full bg-gray-200 rounded-full h-1.5"><div className="bg-indigo-600 h-1.5 rounded-full animate-pulse" style={{ width: '100%' }} /></div></div>
        )}
      </div>

      {/* Influence Scraping */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900 mb-3">Politico Influence</h2>
        {scraping && scrapeProgress && (
          <p className="text-xs text-gray-500 mb-3">
            {scrapeProgress.phase === 'discovering' ? 'Discovering archive...' :
              `${scrapeProgress.stored} stored, ${scrapeProgress.skipped} skipped${scrapeProgress.total ? ` / ${scrapeProgress.total} total` : ''}`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button onClick={handleScrape} disabled={scraping || reprocessing}
            className="flex items-center gap-2 bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 cursor-pointer">
            {scraping ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {scraping ? 'Scraping...' : 'Scrape Newsletters'}
          </button>
          <button onClick={handleReprocess} disabled={reprocessing || scraping}
            className="flex items-center gap-2 border border-amber-600 text-amber-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-50 disabled:opacity-50 cursor-pointer"
            title="Re-run classification: keeps entities, rebuilds all relationships">
            {reprocessing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {reprocessing ? 'Reprocessing...' : 'Re-run Classification'}
          </button>
        </div>
        {reprocessing && reprocessProgress && reprocessProgress.total && reprocessProgress.total > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-gray-600">Reprocessing newsletters...</span>
              <span className="text-xs text-gray-500">{reprocessProgress.processed ?? 0} / {reprocessProgress.total}</span>
            </div>
            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full transition-all duration-500"
                style={{ width: `${Math.round(((reprocessProgress.processed ?? 0) / reprocessProgress.total) * 100)}%` }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


const REPORT_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16'];

type DatePreset = 'past_day' | 'past_week' | 'past_30' | 'past_365' | 'this_year' | 'last_year';

function getPresetDates(preset: DatePreset): { start: string; end: string } {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const end = fmt(now);
  switch (preset) {
    case 'past_day': { const d = new Date(now); d.setDate(d.getDate() - 1); return { start: fmt(d), end }; }
    case 'past_week': { const d = new Date(now); d.setDate(d.getDate() - 7); return { start: fmt(d), end }; }
    case 'past_30': { const d = new Date(now); d.setDate(d.getDate() - 30); return { start: fmt(d), end }; }
    case 'past_365': { const d = new Date(now); d.setDate(d.getDate() - 365); return { start: fmt(d), end }; }
    case 'this_year': return { start: `${now.getFullYear()}-01-01`, end };
    case 'last_year': return { start: `${now.getFullYear() - 1}-01-01`, end: `${now.getFullYear() - 1}-12-31` };
  }
}

function ReportLineChart({ data, title, loading }: { data: ReportSeries | null; title: string; loading: boolean }) {
  if (loading) return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">{title}</h3>
      <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={24} /></div>
    </div>
  );
  if (!data || !data.series.length) return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">{title}</h3>
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">No data for the selected period.</div>
    </div>
  );

  // Transform into recharts format: [{period, series1: n, series2: n}, ...]
  const periods = data.periods || [];
  const chartData = periods.map(p => {
    const row: Record<string, string | number> = { period: p };
    data.series.forEach(s => {
      const point = s.data.find(d => d.period === p);
      row[s.name] = point ? point.count : 0;
    });
    return row;
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={350}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="period"
            tick={{ fontSize: 11, fill: '#6b7280' }}
            angle={-45}
            textAnchor="end"
            height={60}
          />
          <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} allowDecimals={false} />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
          {data.series.map((s, i) => (
            <Line
              key={s.name}
              type="monotone"
              dataKey={s.name}
              stroke={REPORT_COLORS[i % REPORT_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 2 }}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type ReportFilters = { registrant_id?: number; issue_code?: string };

function ActivityHeatmap({ syncVersion, filters }: { syncVersion?: number; filters?: ReportFilters }) {
  const [data, setData] = useState<Array<{ date: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getActivityHeatmap(filters)
      .then(d => setData(d.days))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [syncVersion, filters?.registrant_id, filters?.issue_code]);

  const heatmapData = useMemo(() => {
    if (!data.length) return { weeks: [], maxCount: 0, months: [] };

    const countMap = new Map(data.map(d => [d.date, d.count]));

    // Build 52 full weeks ending on today
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sun
    // Start from the Sunday 52 weeks ago
    const start = new Date(today);
    start.setDate(start.getDate() - (52 * 7) - dayOfWeek);

    const weeks: Array<Array<{ date: string; count: number; month: number }>> = [];
    let currentWeek: Array<{ date: string; count: number; month: number }> = [];

    const cursor = new Date(start);
    while (cursor <= today) {
      const iso = cursor.toISOString().slice(0, 10);
      currentWeek.push({ date: iso, count: countMap.get(iso) || 0, month: cursor.getMonth() });
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length) weeks.push(currentWeek);

    const maxCount = Math.max(1, ...data.map(d => d.count));

    // Month labels: find the first week where a month starts
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const months: Array<{ label: string; col: number }> = [];
    let lastMonth = -1;
    weeks.forEach((week, wi) => {
      const firstDay = week[0];
      if (firstDay && firstDay.month !== lastMonth) {
        months.push({ label: monthNames[firstDay.month], col: wi });
        lastMonth = firstDay.month;
      }
    });

    return { weeks, maxCount, months };
  }, [data]);

  const getColor = (count: number, max: number) => {
    if (count === 0) return '#ebedf0';
    const ratio = count / max;
    if (ratio <= 0.25) return '#9be9a8';
    if (ratio <= 0.5) return '#40c463';
    if (ratio <= 0.75) return '#30a14e';
    return '#216e39';
  };

  const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const cellSize = 13;
  const cellGap = 3;
  const step = cellSize + cellGap;
  const leftPad = 32;

  if (loading) return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">Filing Activity</h3>
      <div className="flex items-center justify-center h-32"><Loader2 className="animate-spin text-indigo-600" size={24} /></div>
    </div>
  );

  if (!data.length) return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">Filing Activity</h3>
      <div className="flex items-center justify-center h-32 text-gray-400 text-sm">No filing data available.</div>
    </div>
  );

  const totalFilings = data.reduce((s, d) => s + d.count, 0);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold text-gray-900">Filing Activity</h3>
        <span className="text-sm text-gray-500">{totalFilings.toLocaleString()} filings in the last year</span>
      </div>
      <div className="overflow-x-auto">
        <svg width={leftPad + heatmapData.weeks.length * step + 10} height={step * 7 + 30}>
          {/* Month labels */}
          {heatmapData.months.map((m, i) => (
            <text key={i} x={leftPad + m.col * step} y={10} fontSize={11} fill="#6b7280">{m.label}</text>
          ))}
          {/* Day labels */}
          {dayLabels.map((label, i) => (
            label ? <text key={i} x={0} y={20 + i * step + cellSize - 2} fontSize={11} fill="#6b7280">{label}</text> : null
          ))}
          {/* Cells */}
          {heatmapData.weeks.map((week, wi) =>
            week.map((day, di) => (
              <rect
                key={`${wi}-${di}`}
                x={leftPad + wi * step}
                y={18 + di * step}
                width={cellSize}
                height={cellSize}
                rx={2}
                fill={getColor(day.count, heatmapData.maxCount)}
              >
                <title>{`${day.date}: ${day.count} filing${day.count !== 1 ? 's' : ''}`}</title>
              </rect>
            ))
          )}
          {/* Legend */}
          <text x={leftPad} y={step * 7 + 28} fontSize={11} fill="#6b7280">Less</text>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => (
            <rect
              key={i}
              x={leftPad + 30 + i * (cellSize + 2)}
              y={step * 7 + 17}
              width={cellSize}
              height={cellSize}
              rx={2}
              fill={getColor(ratio === 0 ? 0 : ratio * heatmapData.maxCount, heatmapData.maxCount)}
            />
          ))}
          <text x={leftPad + 30 + 5 * (cellSize + 2) + 4} y={step * 7 + 28} fontSize={11} fill="#6b7280">More</text>
        </svg>
      </div>
    </div>
  );
}

function IssueFirmHeatmapChart({ syncVersion }: { syncVersion?: number }) {
  const [data, setData] = useState<IssueFirmHeatmap | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getIssueFirmHeatmap(15)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [syncVersion]);

  if (loading) return <div className="bg-white rounded-lg border border-gray-200 p-6 flex justify-center"><Loader2 className="animate-spin text-gray-300" size={24} /></div>;
  if (!data || !data.firms.length) return null;

  const getHeatColor = (val: number) => {
    if (val === 0) return 'bg-gray-50 text-gray-300';
    if (val < 5) return 'bg-indigo-50 text-indigo-600';
    if (val < 15) return 'bg-indigo-100 text-indigo-700';
    if (val < 30) return 'bg-indigo-200 text-indigo-800';
    return 'bg-indigo-400 text-white';
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 overflow-x-auto">
      <h3 className="font-semibold text-gray-900 mb-4">Issue Area by Firm (% of Filings)</h3>
      <table className="text-xs w-full">
        <thead>
          <tr>
            <th className="text-left py-1 pr-2 font-medium text-gray-600 sticky left-0 bg-white min-w-[140px]">Firm</th>
            {data.issues.map(issue => (
              <th key={issue} className="py-1 px-1 font-medium text-gray-500 whitespace-nowrap" style={{ writingMode: 'vertical-rl', textOrientation: 'mixed', maxHeight: 120 }}>
                {issue.length > 25 ? issue.slice(0, 23) + '…' : issue}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.firms.map((firm, fi) => (
            <tr key={firm}>
              <td className="py-0.5 pr-2 font-medium text-gray-700 truncate max-w-[180px] sticky left-0 bg-white">{firm}</td>
              {data.cells[fi].map((val, ci) => (
                <td key={ci} className={`py-0.5 px-1 text-center rounded-sm ${getHeatColor(val)}`}>
                  {val > 0 ? `${val}%` : ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RevenueChart({ data, loading }: { data: RevenueByQuarter | null; loading: boolean }) {
  const [view, setView] = useState<'overall' | 'by_firm'>('overall');

  if (loading) return <div className="bg-white rounded-lg border border-gray-200 p-6 flex justify-center"><Loader2 className="animate-spin text-gray-300" size={24} /></div>;
  if (!data || !data.overall.length) return null;

  const chartData = data.overall.map(q => {
    const key = `${q.year}-${q.period}`;
    const entry: Record<string, any> = { period: key, Total: q.revenue };
    data.series.forEach(s => {
      const pt = s.data.find(d => d.period === key);
      entry[s.name] = pt?.revenue || 0;
    });
    return entry;
  });

  const allNames = data.series.map(s => s.name);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Revenue by Quarter</h3>
        <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
          <button onClick={() => setView('overall')} className={`px-2 py-1 cursor-pointer ${view === 'overall' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>Overall</button>
          <button onClick={() => setView('by_firm')} className={`px-2 py-1 cursor-pointer ${view === 'by_firm' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>By Firm</button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={350}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="period" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v / 1e6).toFixed(0)}M`} />
          <Tooltip
            formatter={(v: number, name: string) => [formatMoney(v), name]}
            labelFormatter={(label: string) => `Period: ${label}`}
          />
          <Legend />
          {view === 'overall' ? (
            <Line type="monotone" dataKey="Total" stroke="#374151" strokeWidth={2} dot={false} />
          ) : (
            allNames.slice(0, 8).map((name, i) => (
              <Line key={name} type="monotone" dataKey={name} stroke={REPORT_COLORS[i % REPORT_COLORS.length]} strokeWidth={2} dot={false} />
            ))
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function EntityAppearancesLeaderboard({ onNavigate }: { onNavigate?: (page: Page, ctx?: unknown) => void }) {
  const [data, setData] = useState<EntityAppearance[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>('');

  useEffect(() => {
    setLoading(true);
    api.getEntityAppearances(25, typeFilter || undefined)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [typeFilter]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-900">Top Report Appearances</h3>
        <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
          <button onClick={() => setTypeFilter('')} className={`px-2 py-1 cursor-pointer ${!typeFilter ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>All</button>
          <button onClick={() => setTypeFilter('person')} className={`px-2 py-1 cursor-pointer ${typeFilter === 'person' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>People</button>
          <button onClick={() => setTypeFilter('organization')} className={`px-2 py-1 cursor-pointer ${typeFilter === 'organization' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>Orgs</button>
        </div>
      </div>
      {loading ? (
        <div className="flex justify-center py-4"><Loader2 className="animate-spin text-gray-300" size={20} /></div>
      ) : (
        <div className="space-y-1.5">
          {data.map((e, i) => (
            <div key={e.id} className="flex items-center justify-between text-sm">
              <span className="text-gray-700 truncate">
                <span className="text-gray-400 mr-2">{i + 1}.</span>
                {onNavigate ? (
                  <button onClick={() => onNavigate('entity', e.id)} className="text-indigo-600 hover:underline cursor-pointer">{e.display_name}</button>
                ) : e.display_name}
              </span>
              <span className="text-gray-500 shrink-0 ml-2">{e.newsletter_count} newsletters</span>
            </div>
          ))}
          {data.length === 0 && <p className="text-sm text-gray-400">No data yet</p>}
        </div>
      )}
    </div>
  );
}

function FilingTypeDonut({ filters }: { filters?: ReportFilters }) {
  const [data, setData] = useState<Array<{ type: string; display: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.getFilingTypeBreakdown(filters).then(setData).catch(() => setData([])).finally(() => setLoading(false));
  }, [filters?.registrant_id, filters?.issue_code]);
  if (loading) return <div className="bg-white rounded-lg border border-gray-200 p-4 flex justify-center py-8"><Loader2 className="animate-spin text-gray-300" size={20} /></div>;
  if (!data.length) return null;
  const total = data.reduce((s, d) => s + d.count, 0);
  const colors = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3">Filing Types</h3>
      <div className="space-y-2">
        {data.map((d, i) => (
          <div key={d.type}>
            <div className="flex items-center justify-between text-sm mb-0.5">
              <span className="text-gray-700">{d.display}</span>
              <span className="text-gray-500">{d.count.toLocaleString()} ({Math.round(d.count / total * 100)}%)</span>
            </div>
            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${d.count / total * 100}%`, backgroundColor: colors[i % colors.length] }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RegistrationTrendChart({ granularity, syncVersion, filters }: { granularity: string; syncVersion?: number; filters?: ReportFilters }) {
  const [data, setData] = useState<{ periods: string[]; registrations: number[]; terminations: number[] } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.getRegistrationTrend(granularity, filters).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [granularity, syncVersion, filters?.registrant_id, filters?.issue_code]);
  if (loading) return <div className="bg-white rounded-lg border border-gray-200 p-6 flex justify-center"><Loader2 className="animate-spin text-gray-300" size={24} /></div>;
  if (!data || !data.periods.length) return null;
  const chartData = data.periods.map((p, i) => ({ period: p, Registrations: data.registrations[i], Terminations: data.terminations[i] }));
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-4">New Registrations vs Terminations</h3>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="period" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="Registrations" stroke="#10b981" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="Terminations" stroke="#ef4444" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TopClientsBySpend() {
  const [data, setData] = useState<Array<{ name: string; total_spend: number; filing_count: number; firm_count: number }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api.getTopClientsBySpend(15).then(setData).catch(() => setData([])).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="bg-white rounded-lg border border-gray-200 p-4 flex justify-center py-8"><Loader2 className="animate-spin text-gray-300" size={20} /></div>;
  if (!data.length) return null;
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3">Top Clients by Spend</h3>
      <div className="space-y-1.5">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center justify-between text-sm">
            <span className="text-gray-700 truncate"><span className="text-gray-400 mr-2">{i + 1}.</span>{d.name}</span>
            <div className="flex items-center gap-3 shrink-0 ml-2">
              <span className="text-gray-500 text-xs">{d.firm_count} firms</span>
              <span className="text-green-600 font-medium">{formatMoney(d.total_spend)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopIssuesByRevenue() {
  const [data, setData] = useState<Array<{ issue: string; total_revenue: number; filing_count: number; firm_count: number }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api.getTopIssuesByRevenue(15).then(setData).catch(() => setData([])).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="bg-white rounded-lg border border-gray-200 p-4 flex justify-center py-8"><Loader2 className="animate-spin text-gray-300" size={20} /></div>;
  if (!data.length) return null;
  const maxRev = Math.max(...data.map(d => d.total_revenue));
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3">Top Issue Areas by Revenue</h3>
      <div className="space-y-1.5">
        {data.map((d, i) => (
          <div key={d.issue}>
            <div className="flex items-center justify-between text-sm mb-0.5">
              <span className="text-gray-700 truncate text-xs"><span className="text-gray-400 mr-1">{i + 1}.</span>{d.issue}</span>
              <span className="text-green-600 font-medium text-xs shrink-0 ml-2">{formatMoney(d.total_revenue)}</span>
            </div>
            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-green-400 rounded-full" style={{ width: `${d.total_revenue / maxRev * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopConsultantsByRevenue({ onNavigate }: { onNavigate?: (page: Page, ctx?: unknown) => void }) {
  const [data, setData] = useState<Array<{ id: number; display_name: string; total_revenue: number; unique_clients: number }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api.getTopConsultantsByRevenue(15).then(setData).catch(() => setData([])).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="bg-white rounded-lg border border-gray-200 p-4 flex justify-center py-8"><Loader2 className="animate-spin text-gray-300" size={20} /></div>;
  if (!data.length) return null;
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3">Top Consultants by Revenue</h3>
      <div className="space-y-1.5">
        {data.map((d, i) => (
          <div key={d.id} className="flex items-center justify-between text-sm">
            <button onClick={() => onNavigate?.('entity', d.id)} className="text-gray-700 truncate hover:text-indigo-600 cursor-pointer text-left">
              <span className="text-gray-400 mr-2">{i + 1}.</span>{d.display_name}
            </button>
            <div className="flex items-center gap-3 shrink-0 ml-2">
              <span className="text-gray-500 text-xs">{d.unique_clients} clients</span>
              <span className="text-green-600 font-medium">{formatMoney(d.total_revenue)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopLobbyistsChart({ onNavigate }: { onNavigate?: (page: Page, ctx?: unknown) => void }) {
  const [data, setData] = useState<Array<{ name: string; unique_clients: number; firms: string[] }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api.getTopLobbyistsByClients(15).then(setData).catch(() => setData([])).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="bg-white rounded-lg border border-gray-200 p-4 flex justify-center py-8"><Loader2 className="animate-spin text-gray-300" size={20} /></div>;
  if (!data.length) return null;
  const maxCount = Math.max(...data.map(d => d.unique_clients));
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3">Top Lobbyists by Clients</h3>
      <div className="space-y-1.5">
        {data.map((d, i) => (
          <div key={d.name}>
            <div className="flex items-center justify-between text-sm mb-0.5">
              <button onClick={() => onNavigate?.('search', { q: d.name })} className="text-gray-700 truncate text-xs hover:text-indigo-600 cursor-pointer text-left">
                <span className="text-gray-400 mr-1">{i + 1}.</span>{d.name}
              </button>
              <span className="text-indigo-600 font-medium text-xs shrink-0 ml-2">{d.unique_clients} clients</span>
            </div>
            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${d.unique_clients / maxCount * 100}%` }} />
            </div>
            {d.firms.length > 0 && (
              <p className="text-[10px] text-gray-400 truncate mt-0.5">{d.firms.join(', ')}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportsPage({ syncVersion, onNavigate }: { syncVersion?: number; onNavigate?: (page: Page, ctx?: unknown) => void }) {
  const [preset, setPreset] = useState<DatePreset>('past_365');
  const [granularity, setGranularity] = useState<'week' | 'month'>('month');
  const [regData, setRegData] = useState<ReportSeries | null>(null);
  const [issueData, setIssueData] = useState<ReportSeries | null>(null);
  const [regLoading, setRegLoading] = useState(false);
  const [issueLoading, setIssueLoading] = useState(false);
  const [revenueData, setRevenueData] = useState<RevenueByQuarter | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(false);

  // Filter state
  const [registrantList, setRegistrantList] = useState<Array<{ id: number; name: string; filing_count: number }>>([]);
  const [issueList, setIssueList] = useState<IssueSummary[]>([]);
  const [selectedRegistrant, setSelectedRegistrant] = useState<number | undefined>();
  const [selectedIssue, setSelectedIssue] = useState<string | undefined>();
  const [registrantSearch, setRegistrantSearch] = useState('');

  // Load filter options once
  useEffect(() => {
    api.getRegistrants().then(setRegistrantList).catch(() => {});
    api.getIssues().then(setIssueList).catch(() => {});
  }, []);

  const filters: ReportFilters = useMemo(() => {
    const f: ReportFilters = {};
    if (selectedRegistrant) f.registrant_id = selectedRegistrant;
    if (selectedIssue) f.issue_code = selectedIssue;
    return f;
  }, [selectedRegistrant, selectedIssue]);

  const hasFilters = selectedRegistrant || selectedIssue;

  const loadData = useCallback(() => {
    const { start, end } = getPresetDates(preset);
    setRegLoading(true);
    setIssueLoading(true);
    setRevenueLoading(true);
    api.getRegistrationsByPeriod({ granularity, start_date: start, end_date: end, limit: 10, ...filters })
      .then(d => setRegData(d))
      .catch(() => setRegData(null))
      .finally(() => setRegLoading(false));
    api.getIssuesByPeriod({ granularity, start_date: start, end_date: end, limit: 10, ...filters })
      .then(d => setIssueData(d))
      .catch(() => setIssueData(null))
      .finally(() => setIssueLoading(false));
    api.getRevenueByQuarter(10, filters)
      .then(d => setRevenueData(d))
      .catch(() => setRevenueData(null))
      .finally(() => setRevenueLoading(false));
  }, [preset, granularity, syncVersion, selectedRegistrant, selectedIssue]);

  useEffect(() => { loadData(); }, [loadData]);

  const presets: { id: DatePreset; label: string }[] = [
    { id: 'past_day', label: 'Past Day' },
    { id: 'past_week', label: 'Past Week' },
    { id: 'past_30', label: 'Past 30 Days' },
    { id: 'past_365', label: 'Past 365 Days' },
    { id: 'this_year', label: 'This Year' },
    { id: 'last_year', label: 'Last Year' },
  ];

  const filteredRegistrants = registrantSearch
    ? registrantList.filter(r => r.name.toLowerCase().includes(registrantSearch.toLowerCase())).slice(0, 20)
    : registrantList.slice(0, 20);

  const selectedRegName = selectedRegistrant ? registrantList.find(r => r.id === selectedRegistrant)?.name : undefined;
  const selectedIssueName = selectedIssue ? issueList.find(i => i.code === selectedIssue)?.display : undefined;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <TrendingUp size={22} className="text-indigo-600" /> Reports
        </h1>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button onClick={() => setGranularity('week')} className={`px-3 py-1.5 text-sm font-medium cursor-pointer transition ${granularity === 'week' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Weekly</button>
            <button onClick={() => setGranularity('month')} className={`px-3 py-1.5 text-sm font-medium cursor-pointer transition ${granularity === 'month' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Monthly</button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
          <div className="flex-1 min-w-0">
            <label className="block text-xs font-medium text-gray-500 mb-1">Consultant / Firm</label>
            <div className="relative">
              <input
                type="text"
                value={selectedRegName || registrantSearch}
                onChange={e => { setRegistrantSearch(e.target.value); if (selectedRegistrant) setSelectedRegistrant(undefined); }}
                placeholder="All firms"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
              />
              {registrantSearch && !selectedRegistrant && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {filteredRegistrants.map(r => (
                    <button
                      key={r.id}
                      onClick={() => { setSelectedRegistrant(r.id); setRegistrantSearch(''); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 cursor-pointer flex justify-between"
                    >
                      <span className="truncate">{r.name}</span>
                      <span className="text-gray-400 shrink-0 ml-2">{r.filing_count}</span>
                    </button>
                  ))}
                  {filteredRegistrants.length === 0 && <p className="px-3 py-2 text-sm text-gray-400">No matches</p>}
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <label className="block text-xs font-medium text-gray-500 mb-1">Issue Area</label>
            <select
              value={selectedIssue || ''}
              onChange={e => setSelectedIssue(e.target.value || undefined)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 bg-white"
            >
              <option value="">All issues</option>
              {issueList.map(i => (
                <option key={i.code} value={i.code}>{i.display} ({i.count})</option>
              ))}
            </select>
          </div>
          {hasFilters && (
            <button
              onClick={() => { setSelectedRegistrant(undefined); setSelectedIssue(undefined); setRegistrantSearch(''); }}
              className="text-sm text-red-500 hover:text-red-700 cursor-pointer px-3 py-2 border border-red-200 rounded-lg hover:bg-red-50 whitespace-nowrap"
            >
              Clear filters
            </button>
          )}
        </div>
        {hasFilters && (
          <div className="mt-2 flex flex-wrap gap-2">
            {selectedRegName && (
              <span className="inline-flex items-center gap-1 text-xs bg-indigo-50 text-indigo-700 px-2 py-1 rounded-full">
                Firm: {selectedRegName}
                <button onClick={() => { setSelectedRegistrant(undefined); setRegistrantSearch(''); }} className="hover:text-indigo-900 cursor-pointer">&times;</button>
              </span>
            )}
            {selectedIssueName && (
              <span className="inline-flex items-center gap-1 text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-full">
                Issue: {selectedIssueName}
                <button onClick={() => setSelectedIssue(undefined)} className="hover:text-amber-900 cursor-pointer">&times;</button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Date preset pills */}
      <div className="flex flex-wrap gap-2">
        {presets.map(p => (
          <button key={p.id} onClick={() => setPreset(p.id)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium cursor-pointer transition ${preset === p.id ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Activity heatmap - full width */}
      <ActivityHeatmap syncVersion={syncVersion} filters={filters} />

      {/* Row 1: Revenue + Registration trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RevenueChart data={revenueData} loading={revenueLoading} />
        <RegistrationTrendChart granularity={granularity} syncVersion={syncVersion} filters={filters} />
      </div>

      {/* Row 2: Filing type + time series charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <FilingTypeDonut filters={filters} />
        <div className="lg:col-span-2">
          <ReportLineChart data={regData} title="New Lobbying Registrations by Firm" loading={regLoading} />
        </div>
      </div>

      {/* Row 3: Issue activity chart full width */}
      <ReportLineChart data={issueData} title="Lobbying Activity by Issue Area" loading={issueLoading} />

      {/* Row 4: Top consultants by revenue + Top lobbyists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TopConsultantsByRevenue onNavigate={onNavigate} />
        <TopLobbyistsChart onNavigate={onNavigate} />
      </div>

      {/* Row 5: Issue-firm heatmap full width */}
      <IssueFirmHeatmapChart syncVersion={syncVersion} />
    </div>
  );
}


// ---------- Chat Page ----------
function ChatPage({ onNavigate, initialConversationId }: { onNavigate: (page: Page, ctx?: unknown) => void; initialConversationId?: number }) {
  const [conversations, setConversations] = useState<Array<{ id: number; title: string; entity_id: number | null; message_count: number; created_at: string | null; updated_at: string | null }>>([]);
  const [activeConvoId, setActiveConvoId] = useState<number | undefined>(initialConversationId);
  const [messages, setMessages] = useState<Array<{ id?: number; role: string; content: string; created_at?: string | null }>>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { api.getAiStatus().then(s => setAiAvailable(s.available)).catch(() => {}); }, []);

  const loadConversations = useCallback(() => {
    api.getConversations().then(r => setConversations(r.results)).catch(() => {});
  }, []);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  const loadConversation = useCallback((id: number) => {
    api.getConversation(id).then(c => {
      setMessages(c.messages);
      setActiveConvoId(c.id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialConversationId) loadConversation(initialConversationId);
  }, [initialConversationId, loadConversation]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);

    // Optimistically add user message
    setMessages(prev => [...prev, { role: 'user', content: text }]);

    try {
      const result = await api.aiChat(text, activeConvoId);
      setActiveConvoId(result.conversation_id);
      setMessages(prev => [...prev, { role: 'assistant', content: result.response, id: result.message_id }]);
      loadConversations();
    } catch (err: unknown) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}` }]);
    }
    setSending(false);
  };

  const startNewChat = () => {
    setActiveConvoId(undefined);
    setMessages([]);
    setInput('');
  };

  const deleteConvo = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteConversation(id);
    if (activeConvoId === id) startNewChat();
    loadConversations();
  };

  const formatInline = (text: string): (string | React.ReactElement)[] => {
    const parts: (string | React.ReactElement)[] = [];
    let remaining = text;
    let key = 0;
    while (remaining) {
      const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
      if (boldMatch && boldMatch.index !== undefined) {
        if (boldMatch.index > 0) parts.push(remaining.slice(0, boldMatch.index));
        parts.push(<strong key={key++} className="font-semibold">{boldMatch[1]}</strong>);
        remaining = remaining.slice(boldMatch.index + boldMatch[0].length);
      } else {
        parts.push(remaining);
        break;
      }
    }
    return parts;
  };

  const renderMarkdown = (text: string) => {
    const paragraphs = text.split(/\n\n+/);
    return paragraphs.map((block, pi) => {
      const lines = block.split('\n');
      return <div key={pi} className={pi > 0 ? 'mt-2' : ''}>
        {lines.map((line, i) => {
          if (!line.trim()) return null;
          if (line.startsWith('## ')) return <h3 key={i} className="text-sm font-bold text-gray-900 mt-2 mb-1">{formatInline(line.slice(3))}</h3>;
          if (line.startsWith('### ')) return <h4 key={i} className="text-sm font-semibold text-gray-900 mt-1 mb-1">{formatInline(line.slice(4))}</h4>;
          if (line.startsWith('- ')) return <li key={i} className="text-sm ml-4 list-disc">{formatInline(line.slice(2))}</li>;
          return <p key={i} className="text-sm">{formatInline(line)}</p>;
        })}
      </div>;
    });
  };

  if (!aiAvailable) {
    return (
      <div className="flex items-center justify-center h-[70vh]">
        <div className="text-center">
          <Bot size={48} className="mx-auto text-gray-300 mb-4" />
          <h2 className="text-lg font-semibold text-gray-700 mb-2">AI Chat Not Available</h2>
          <p className="text-sm text-gray-500">Set the ANTHROPIC_API_KEY secret to enable AI features.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-5rem)] -mt-2">
      {/* Sidebar overlay for mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Sidebar */}
      <div className={`${sidebarOpen ? 'fixed inset-0 z-50 md:static md:inset-auto md:w-72' : 'w-0'} transition-all overflow-hidden border-r border-white/30 backdrop-blur-xl bg-white/70 flex flex-col shrink-0`}>
        <div className="p-3 border-b border-white/30 flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden text-gray-500 hover:text-gray-700 cursor-pointer p-1"
          >
            <X size={18} />
          </button>
          <button
            onClick={startNewChat}
            className="w-full text-sm bg-indigo-600 text-white px-3 py-2 rounded-lg hover:bg-indigo-700 cursor-pointer flex items-center justify-center gap-2"
          >
            <MessageCircle size={14} /> New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.map(c => (
            <button
              key={c.id}
              onClick={() => loadConversation(c.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-white/30 hover:bg-white/40 cursor-pointer transition group ${activeConvoId === c.id ? 'bg-indigo-100/50' : ''}`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="text-sm font-medium text-gray-800 line-clamp-2 flex-1">{c.title}</span>
                <button
                  onClick={(e) => deleteConvo(c.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 cursor-pointer shrink-0 p-0.5"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                {c.message_count} messages · {c.updated_at ? timeAgo(c.updated_at) : ''}
              </div>
            </button>
          ))}
          {conversations.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-8">No conversations yet</p>
          )}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-white">
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="text-gray-500 hover:text-gray-700 cursor-pointer p-1"
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <Bot size={18} className="text-indigo-500" />
          <span className="text-sm font-medium text-gray-700">
            {activeConvoId ? conversations.find(c => c.id === activeConvoId)?.title || 'Chat' : 'New Conversation'}
          </span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <Sparkles size={40} className="mx-auto text-indigo-300 mb-4" />
                <h2 className="text-lg font-semibold text-gray-700 mb-2">Ask anything about the data</h2>
                <p className="text-sm text-gray-500 mb-4">
                  Explore lobbying relationships, spending patterns, policy priorities, and connections between entities in the LDA filings and Politico Influence data.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    'Who are the top lobbying clients in tech?',
                    'What policy areas does TikTok lobby on?',
                    'Show me the biggest lobbying spenders',
                    'Which firms lobby on AI regulation?',
                  ].map((q, i) => (
                    <button
                      key={i}
                      onClick={() => { setInput(q); }}
                      className="text-xs text-left px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-indigo-200 cursor-pointer transition"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-4 py-3 ${
                m.role === 'user'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-800'
              }`}>
                {m.role === 'user' ? (
                  <p className="text-sm">{m.content}</p>
                ) : (
                  <div>{renderMarkdown(m.content)}</div>
                )}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 size={14} className="animate-spin" /> Thinking...
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-gray-200 bg-white px-4 py-3">
          <div className="flex gap-2 max-w-4xl mx-auto">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Ask about lobbying data, entities, relationships..."
              className="flex-1 text-sm border border-gray-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
              disabled={sending}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="bg-indigo-600 text-white px-4 py-2.5 rounded-lg hover:bg-indigo-700 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ---------- Ads Page ----------
function AdsPage({ onNavigate }: { onNavigate: (p: Page, ctx?: unknown) => void }) {
  const [tab, setTab] = useState<'gallery' | 'campaigns'>('gallery');
  const [stats, setStats] = useState<AdStats | null>(null);
  const [captures, setCaptures] = useState<AdCaptureSummary[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaignSummary[]>([]);
  const [captureTotal, setCaptureTotal] = useState(0);
  const [campaignTotal, setCampaignTotal] = useState(0);
  const [capturePage, setCapturePage] = useState(1);
  const [campaignPage, setCampaignPage] = useState(1);
  const [siteFilter, setSiteFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedCapture, setSelectedCapture] = useState<AdCaptureDetail | null>(null);
  const [scrapeStatus, setScrapeStatus] = useState<{ status: string; captured?: number; errors?: number; sites_completed?: string[]; log?: string[]; error?: string } | null>(null);

  // Load stats on mount
  useEffect(() => {
    api.getAdStats().then(setStats).catch(() => {});
  }, []);

  // Load captures when filters/page change
  useEffect(() => {
    setLoading(true);
    api.getAdCaptures({ site: siteFilter || undefined, domain: domainFilter || undefined, page: capturePage, page_size: 24 })
      .then(d => { setCaptures(d.results); setCaptureTotal(d.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [capturePage, siteFilter, domainFilter]);

  // Load campaigns
  useEffect(() => {
    api.getAdCampaigns({ sort: 'captures', page: campaignPage })
      .then(d => { setCampaigns(d.results); setCampaignTotal(d.total); })
      .catch(() => {});
  }, [campaignPage]);

  const handleScrape = () => {
    api.triggerAdScrape().then(setScrapeStatus).catch(() => {});
  };

  // Poll scrape status while running
  useEffect(() => {
    if (!scrapeStatus || scrapeStatus.status !== 'started') return;
    const iv = setInterval(() => {
      api.getAdScrapeStatus().then(s => {
        setScrapeStatus(s);
        if (s.status === 'done' || s.status === 'error' || s.status === 'idle') {
          clearInterval(iv);
          // Refresh data
          api.getAdStats().then(setStats).catch(() => {});
          api.getAdCaptures({ site: siteFilter || undefined, domain: domainFilter || undefined, page: 1, page_size: 24 })
            .then(d => { setCaptures(d.results); setCaptureTotal(d.total); setCapturePage(1); })
            .catch(() => {});
        }
      });
    }, 3000);
    return () => clearInterval(iv);
  }, [scrapeStatus?.status]);

  const loadCaptureDetail = (id: number) => {
    api.getAdCapture(id).then(setSelectedCapture).catch(() => {});
  };

  const sites = ['politico', 'axios', 'punchbowl'];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ad Tracker</h1>
          <p className="text-sm text-gray-500 mt-1">Monitor advocacy ads on DC political news sites</p>
        </div>
        <button
          onClick={handleScrape}
          disabled={scrapeStatus?.status === 'started' || scrapeStatus?.status === 'running'}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 cursor-pointer"
        >
          {(scrapeStatus?.status === 'started' || scrapeStatus?.status === 'running') ? (
            <><Loader2 size={16} className="animate-spin" /> Scraping...</>
          ) : (
            <><RefreshCw size={16} /> Scrape Ads</>
          )}
        </button>
      </div>

      {/* Scrape progress banner */}
      {scrapeStatus && (scrapeStatus.status === 'started' || scrapeStatus.status === 'running') && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 space-y-2">
          <div className="text-sm text-indigo-700 font-medium">
            Scraping in progress... {scrapeStatus.captured ?? 0} ads captured
            {scrapeStatus.sites_completed && scrapeStatus.sites_completed.length > 0 && (
              <span> — completed: {scrapeStatus.sites_completed.join(', ')}</span>
            )}
          </div>
          {scrapeStatus.log && scrapeStatus.log.length > 0 && (
            <div className="bg-indigo-100/50 rounded p-2 max-h-40 overflow-y-auto font-mono text-xs text-indigo-600 space-y-0.5">
              {scrapeStatus.log.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
        </div>
      )}
      {scrapeStatus && scrapeStatus.status === 'done' && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 space-y-2">
          <div className="text-sm text-green-700 font-medium">
            Scrape complete — {scrapeStatus.captured ?? 0} ads captured
            {(scrapeStatus.errors ?? 0) > 0 && <span className="text-amber-600"> ({scrapeStatus.errors} errors)</span>}
          </div>
          {scrapeStatus.log && scrapeStatus.log.length > 0 && (
            <details className="text-xs">
              <summary className="text-green-600 cursor-pointer">Show log</summary>
              <div className="bg-green-100/50 rounded p-2 mt-1 max-h-40 overflow-y-auto font-mono text-green-600 space-y-0.5">
                {scrapeStatus.log.map((line, i) => <div key={i}>{line}</div>)}
              </div>
            </details>
          )}
        </div>
      )}
      {scrapeStatus && scrapeStatus.status === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
          <div className="text-sm text-red-700 font-medium">
            Scrape failed
            {scrapeStatus.error && scrapeStatus.error.includes('proxy') && (
              <span className="font-normal"> — network access to news sites is blocked in this environment. Deploy to production for full scraping.</span>
            )}
          </div>
          {scrapeStatus.log && scrapeStatus.log.length > 0 && (
            <div className="bg-red-100/50 rounded p-2 max-h-40 overflow-y-auto font-mono text-xs text-red-600 space-y-0.5">
              {scrapeStatus.log.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="text-2xl font-bold text-gray-900">{stats.total_captures.toLocaleString()}</div>
            <div className="text-sm text-gray-500">Ads Captured</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="text-2xl font-bold text-gray-900">{stats.total_campaigns.toLocaleString()}</div>
            <div className="text-sm text-gray-500">Advertisers</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="text-2xl font-bold text-gray-900">{stats.unique_domains.toLocaleString()}</div>
            <div className="text-sm text-gray-500">Unique Domains</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="text-2xl font-bold text-gray-900">{stats.latest_capture ? timeAgo(stats.latest_capture) : '—'}</div>
            <div className="text-sm text-gray-500">Last Capture</div>
          </div>
        </div>
      )}

      {/* Top advertisers */}
      {stats && stats.top_advertisers.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Top Advertisers</h3>
          <div className="flex flex-wrap gap-2">
            {stats.top_advertisers.map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-full text-sm">
                <span className="font-medium text-gray-900">{a.name}</span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-500">{a.capture_count} ads</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {(['gallery', 'campaigns'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`pb-2 px-1 text-sm font-medium border-b-2 cursor-pointer ${tab === t ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              {t === 'gallery' ? 'Ad Gallery' : 'Campaigns'}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'gallery' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex gap-3 items-center">
            <select
              value={siteFilter}
              onChange={e => { setSiteFilter(e.target.value); setCapturePage(1); }}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm cursor-pointer"
            >
              <option value="">All sites</option>
              {sites.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <input
              type="text"
              placeholder="Filter by domain..."
              value={domainFilter}
              onChange={e => { setDomainFilter(e.target.value); setCapturePage(1); }}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-48"
            />
            <span className="text-sm text-gray-500">{captureTotal} ads</span>
          </div>

          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="animate-spin text-gray-400" size={32} /></div>
          ) : captures.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <Eye size={48} className="mx-auto mb-3 opacity-50" />
              <p className="text-lg font-medium">No ads captured yet</p>
              <p className="text-sm mt-1">Click "Scrape Ads" to start capturing banner ads from political news sites.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {captures.map(cap => (
                  <div
                    key={cap.id}
                    onClick={() => loadCaptureDetail(cap.id)}
                    className="bg-white rounded-lg border border-gray-200 overflow-hidden hover:shadow-md transition cursor-pointer"
                  >
                    {/* Ad preview area */}
                    <div className="bg-gray-50 h-32 flex items-center justify-center border-b border-gray-100">
                      {cap.has_screenshot ? (
                        <div className="text-xs text-gray-400 flex items-center gap-1"><Eye size={14} /> Click to view</div>
                      ) : (
                        <div className="text-xs text-gray-300">No screenshot</div>
                      )}
                    </div>
                    <div className="p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="inline-block px-2 py-0.5 text-xs font-medium bg-indigo-50 text-indigo-700 rounded">
                          {cap.site}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {cap.landing_page_type && cap.landing_page_type !== 'unknown' && (
                            <span className={`px-1.5 py-0.5 text-xs rounded ${
                              cap.landing_page_type === 'advocacy' ? 'bg-red-50 text-red-700' :
                              cap.landing_page_type === 'issue' ? 'bg-amber-50 text-amber-700' :
                              cap.landing_page_type === 'corporate' ? 'bg-blue-50 text-blue-700' :
                              cap.landing_page_type === 'donation' ? 'bg-green-50 text-green-700' :
                              'bg-gray-50 text-gray-600'
                            }`}>{cap.landing_page_type}</span>
                          )}
                          <span className="text-xs text-gray-400">{cap.ad_slot}</span>
                        </div>
                      </div>
                      {cap.resolved_domain ? (
                        <div className="text-sm font-medium text-gray-900 truncate">{cap.resolved_domain}</div>
                      ) : cap.destination_domain ? (
                        <div className="text-sm font-medium text-gray-900 truncate">{cap.destination_domain}</div>
                      ) : null}
                      {cap.landing_page_title ? (
                        <div className="text-xs text-gray-600 truncate">{cap.landing_page_title}</div>
                      ) : cap.ad_text ? (
                        <div className="text-xs text-gray-500 truncate">{cap.ad_text}</div>
                      ) : null}
                      <div className="text-xs text-gray-400">{cap.captured_at ? timeAgo(cap.captured_at) : ''}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {captureTotal > 24 && (
                <div className="flex justify-center gap-2 pt-2">
                  <button
                    onClick={() => setCapturePage(p => Math.max(1, p - 1))}
                    disabled={capturePage === 1}
                    className="px-3 py-1 border rounded text-sm disabled:opacity-30 cursor-pointer"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="px-3 py-1 text-sm text-gray-600">
                    Page {capturePage} of {Math.ceil(captureTotal / 24)}
                  </span>
                  <button
                    onClick={() => setCapturePage(p => p + 1)}
                    disabled={capturePage >= Math.ceil(captureTotal / 24)}
                    className="px-3 py-1 border rounded text-sm disabled:opacity-30 cursor-pointer"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'campaigns' && (
        <div className="space-y-4">
          {campaigns.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <Building2 size={48} className="mx-auto mb-3 opacity-50" />
              <p className="text-lg font-medium">No campaigns yet</p>
              <p className="text-sm mt-1">Campaigns are created automatically when ads are scraped and grouped by advertiser domain.</p>
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">Advertiser</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">Domain</th>
                    <th className="text-center px-4 py-2 font-medium text-gray-600">Ads</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">Sites</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">First Seen</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map(c => (
                    <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-2 font-medium text-gray-900">
                        {c.advertiser_name}
                        {c.entity_id && (
                          <button
                            onClick={() => onNavigate('entity', c.entity_id)}
                            className="ml-2 text-xs text-indigo-600 hover:underline cursor-pointer"
                          >
                            View entity
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2 text-gray-500">{c.advertiser_domain || '—'}</td>
                      <td className="px-4 py-2 text-center font-medium">{c.capture_count}</td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          {c.sites_seen_on.map(s => (
                            <span key={s} className="px-1.5 py-0.5 text-xs bg-gray-100 rounded">{s}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs">{c.first_seen ? formatDate(c.first_seen) : '—'}</td>
                      <td className="px-4 py-2 text-gray-500 text-xs">{c.last_seen ? formatDate(c.last_seen) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Capture detail modal */}
      {selectedCapture && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setSelectedCapture(null)}>
          <div className="bg-white rounded-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Ad Capture #{selectedCapture.id}</h3>
              <button onClick={() => setSelectedCapture(null)} className="p-1 hover:bg-gray-100 rounded cursor-pointer"><X size={20} /></button>
            </div>

            {selectedCapture.screenshot_base64 && (
              <div className="mb-4 border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                <img
                  src={`data:image/png;base64,${selectedCapture.screenshot_base64}`}
                  alt="Ad screenshot"
                  className="max-w-full h-auto"
                />
              </div>
            )}

            {/* Landing page info card */}
            {selectedCapture.landing_page_title && (
              <div className="mb-4 bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
                {selectedCapture.landing_page_og_image && (
                  <img
                    src={selectedCapture.landing_page_og_image}
                    alt=""
                    className="w-full h-36 object-cover"
                    onError={e => (e.currentTarget.style.display = 'none')}
                  />
                )}
                <div className="p-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-gray-900 text-sm flex-1">{selectedCapture.landing_page_title}</h4>
                    {selectedCapture.landing_page_type && selectedCapture.landing_page_type !== 'unknown' && (
                      <span className={`flex-shrink-0 px-2 py-0.5 text-xs font-medium rounded ${
                        selectedCapture.landing_page_type === 'advocacy' ? 'bg-red-100 text-red-700' :
                        selectedCapture.landing_page_type === 'issue' ? 'bg-amber-100 text-amber-700' :
                        selectedCapture.landing_page_type === 'corporate' ? 'bg-blue-100 text-blue-700' :
                        selectedCapture.landing_page_type === 'donation' ? 'bg-green-100 text-green-700' :
                        selectedCapture.landing_page_type === 'product' ? 'bg-purple-100 text-purple-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>{selectedCapture.landing_page_type}</span>
                    )}
                  </div>
                  {selectedCapture.landing_page_description && (
                    <p className="text-xs text-gray-600 line-clamp-3">{selectedCapture.landing_page_description}</p>
                  )}
                  {selectedCapture.resolved_url && (
                    <a href={selectedCapture.resolved_url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline truncate block">
                      {selectedCapture.resolved_domain || selectedCapture.resolved_url}
                    </a>
                  )}
                  {selectedCapture.landing_page_keywords && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {selectedCapture.landing_page_keywords.split(',').slice(0, 8).map((kw, i) => (
                        <span key={i} className="px-1.5 py-0.5 bg-gray-200 text-gray-600 text-xs rounded">{kw.trim()}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-gray-500">Site</dt><dd className="font-medium">{selectedCapture.site}</dd></div>
              <div><dt className="text-gray-500">Slot</dt><dd className="font-medium">{selectedCapture.ad_slot}</dd></div>
              <div className="col-span-2"><dt className="text-gray-500">Page URL</dt><dd className="font-medium truncate">{selectedCapture.page_url}</dd></div>
              {selectedCapture.destination_url && (
                <div className="col-span-2">
                  <dt className="text-gray-500">Ad Click URL</dt>
                  <dd><a href={selectedCapture.destination_url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline truncate block">{selectedCapture.destination_url}</a></dd>
                </div>
              )}
              {selectedCapture.resolved_url && selectedCapture.resolved_url !== selectedCapture.destination_url && (
                <div className="col-span-2">
                  <dt className="text-gray-500">Resolves To</dt>
                  <dd><a href={selectedCapture.resolved_url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline truncate block">{selectedCapture.resolved_url}</a></dd>
                </div>
              )}
              {(selectedCapture.resolved_domain || selectedCapture.destination_domain) && (
                <div><dt className="text-gray-500">Advertiser Domain</dt><dd className="font-medium">{selectedCapture.resolved_domain || selectedCapture.destination_domain}</dd></div>
              )}
              {selectedCapture.width && selectedCapture.height && (
                <div><dt className="text-gray-500">Size</dt><dd className="font-medium">{selectedCapture.width} × {selectedCapture.height}</dd></div>
              )}
              {selectedCapture.ad_text && (
                <div className="col-span-2"><dt className="text-gray-500">Ad Text</dt><dd className="font-medium">{selectedCapture.ad_text}</dd></div>
              )}
              <div><dt className="text-gray-500">Captured</dt><dd className="font-medium">{selectedCapture.captured_at ? formatDate(selectedCapture.captured_at) : '—'}</dd></div>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}


// ---------- App ----------
export default function App() {
  type NavState = { page: Page; filingUuid?: string; entityId?: number; newsletterId?: number; centerEntityId?: number; leaderboardType?: string; conversationId?: number; searchFilter?: { registrant?: string; client?: string; lobbyist?: string; government_entity?: string; q?: string } };

  // Build a NavState from the current browser URL hash
  const parseHash = useCallback((): NavState => {
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (!hash) return { page: 'dashboard' };
    const [segment, ...rest] = hash.split('/');
    const param = rest.join('/');
    switch (segment) {
      case 'filing': return param ? { page: 'filing', filingUuid: param } : { page: 'search' };
      case 'entity': return param ? { page: 'entity', entityId: Number(param) } : { page: 'influence' };
      case 'newsletter': return param ? { page: 'newsletter', newsletterId: Number(param) } : { page: 'influence' };
      case 'network': return param ? { page: 'network', centerEntityId: Number(param) } : { page: 'network' };
      case 'leaderboard': return param ? { page: 'leaderboard', leaderboardType: param } : { page: 'influence' };
      case 'chat': return param ? { page: 'chat', conversationId: Number(param) } : { page: 'chat' };
      case 'search': {
        if (param) {
          try { return { page: 'search', searchFilter: JSON.parse(decodeURIComponent(param)) }; } catch { /* ignore */ }
        }
        return { page: 'search' };
      }
      default: {
        const pages: Page[] = ['dashboard', 'search', 'influence', 'network', 'utilities', 'chat', 'ads'];
        if (pages.includes(segment as Page)) return { page: segment as Page };
        return { page: 'dashboard' };
      }
    }
  }, []);

  const navStateToHash = (s: NavState): string => {
    switch (s.page) {
      case 'filing': return s.filingUuid ? `#/filing/${s.filingUuid}` : '#/search';
      case 'entity': return s.entityId ? `#/entity/${s.entityId}` : '#/influence';
      case 'newsletter': return s.newsletterId ? `#/newsletter/${s.newsletterId}` : '#/influence';
      case 'network': return s.centerEntityId ? `#/network/${s.centerEntityId}` : '#/network';
      case 'leaderboard': return s.leaderboardType ? `#/leaderboard/${s.leaderboardType}` : '#/influence';
      case 'chat': return s.conversationId ? `#/chat/${s.conversationId}` : '#/chat';
      case 'search': return s.searchFilter ? `#/search/${encodeURIComponent(JSON.stringify(s.searchFilter))}` : '#/search';
      case 'dashboard': return '#/';
      default: return `#/${s.page}`;
    }
  };

  const [navState, setNavState] = useState<NavState>(parseHash);
  const [syncVersion, setSyncVersion] = useState(0);
  const isPopState = useRef(false);

  // Sync browser history when navState changes (skip for popstate-driven changes)
  useEffect(() => {
    if (isPopState.current) {
      isPopState.current = false;
      return;
    }
    const hash = navStateToHash(navState);
    if (window.location.hash !== hash) {
      window.history.pushState(navState, '', hash);
    }
  }, [navState]);

  // Listen for browser back/forward
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      isPopState.current = true;
      if (e.state && typeof e.state === 'object' && 'page' in e.state) {
        setNavState(e.state as NavState);
      } else {
        setNavState(parseHash());
      }
    };
    window.addEventListener('popstate', onPop);
    // Replace the initial history entry with state so first back works
    window.history.replaceState(navState, '', navStateToHash(navState));
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const page = navState.page;
  const filingUuid = navState.filingUuid ?? null;
  const entityId = navState.entityId ?? null;
  const newsletterId = navState.newsletterId ?? null;
  const centerEntityId = navState.centerEntityId;

  const handleNavigate = (target: Page, ctx?: unknown) => {
    const next: NavState = { page: target };
    if (target === 'filing' && typeof ctx === 'string') {
      next.filingUuid = ctx;
    } else if (target === 'newsletter' && typeof ctx === 'number') {
      next.newsletterId = ctx;
    } else if (target === 'entity' && typeof ctx === 'number') {
      next.entityId = ctx;
    } else if (target === 'network' && typeof ctx === 'number') {
      next.centerEntityId = ctx;
    } else if (target === 'leaderboard' && typeof ctx === 'string') {
      next.leaderboardType = ctx;
    } else if (target === 'chat' && typeof ctx === 'number') {
      next.conversationId = ctx;
    } else if (target === 'search' && ctx && typeof ctx === 'object') {
      next.searchFilter = ctx as NavState['searchFilter'];
    }
    setNavState(next);
  };

  const handleBack = () => {
    window.history.back();
  };

  const navPage = page === 'filing' ? 'search'
    : (page === 'entity' || page === 'newsletter' || page === 'leaderboard') ? 'influence'
    : page;

  return (
    <div className="min-h-screen">
      <Nav page={navPage} setPage={p => { setNavState({ page: p }); }} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {page === 'dashboard' && <Dashboard onNavigate={handleNavigate} />}
        {page === 'search' && <SearchPage key={JSON.stringify(navState.searchFilter ?? {})} onNavigate={handleNavigate} initialFilter={navState.searchFilter} />}

        {page === 'filing' && filingUuid && (
          <FilingDetailPage filingUuid={filingUuid} onBack={handleBack} onNavigate={handleNavigate} />
        )}
        {page === 'influence' && <InfluencePage onNavigate={handleNavigate} />}
        {page === 'newsletter' && newsletterId && (
          <NewsletterReaderPage newsletterId={newsletterId} onBack={handleBack} onNavigate={handleNavigate} />
        )}
        {page === 'network' && <NetworkMapPage onNavigate={handleNavigate} centerEntityId={centerEntityId} />}
        {page === 'entity' && entityId && (
          <EntityDetailPage entityId={entityId} onBack={handleBack} onNavigate={handleNavigate} />
        )}
        {page === 'leaderboard' && navState.leaderboardType && (
          <EntityLeaderboard entityType={navState.leaderboardType} onBack={handleBack} onNavigate={handleNavigate} />
        )}
        {page === 'ads' && <AdsPage onNavigate={handleNavigate} />}
        {page === 'reports' && <ReportsPage syncVersion={syncVersion} onNavigate={handleNavigate} />}
        {page === 'utilities' && <UtilitiesPage onSyncComplete={() => setSyncVersion(v => v + 1)} />}
        {page === 'chat' && (
          <ChatPage onNavigate={handleNavigate} initialConversationId={navState.conversationId} />
        )}
      </main>
    </div>
  );
}
