import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Clock3, Loader2, RefreshCw, Search, ShieldOff, Trash2,
} from "lucide-react";
import type { RejectLogEntry } from "@app/shared";
import { clearRejectLog, listRejectLog } from "../api/endpoints";
import { ApiCallError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { PageHelp } from "../components/PageHelp";

// Reason → colour
function reasonBadge(reason: string) {
  if (reason.includes("blocked"))  return "border-slate-500/20 bg-slate-500/10  text-slate-300";
  if (reason.includes("rejected")) return "border-rose-500/20  bg-rose-500/10   text-rose-200";
  if (reason.includes("pending"))  return "border-amber-500/20 bg-amber-500/10  text-amber-200";
  if (reason.includes("Unknown"))  return "border-orange-500/20 bg-orange-500/10 text-orange-200";
  if (reason.includes("Unregist")) return "border-violet-500/20 bg-violet-500/10 text-violet-200";
  return "border-rose-500/20 bg-rose-500/10 text-rose-200";
}

function fmt(iso: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function fmtDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
}

function fmtTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date(iso));
}

export function LiveRejectLogView() {
  const { token } = useAuth();
  const [entries,      setEntries]      = useState<RejectLogEntry[]>([]);
  const [total,        setTotal]        = useState(0);
  const [page,         setPage]         = useState(1);
  const [query,        setQuery]        = useState("");
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing,     setClearing]     = useState(false);

  const PAGE_SIZE = 50;

  const load = useCallback(async (p = page, q = query) => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const res = await listRejectLog(token, { page: p, pageSize: PAGE_SIZE, search: q || undefined });
      setEntries(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiCallError ? err.payload.message : "Failed to load reject log");
    } finally {
      setLoading(false);
    }
  }, [page, query, token]);

  useEffect(() => { void load(); }, [load]);

  const handleSearch = (v: string) => {
    setQuery(v); setPage(1); void load(1, v);
  };

  const handleClear = async () => {
    if (!token) return;
    setClearing(true); setError(null);
    try {
      const res = await clearRejectLog(token);
      setEntries([]); setTotal(0); setPage(1); setConfirmClear(false);
      setError(`✓ Cleared ${res.deleted} rejection record${res.deleted !== 1 ? "s" : ""}.`);
    } catch (err) {
      setError(err instanceof ApiCallError ? err.payload.message : "Failed to clear history");
    } finally { setClearing(false); }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-white lg:text-2xl">
              Access-Reject Log
            </h2>
            <PageHelp
              title="Access-Reject Log"
              description="Every failed RADIUS authentication attempt logged by FreeRADIUS. Shows who tried to connect, from which device, and why they were rejected. Passwords are never stored or shown."
              tips={[
                "Unknown username — no account exists with that name",
                "Unregistered device — user exists but this MAC was never seen before",
                "Device pending — MAC was seen before but admin hasn't approved it yet",
                "Device rejected/blocked — admin explicitly denied this device",
                "Authentication failed — wrong password or invalid certificate",
              ]}
            />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {total.toLocaleString()} total rejection{total !== 1 ? "s" : ""} recorded
            {" · "}passwords are never logged
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-[20px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/[0.08] hover:text-white">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>

          {!confirmClear ? (
            <button onClick={() => setConfirmClear(true)}
              className="inline-flex items-center gap-2 rounded-[20px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-400 transition hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-300">
              <Trash2 className="h-4 w-4" />
              Clear history
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button onClick={() => void handleClear()} disabled={clearing}
                className="inline-flex items-center gap-2 rounded-[20px] bg-rose-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:opacity-60">
                {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {clearing ? "Clearing…" : "Confirm clear"}
              </button>
              <button onClick={() => setConfirmClear(false)}
                className="rounded-[20px] border border-white/8 px-4 py-3 text-sm text-slate-400 hover:bg-white/[0.05]">
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-[24px] border border-rose-500/20 bg-rose-500/10 px-4 py-4 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="app-card-dark overflow-hidden p-4">
        {/* Search bar */}
        <div className="border-b border-white/6 pb-4">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input value={query} onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search username or MAC…"
              className="w-full rounded-[18px] border border-white/8 bg-slate-950/70 py-2.5 pl-9 pr-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-400/40" />
          </div>
        </div>

        {/* Mobile cards */}
        <div className="mt-4 space-y-3 lg:hidden">
          {loading && (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
            </div>
          )}
          {!loading && entries.map((e) => (
            <div key={e.id} className="rounded-[22px] border border-white/6 bg-white/[0.03] px-4 py-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-rose-500/10 text-rose-300">
                  <ShieldOff className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  {/* Username + reason */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-white">{e.username}</span>
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${reasonBadge(e.reason)}`}>
                      <AlertTriangle className="h-2.5 w-2.5" />{e.reason}
                    </span>
                  </div>
                  {/* MAC */}
                  {e.mac && (
                    <div className="mt-1 font-mono text-xs uppercase tracking-wide text-slate-500">{e.mac}</div>
                  )}
                  {/* Date/time */}
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
                    <Clock3 className="h-3.5 w-3.5 flex-shrink-0" />
                    {fmt(e.authDate)}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {!loading && entries.length === 0 && (
            <div className="rounded-[24px] border border-dashed border-white/8 bg-white/[0.03] px-4 py-10 text-center text-sm text-slate-500">
              No rejections recorded yet.
            </div>
          )}
        </div>

        {/* Desktop table */}
        <div className="mt-4 hidden overflow-x-auto lg:block">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="text-left text-[11px] uppercase tracking-[0.24em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Date · Time</th>
                <th className="px-4 py-3 font-medium">Username</th>
                <th className="px-4 py-3 font-medium">MAC address</th>
                <th className="px-4 py-3 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6">
              {loading && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />
                  </td>
                </tr>
              )}
              {!loading && entries.map((e) => (
                <tr key={e.id} className="align-middle transition hover:bg-white/[0.03]">
                  <td className="px-4 py-3.5 text-xs">
                    <div className="font-medium text-slate-300">{fmtDate(e.authDate)}</div>
                    <div className="mt-0.5 text-slate-500">{fmtTime(e.authDate)}</div>
                  </td>
                  <td className="px-4 py-3.5 font-mono text-sm text-slate-200">
                    {e.username}
                  </td>
                  <td className="px-4 py-3.5 font-mono text-xs uppercase tracking-wide text-slate-400">
                    {e.mac ?? <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${reasonBadge(e.reason)}`}>
                      <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                      {e.reason}
                    </span>
                  </td>
                </tr>
              ))}
              {!loading && entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-500">
                    No rejection records found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-white/6 pt-4 text-sm text-slate-400">
            <span>Page {page} of {totalPages} · {total} total</span>
            <div className="flex gap-2">
              <button onClick={() => { setPage(p => p - 1); void load(page - 1); }}
                disabled={page <= 1}
                className="rounded-[14px] border border-white/8 px-3 py-2 text-xs hover:bg-white/[0.05] disabled:opacity-40">
                Previous
              </button>
              <button onClick={() => { setPage(p => p + 1); void load(page + 1); }}
                disabled={page >= totalPages}
                className="rounded-[14px] border border-white/8 px-3 py-2 text-xs hover:bg-white/[0.05] disabled:opacity-40">
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-[24px] border border-white/6 bg-white/[0.03] px-4 py-4 text-sm text-slate-500">
        Sourced directly from <code className="text-slate-400">radpostauth</code> — written by FreeRADIUS on every authentication attempt.
        Passwords are <strong className="text-slate-300">never</strong> stored or displayed.
      </div>
    </div>
  );
}
