import { useState, useEffect, useCallback } from 'react';
import { Search, FileText, Tag, BarChart3, RefreshCw, Building2, Users, ChevronLeft, ChevronRight, ExternalLink, DollarSign, Calendar, Loader2 } from 'lucide-react';
import { api, type FilingSummary, type FilingDetail, type IssueSummary, type Stats, type SyncStatus, type SearchParams, type TopEntity } from './api';
import { formatDistanceToNow, format } from 'date-fns';

type Page = 'dashboard' | 'search' | 'issues' | 'filing';

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
  const links: { id: Page; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 size={18} /> },
    { id: 'search', label: 'Search', icon: <Search size={18} /> },
    { id: 'issues', label: 'Issues', icon: <Tag size={18} /> },
  ];
  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center h-14 gap-6">
        <button onClick={() => setPage('dashboard')} className="flex items-center gap-2 font-bold text-indigo-700 text-lg shrink-0 cursor-pointer">
          <FileText size={22} /> LDA Tracker
        </button>
        <nav className="flex gap-1">
          {links.map(l => (
            <button
              key={l.id}
              onClick={() => setPage(l.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition cursor-pointer ${page === l.id ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              {l.icon} {l.label}
            </button>
          ))}
        </nav>
      </div>
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r, tr, tc, ss] = await Promise.all([
        api.getStats(),
        api.searchFilings({ sort: '-dt_posted', page_size: 10 }),
        api.getTopRegistrants(10),
        api.getTopClients(10),
        api.getSyncStatus(),
      ]);
      setStats(s);
      setRecent(r.results);
      setTopRegistrants(tr);
      setTopClients(tc);
      setSyncStatus(ss);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const currentYear = new Date().getFullYear();
      await api.triggerSync({ filing_year: currentYear, max_pages: 20, page_size: 25 });
      // Poll for completion
      const poll = setInterval(async () => {
        const s = await api.getSyncStatus();
        setSyncStatus(s);
        if (s.status !== 'running') {
          clearInterval(poll);
          setSyncing(false);
          load();
        }
      }, 3000);
    } catch (e) {
      console.error(e);
      setSyncing(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>;

  return (
    <div className="space-y-6">
      {/* Sync bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">
            {stats?.total_filings ? `${stats.total_filings.toLocaleString()} filings stored` : 'No filings synced yet'}
            {stats?.latest_filing && ` \u00b7 Latest: ${formatDate(stats.latest_filing)}`}
          </p>
          {syncStatus && syncStatus.status !== 'idle' && (
            <p className="text-xs text-gray-400 mt-0.5">
              Last sync: {syncStatus.status}{syncStatus.stored ? ` (${syncStatus.stored} stored)` : ''}
            </p>
          )}
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 cursor-pointer"
        >
          {syncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          {syncing ? 'Syncing...' : 'Sync Latest Filings'}
        </button>
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
      {recent.length > 0 && (
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
          <p className="text-gray-500 mb-4">Click "Sync Latest Filings" to pull recent lobbying disclosures from the Senate LDA API.</p>
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

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-400 text-xs uppercase">Year / Period</p>
            <p className="font-medium">{filing.filing_year} {filing.filing_period_display}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase">Date Posted</p>
            <p className="font-medium">{formatDate(filing.dt_posted)}</p>
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

// ---------- App ----------
export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [filingUuid, setFilingUuid] = useState<string | null>(null);
  const [prevPage, setPrevPage] = useState<Page>('dashboard');

  const handleNavigate = (target: Page, ctx?: unknown) => {
    if (target === 'filing' && typeof ctx === 'string') {
      setPrevPage(page);
      setFilingUuid(ctx);
      setPage('filing');
    } else {
      setPage(target);
    }
  };

  return (
    <div className="min-h-screen">
      <Nav page={page === 'filing' ? prevPage : page} setPage={p => { setPage(p); setFilingUuid(null); }} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {page === 'dashboard' && <Dashboard onNavigate={handleNavigate} />}
        {page === 'search' && <SearchPage onNavigate={handleNavigate} />}
        {page === 'issues' && <IssuesPage onNavigate={handleNavigate} />}
        {page === 'filing' && filingUuid && (
          <FilingDetailPage filingUuid={filingUuid} onBack={() => { setPage(prevPage); setFilingUuid(null); }} />
        )}
      </main>
    </div>
  );
}
