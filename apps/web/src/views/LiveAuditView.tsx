import { useEffect, useState } from "react";
import { FileText, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import type { AuthenticationEvent, AuditLogEntry } from "@app/shared";
import { clearAuditLogs, listAuditLogs, listAuthenticationEvents } from "../api/endpoints";
import { ApiCallError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { PageHelp } from "../components/PageHelp";

export function LiveAuditView() {
  const { token } = useAuth();
  const [tab,          setTab]          = useState<"audit" | "auth">("audit");
  const [auditLogs,    setAuditLogs]    = useState<AuditLogEntry[]>([]);
  const [authEvents,   setAuthEvents]   = useState<AuthenticationEvent[]>([]);
  const [error,        setError]        = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing,     setClearing]     = useState(false);

  const load = () => {
    if (!token) return;
    Promise.all([listAuditLogs(token), listAuthenticationEvents(token)])
      .then(([audit, auth]) => {
        setAuditLogs(audit.items);
        setAuthEvents(auth.items);
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClear = async () => {
    if (!token) return;
    setClearing(true); setError(null);
    try {
      const res = await clearAuditLogs(token);
      setAuditLogs([]); setConfirmClear(false);
      setError(`✓ Cleared ${res.deleted} audit record${res.deleted !== 1 ? "s" : ""}.`);
    } catch (err) {
      setError(err instanceof ApiCallError ? err.payload.message : "Failed to clear audit log");
    } finally { setClearing(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="theme-text-primary text-xl font-semibold">Audit & Authentication</h2>
            <PageHelp title="Audit Log" description="Immutable record of every admin action: user creation, password resets, group policy changes, session disconnects, NAS modifications, and login events. Each entry records who performed the action, what changed, the source IP, and the timestamp." tips={["Audit records cannot be deleted or modified through the UI", "RADIUS authentication events (accept/reject per user) are stored separately in radpostauth", "Use the search and date filters to trace specific incidents or compliance requirements"]} />
          </div>
          <p className="theme-text-muted mt-0.5 text-sm">Administrative changes and RADIUS/web access outcomes</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Tab switcher */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-1 flex">
            <button onClick={() => setTab("audit")} className={`px-3 py-2 text-xs rounded-md ${tab === "audit" ? "bg-indigo-600 text-white" : "text-zinc-400"}`}>Audit log</button>
            <button onClick={() => setTab("auth")}  className={`px-3 py-2 text-xs rounded-md ${tab === "auth"  ? "bg-indigo-600 text-white" : "text-zinc-400"}`}>Auth events</button>
          </div>

          {/* Clear history — two-step confirm */}
          {tab === "audit" && (
            !confirmClear ? (
              <button onClick={() => setConfirmClear(true)}
                className="inline-flex items-center gap-2 rounded-[18px] border border-white/8 bg-white/[0.04] px-3 py-2.5 text-xs font-medium text-slate-400 transition hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-300">
                <Trash2 className="h-3.5 w-3.5" />Clear history
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button onClick={() => void handleClear()} disabled={clearing}
                  className="inline-flex items-center gap-1.5 rounded-[18px] bg-rose-600 px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-60">
                  {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {clearing ? "Clearing…" : "Confirm clear"}
                </button>
                <button onClick={() => setConfirmClear(false)}
                  className="rounded-[18px] border border-white/8 px-3 py-2.5 text-xs text-slate-400 hover:bg-white/[0.05]">
                  Cancel
                </button>
              </div>
            )
          )}
        </div>
      </div>
      {error && <div className="text-rose-300 border border-rose-900 rounded-lg px-4 py-3 text-sm">{error}</div>}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
        {tab === "audit" && auditLogs.map((entry) => (
          <div key={entry.id} className="px-5 py-4 flex gap-4 items-center">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/10 flex items-center justify-center"><FileText className="w-4 h-4 text-indigo-400" /></div>
            <div className="flex-1">
              <div className="text-sm text-zinc-100">
                <span className="font-medium">{entry.actor || "system"}</span>
                <span className="mx-2 text-zinc-600">/</span>
                <span className="font-mono text-xs text-indigo-400">{entry.action}</span>
                <span className="mx-2 text-zinc-600">/</span>
                <span className="text-zinc-300">{entry.targetType}{entry.targetId ? ` ${entry.targetId}` : ""}</span>
              </div>
              <div className="text-xs text-zinc-500 mt-1">{entry.ip || "no IP recorded"}</div>
            </div>
            <time className="text-xs text-zinc-500">{new Date(entry.createdAt).toLocaleString()}</time>
          </div>
        ))}
        {tab === "auth" && authEvents.map((entry) => (
          <div key={entry.id} className="px-5 py-4 flex gap-4 items-center">
            <div className="w-9 h-9 rounded-lg bg-sky-500/10 flex items-center justify-center"><ShieldAlert className="w-4 h-4 text-sky-400" /></div>
            <div className="flex-1">
              <div className="text-sm text-zinc-100 font-medium">{entry.username}</div>
              <div className="text-xs text-zinc-500 mt-1">{entry.source} / {entry.type}</div>
            </div>
            <time className="text-xs text-zinc-500">{new Date(entry.createdAt).toLocaleString()}</time>
          </div>
        ))}
        {tab === "audit" && auditLogs.length === 0 && <div className="p-8 text-center text-sm text-zinc-500">No audit activity recorded.</div>}
        {tab === "auth" && authEvents.length === 0 && <div className="p-8 text-center text-sm text-zinc-500">No authentication events recorded.</div>}
      </div>
    </div>
  );
}
