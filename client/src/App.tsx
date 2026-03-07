import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, FileText, Tag, BarChart3, RefreshCw, Building2, Users, ChevronLeft, ChevronRight, ExternalLink, DollarSign, Calendar, Loader2, Network, Newspaper, User, Briefcase, Menu, X, Download, Square, ChevronDown } from 'lucide-react';
import { api, type FilingSummary, type FilingDetail, type IssueSummary, type Stats, type SyncStatus, type SyncCoverage, type SearchParams, type TopEntity, type NewsletterSummary, type NewsletterDetail, type EntitySummary, type EntityDetail, type NetworkData, type InfluenceStats } from './api';
import { formatDistanceToNow, format } from 'date-fns';
import NetworkGraph from './NetworkGraph';

type Page = 'dashboard' | 'search' | 'issues' | 'filing' | 'influence' | 'network' | 'entity' | 'newsletter' | 'leaderboard';

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
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Politico Influence</h1>
          <p className="text-sm text-gray-500">
            {stats?.total_newsletters ? `${stats.total_newsletters} newsletters scraped` : 'No newsletters yet'}
            {stats?.latest_newsletter && ` · Latest: ${formatDate(stats.latest_newsletter)}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {scraping && scrapeProgress && (
            <span className="text-xs text-gray-500" data-testid="text-scrape-progress">
              {scrapeProgress.phase === 'discovering' ? 'Discovering archive...' :
                `${scrapeProgress.stored} stored, ${scrapeProgress.skipped} skipped${scrapeProgress.total ? ` / ${scrapeProgress.total} total` : ''}`}
            </span>
          )}
          <button
            onClick={handleScrape}
            disabled={scraping}
            className="flex items-center gap-2 bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 cursor-pointer"
            data-testid="button-scrape"
          >
            {scraping ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {scraping ? 'Scraping...' : 'Scrape Newsletters'}
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && stats.total_entities > 0 && (
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
                </div>
                <span className="text-xs text-gray-400 shrink-0 ml-2">{e.mention_count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Empty state */}
      {(!stats || stats.total_newsletters === 0) && (
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
  const [minWeight, setMinWeight] = useState(2);
  const [maxNodes, setMaxNodes] = useState(80);
  const [entityType, setEntityType] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const { width } = entries[0].contentRect;
      setDimensions({ width: Math.max(400, width), height: Math.max(400, Math.min(700, window.innerHeight - 250)) });
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
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-semibold text-gray-900 mr-auto">DC Network Map</h1>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-gray-500">Min connections:</label>
          <input
            type="range"
            min={1}
            max={10}
            value={minWeight}
            onChange={e => setMinWeight(Number(e.target.value))}
            className="w-24"
          />
          <span className="text-gray-700 w-4">{minWeight}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-gray-500">Max nodes:</label>
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
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500 px-1">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-indigo-500 inline-block"></span> Person</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-amber-500 inline-block"></span> Organization</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-slate-400 inline-block"></span> Unknown type</span>
        <span className="flex items-center gap-1"><span className="w-6 border-t-2 border-amber-400 inline-block"></span> Affiliation</span>
        <span className="flex items-center gap-1"><span className="w-6 border-t-2 border-green-400 inline-block"></span> Registration</span>
        <span className="flex items-center gap-1"><span className="w-6 border-t border-slate-300 inline-block"></span> Co-mention</span>
        <span className="ml-auto text-gray-400">Scroll to zoom · Drag nodes to rearrange · Click for details</span>
      </div>

      <div ref={containerRef}>
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
    </div>
  );
}

// ---------- Entity Detail Page ----------
function EntityDetailPage({ entityId, onBack, onNavigate }: { entityId: number; onBack: () => void; onNavigate: (page: Page, ctx?: unknown) => void }) {
  const [entity, setEntity] = useState<EntityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatingType, setUpdatingType] = useState(false);

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
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              {entity.entity_type === 'person' ? <User size={20} className="text-indigo-500" /> :
               entity.entity_type === 'organization' ? <Briefcase size={20} className="text-amber-500" /> :
               <Tag size={20} className="text-gray-400" />}
              <h1 className="text-xl font-bold text-gray-900">{entity.display_name || entity.name}</h1>
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <span>{entity.mention_count} mentions · First seen {formatDate(entity.first_seen)} · Last seen {formatDate(entity.last_seen)}</span>
            </div>
            <div className="flex items-center gap-2 mt-2">
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
            </div>
          </div>
          <button
            onClick={() => onNavigate('network', entity.id)}
            className="text-sm text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-50 cursor-pointer flex items-center gap-1"
          >
            <Network size={14} /> View in network
          </button>
        </div>
      </div>

      {/* Affiliations */}
      {affiliations.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Affiliations</h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {affiliations.map(c => (
              <button
                key={c.entity.id}
                onClick={() => onNavigate('entity', c.entity.id)}
                className="w-full text-left px-4 py-2 hover:bg-gray-50 cursor-pointer transition flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  {c.entity.entity_type === 'person' ? <User size={14} className="text-indigo-500" /> : <Briefcase size={14} className="text-amber-500" />}
                  <span className="text-sm font-medium text-gray-900">{c.entity.display_name || c.entity.name}</span>
                </div>
                <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">{c.weight}x</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Co-mentions */}
      {registrations.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Lobbying Registrations</h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {registrations.map(c => (
              <button
                key={c.entity.id}
                onClick={() => onNavigate('entity', c.entity.id)}
                className="w-full text-left px-4 py-2 hover:bg-gray-50 cursor-pointer transition flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <Briefcase size={14} className="text-green-500" />
                  <span className="text-sm font-medium text-gray-900">{c.entity.display_name || c.entity.name}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${c.relationship_type === 'lobbying_termination' ? 'text-red-600 bg-red-50' : 'text-green-600 bg-green-50'}`}>
                  {c.relationship_type === 'lobbying_termination' ? 'Terminated' : 'Registered'}
                </span>
              </button>
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
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-900">{m.newsletter_title}</span>
                  <span className="text-xs text-gray-400">{formatDate(m.published_date)}</span>
                </div>
                <p className="text-xs text-gray-600 line-clamp-2">{m.context}</p>
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
    const regex = new RegExp(`\\b(${escapedNames.join('|')})\\b`, 'gi');
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

  const knownSectionHeadings = ['jobs report'];
  const sectionHeadingRe = /^([A-Z][A-Z\s'\u2019&,\-]+(?::|(?=\s?\u2014)))\s*\u2014?\s*/;

  const paragraphs = newsletter.body_text.split('\n\n').filter(p => p.trim().length > 0);

  const renderParagraph = (para: string, i: number) => {
    if (knownSectionHeadings.includes(para.trim().toLowerCase())) {
      return (
        <div key={i} data-testid={`text-paragraph-${i}`}>
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide mt-5 mb-1 pt-3 border-t border-gray-100">{para.trim()}</h3>
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
          {paragraphs.map((para, i) => renderParagraph(para, i))}
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
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-gray-900 truncate block">{e.display_name || e.name}</span>
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


// ---------- App ----------
export default function App() {
  type NavState = { page: Page; filingUuid?: string; entityId?: number; newsletterId?: number; centerEntityId?: number; leaderboardType?: string };
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
      </main>
    </div>
  );
}
