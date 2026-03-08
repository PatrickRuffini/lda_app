import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, FileText, Tag, BarChart3, RefreshCw, Building2, Users, ChevronLeft, ChevronRight, ExternalLink, DollarSign, Calendar, Loader2, Network, Newspaper, User, Briefcase, Menu, X, Download, Square, ChevronDown, Target, Sparkles, Send, MessageCircle, Bot, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { api, type FilingSummary, type FilingDetail, type IssueSummary, type Stats, type SyncStatus, type SyncCoverage, type SearchParams, type TopEntity, type NewsletterSummary, type NewsletterDetail, type EntitySummary, type EntityDetail, type NetworkData, type InfluenceStats } from './api';
import { formatDistanceToNow, format } from 'date-fns';
import NetworkGraph, { computeEigenvectorCentrality, type SizeMode } from './NetworkGraph';

type Page = 'dashboard' | 'search' | 'issues' | 'filing' | 'influence' | 'network' | 'entity' | 'newsletter' | 'leaderboard' | 'chat';

function formatMoney(val: number | null | undefined): string {
  if (val === null || val === undefined) return '-';
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
    { id: 'issues', label: 'Issues', icon: <Tag size={18} /> },
    { id: 'influence', label: 'Influence', icon: <Newspaper size={18} /> },
    { id: 'network', label: 'Network', icon: <Network size={18} /> },
    { id: 'chat', label: 'AI Chat', icon: <Bot size={18} /> },
  ];
  const handleNav = (p: Page) => { setPage(p); setMobileOpen(false); };
  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center h-14 gap-6">
        <button onClick={() => handleNav('dashboard')} data-testid="link-home" className="flex items-center gap-2 font-bold text-indigo-700 text-lg shrink-0 cursor-pointer">
          <FileText size={22} /> LDA Tracker
        </button>
        <nav className="hidden md:flex gap-1">
          {links.map(l => (
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
          {links.map(l => (
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
          <span className="flex items-center gap-1"><DollarSign size={12} />{formatMoney(filing.income)}</span>
        )}
        {filing.expenses != null && filing.expenses > 0 && (
          <span className="flex items-center gap-1 text-orange-600"><DollarSign size={12} />{formatMoney(filing.expenses)} exp.</span>
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

// ---------- Dashboard ----------
function Dashboard({ onNavigate }: { onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<FilingSummary[]>([]);
  const [topRegistrants, setTopRegistrants] = useState<TopEntity[]>([]);
  const [topClients, setTopClients] = useState<TopEntity[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (retry = 0) => {
    setLoading(true);
    try {
      api.getStats().then(setStats).catch(console.error);
      api.getSyncStatus().then(ss => { setSyncStatus(ss); if (ss.status === 'running') setSyncing(true); }).catch(console.error);
      const [r, tr, tc] = await Promise.all([
        api.searchFilings({ sort: '-dt_posted', page_size: 10 }),
        api.getTopRegistrants(10),
        api.getTopClients(10),
      ]);
      setRecent(r.results);
      setTopRegistrants(tr);
      setTopClients(tc);
      setLoading(false);
    } catch (e) {
      console.error(e);
      setLoading(false);
      if (retry < 3) setTimeout(() => load(retry + 1), 2000);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
            load();
          }
        } catch (e) { console.error(e); }
      }, 2000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [syncing, load]);

  const handleSync = async (mode: string) => {
    setSyncing(true);
    try {
      await api.triggerSync({ mode });
    } catch (e) {
      console.error(e);
      setSyncing(false);
    }
  };

  const handleCancel = async () => {
    try { await api.cancelSync(); } catch (e) { console.error(e); }
  };

  const syncRunning = syncing || syncStatus?.status === 'running';

  return (
    <div className="space-y-6">
      {/* Sync bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-sm text-gray-700 font-medium" data-testid="text-filing-count">
              {stats === null ? <span className="text-gray-400">Loading...</span> : stats.total_filings ? `${stats.total_filings.toLocaleString()} filings stored` : 'No filings synced yet'}
              {stats?.latest_filing && ` · Latest: ${formatDate(stats.latest_filing)}`}
            </p>
            {syncStatus && syncStatus.status !== 'idle' && (
              <p className="text-xs text-gray-400 mt-0.5" data-testid="text-sync-status">
                {syncStatus.status === 'running' && syncStatus.mode === 'incremental' && (
                  <>Fetching new filings… {syncStatus.stored || 0} stored, page {syncStatus.pages || 0}</>
                )}
                {syncStatus.status === 'running' && syncStatus.mode === 'backfill' && (
                  <>Backfilling {syncStatus.current_year || '…'} — {syncStatus.stored?.toLocaleString() || 0} stored, {syncStatus.years_completed?.length || 0} years done</>
                )}
                {syncStatus.status === 'cancelling' && 'Cancelling…'}
                {syncStatus.status === 'completed' && (
                  <>Completed: {syncStatus.stored?.toLocaleString() || 0} new filings{syncStatus.duplicates ? `, ${syncStatus.duplicates.toLocaleString()} already had` : ''}</>
                )}
                {syncStatus.status === 'cancelled' && (
                  <>Cancelled: {syncStatus.stored?.toLocaleString() || 0} filings stored before stopping</>
                )}
                {syncStatus.status === 'error' && <>Error: {syncStatus.error}</>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {syncRunning ? (
              <button
                onClick={handleCancel}
                data-testid="button-cancel-sync"
                className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 cursor-pointer"
              >
                <Square size={14} /> Stop
              </button>
            ) : (
              <>
                <button
                  onClick={() => handleSync('incremental')}
                  data-testid="button-sync-incremental"
                  className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 cursor-pointer"
                >
                  <RefreshCw size={16} /> Sync New
                </button>
                <button
                  onClick={() => handleSync('backfill')}
                  data-testid="button-sync-backfill"
                  className="flex items-center gap-2 bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 cursor-pointer"
                >
                  <Download size={16} /> Backfill All
                </button>
              </>
            )}
          </div>
        </div>
        {syncRunning && (
          <div className="mt-3">
            <div className="w-full bg-gray-200 rounded-full h-1.5">
              <div className="bg-indigo-600 h-1.5 rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
          </div>
        )}
      </div>

      {/* Stats cards */}
      {stats && stats.total_filings > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
        </div>
      )}

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

      {/* Top registrants & clients */}
      {(topRegistrants.length > 0 || topClients.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {topRegistrants.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2"><Building2 size={16} /> Top Registrants</h3>
              <div className="space-y-2">
                {topRegistrants.map((r, i) => (
                  <div key={r.senate_id} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700 truncate"><span className="text-gray-400 mr-2">{i + 1}.</span>{r.name}</span>
                    <span className="text-gray-500 shrink-0 ml-2">{r.filing_count} filings</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {topClients.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2"><Users size={16} /> Top Clients</h3>
              <div className="space-y-2">
                {topClients.map((c, i) => (
                  <div key={c.senate_id} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700 truncate"><span className="text-gray-400 mr-2">{i + 1}.</span>{c.name}</span>
                    <span className="text-gray-500 shrink-0 ml-2">{c.filing_count} filings</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {stats && stats.total_filings === 0 && (
        <div className="text-center py-16">
          <FileText size={48} className="mx-auto text-gray-300 mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">No filings yet</h2>
          <p className="text-gray-500 mb-4">Click "Sync New" to grab the latest filings, or "Backfill All" to download the complete historical archive (1999–present, ~1.9M filings).</p>
        </div>
      )}
    </div>
  );
}

// ---------- Search Page ----------
function SearchPage({ onNavigate }: { onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [params, setParams] = useState<SearchParams>({ sort: '-dt_posted', page: 1, page_size: 25 });
  const [results, setResults] = useState<FilingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    api.getIssues().then(setIssues).catch(() => {});
  }, []);

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setParams(p => ({ ...p, q: searchText || undefined, page: 1 }));
  };

  return (
    <div className="space-y-4">
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
          <select
            value={params.issue_code || ''}
            onChange={e => setParams(p => ({ ...p, issue_code: e.target.value || undefined, page: 1 }))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm cursor-pointer"
          >
            <option value="">All Issues</option>
            {issues.map(i => (
              <option key={i.code} value={i.code}>{i.display} ({i.count})</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Registrant name"
            value={params.registrant || ''}
            onChange={e => setParams(p => ({ ...p, registrant: e.target.value || undefined, page: 1 }))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-40"
          />
          <input
            type="text"
            placeholder="Client name"
            value={params.client || ''}
            onChange={e => setParams(p => ({ ...p, client: e.target.value || undefined, page: 1 }))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-40"
          />
        </div>
      </form>

      {loading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="animate-spin text-indigo-600" size={24} /></div>
      ) : results.length > 0 ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {results.map(f => (
              <FilingCard key={f.filing_uuid} filing={f} onClick={() => onNavigate('filing', f.filing_uuid)} />
            ))}
          </div>
          <Pagination page={params.page || 1} pageSize={params.page_size || 25} total={total} onPage={p => setParams(prev => ({ ...prev, page: p }))} />
        </>
      ) : (
        <div className="text-center py-12 text-gray-500">
          <Search size={32} className="mx-auto mb-3 text-gray-300" />
          <p>No filings found. Try adjusting your filters or sync some data first.</p>
        </div>
      )}
    </div>
  );
}

// ---------- Issues Page ----------
function IssuesPage({ onNavigate }: { onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filings, setFilings] = useState<FilingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [issuePage, setIssuePage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getIssues().then(i => { setIssues(i); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) { setFilings([]); return; }
    api.getFilingsByIssue(selected, issuePage).then(r => { setFilings(r.results); setTotal(r.total); });
  }, [selected, issuePage]);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div className="md:col-span-1">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Issue Areas</h2>
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
          {issues.length === 0 && <p className="p-4 text-sm text-gray-400">No issues found. Sync filings first.</p>}
          {issues.map(i => (
            <button
              key={i.code}
              onClick={() => { setSelected(i.code); setIssuePage(1); }}
              className={`w-full text-left px-4 py-2.5 text-sm flex items-center justify-between cursor-pointer transition ${selected === i.code ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
            >
              <span className="truncate">{i.display}</span>
              <span className="text-xs text-gray-400 ml-2 shrink-0">{i.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="md:col-span-2">
        {selected ? (
          <>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">
              {issues.find(i => i.code === selected)?.display} <span className="text-sm font-normal text-gray-400">({total} filings)</span>
            </h2>
            <div className="space-y-3">
              {filings.map(f => (
                <FilingCard key={f.filing_uuid} filing={f} onClick={() => onNavigate('filing', f.filing_uuid)} />
              ))}
            </div>
            <Pagination page={issuePage} pageSize={25} total={total} onPage={setIssuePage} />
          </>
        ) : (
          <div className="flex items-center justify-center h-64 text-gray-400">
            <p>Select an issue area to view filings</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Filing Detail ----------
function FilingDetailPage({ filingUuid, onBack }: { filingUuid: string; onBack: () => void }) {
  const [filing, setFiling] = useState<FilingDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getFiling(filingUuid).then(f => { setFiling(f); setLoading(false); }).catch(() => setLoading(false));
  }, [filingUuid]);

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
            <h1 className="text-xl font-bold text-gray-900">{filing.client?.name || 'Unknown Client'}</h1>
            <p className="text-gray-500">Filed by {filing.registrant?.name || 'Unknown Registrant'}</p>
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
            <p className="text-sm font-medium">{filing.registrant_detail.name}</p>
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
            <p className="text-sm font-medium">{filing.client_detail.name}</p>
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
                          <p key={j} className="text-sm text-gray-700">
                            {name}{l.covered_position ? <span className="text-gray-400 ml-1">({l.covered_position})</span> : ''}
                          </p>
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
  const [scraping, setScraping] = useState(false);

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

  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<{ processed?: number; total?: number } | null>(null);

  const handleReprocess = async () => {
    if (!confirm('Re-run classification on all newsletters? This keeps existing entities but rebuilds all relationships. This may take a few minutes.')) return;
    setReprocessing(true);
    setReprocessProgress(null);
    try {
      await api.reprocessEntities();
      const poll = setInterval(async () => {
        try {
          const p = await api.getReprocessStatus();
          if (p.status === 'running') {
            setReprocessProgress({ processed: p.processed, total: p.total });
          }
          if (p.status === 'done' || p.status === 'error') {
            clearInterval(poll);
            setReprocessProgress(null);
            setReprocessing(false);
            load();
          }
        } catch {}
      }, 2000);
    } catch (err) {
      console.error(err);
      setReprocessing(false);
      setReprocessProgress(null);
    }
  };

  const [scrapeProgress, setScrapeProgress] = useState<any>(null);

  const handleScrape = async () => {
    setScraping(true);
    setScrapeProgress(null);
    try {
      await api.triggerInfluenceScrape({ max_newsletters: 100, max_discovery_pages: 10 });
      const poll = setInterval(async () => {
        const s = await api.getInfluenceScrapeStatus();
        if (s.status === 'running' && s.progress) {
          setScrapeProgress(s.progress);
        }
        if (s.status !== 'running') {
          clearInterval(poll);
          setScraping(false);
          setScrapeProgress(null);
          load();
        }
      }, 3000);
    } catch (err) {
      console.error(err);
      setScraping(false);
      setScrapeProgress(null);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>;

  return (
    <div className="space-y-6">
      {/* Header with scrape button */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Politico Influence</h1>
            <p className="text-sm text-gray-500">
              {stats?.total_newsletters ? `${stats.total_newsletters} newsletters scraped` : 'No newsletters yet'}
              {stats?.latest_newsletter && ` · Latest: ${formatDate(stats.latest_newsletter)}`}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {scraping && scrapeProgress && (
              <span className="text-xs text-gray-500" data-testid="text-scrape-progress">
                {scrapeProgress.phase === 'discovering' ? 'Discovering archive...' :
                  `${scrapeProgress.stored} stored, ${scrapeProgress.skipped} skipped${scrapeProgress.total ? ` / ${scrapeProgress.total} total` : ''}`}
              </span>
            )}
            <button
              onClick={handleScrape}
              disabled={scraping || reprocessing}
              className="flex items-center justify-center gap-2 bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 cursor-pointer"
              data-testid="button-scrape"
            >
              {scraping ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              {scraping ? 'Scraping...' : 'Scrape Newsletters'}
            </button>
            <button
              onClick={handleReprocess}
              disabled={reprocessing || scraping}
              className="flex items-center justify-center gap-2 border border-amber-600 text-amber-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-50 disabled:opacity-50 cursor-pointer"
              data-testid="button-reprocess"
              title="Re-run classification: keeps entities, rebuilds all relationships"
            >
              {reprocessing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              {reprocessing ? 'Reprocessing...' : 'Re-run Classification'}
            </button>
          </div>
        </div>
        {reprocessing && reprocessProgress && reprocessProgress.total && reprocessProgress.total > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-gray-600">Reprocessing newsletters...</span>
              <span className="text-xs text-gray-500">{reprocessProgress.processed ?? 0} / {reprocessProgress.total}</span>
            </div>
            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500 rounded-full transition-all duration-500"
                style={{ width: `${Math.round(((reprocessProgress.processed ?? 0) / reprocessProgress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}
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
                  {e.is_consultant && <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0 text-blue-700 bg-blue-50">Consultant</span>}
                  {e.is_client && <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0 text-emerald-700 bg-emerald-50">Client</span>}
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


// ---------- App ----------
export default function App() {
  type NavState = { page: Page; filingUuid?: string; entityId?: number; newsletterId?: number; centerEntityId?: number; leaderboardType?: string; conversationId?: number };
  const [navState, setNavState] = useState<NavState>({ page: 'dashboard' });
  const [navHistory, setNavHistory] = useState<NavState[]>([]);

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
    }
    setNavHistory(h => [...h, navState]);
    setNavState(next);
  };

  const handleBack = () => {
    setNavHistory(h => {
      const copy = [...h];
      const prev = copy.pop();
      if (prev) {
        setNavState(prev);
        return copy;
      }
      setNavState({ page: 'dashboard' });
      return [];
    });
  };

  const navPage = (page === 'filing' || page === 'entity' || page === 'newsletter' || page === 'leaderboard')
    ? (navHistory.length > 0 ? navHistory[navHistory.length - 1].page : 'dashboard')
    : page;

  return (
    <div className="min-h-screen">
      <Nav page={navPage} setPage={p => { setNavHistory([]); setNavState({ page: p }); }} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {page === 'dashboard' && <Dashboard onNavigate={handleNavigate} />}
        {page === 'search' && <SearchPage onNavigate={handleNavigate} />}
        {page === 'issues' && <IssuesPage onNavigate={handleNavigate} />}
        {page === 'filing' && filingUuid && (
          <FilingDetailPage filingUuid={filingUuid} onBack={handleBack} />
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
        {page === 'chat' && (
          <ChatPage onNavigate={handleNavigate} initialConversationId={navState.conversationId} />
        )}
      </main>
    </div>
  );
}
