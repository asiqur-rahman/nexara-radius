import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import type { UserImportResult } from "@app/shared";
import { ApiCallError } from "../api/client";
import { downloadUsersImportTemplate, importUsers } from "../api/endpoints";
import { useTheme } from "../theme/ThemeContext";

type ImportMode = "create" | "upsert";

interface Props {
  token: string;
  onClose: () => void;
  onDone: (result: UserImportResult) => void;
}

export function UserImportDrawer({ token, onClose, onDone }: Props) {
  const { isWhiteTheme: light } = useTheme();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("create");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UserImportResult | null>(null);
  const [result, setResult] = useState<UserImportResult | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const rowCount = useMemo(() => {
    if (!csv.trim()) return 0;
    const lines = csv.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim());
    return Math.max(0, lines.length - 1);
  }, [csv]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type && !file.type.includes("csv") && file.type !== "text/plain") {
      setError("Please choose a .csv file");
      return;
    }
    if (file.size > 2_000_000) {
      setError("CSV file is too large (max 2 MB)");
      return;
    }
    setError(null);
    setPreview(null);
    setResult(null);
    setFileName(file.name);
    setCsv(await file.text());
  };

  const run = async (dryRun: boolean) => {
    if (!csv.trim()) {
      setError("Choose a CSV file first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await importUsers(token, { csv, mode, dryRun });
      if (dryRun) {
        setPreview(r);
        setResult(null);
      } else {
        setResult(r);
        setPreview(null);
        onDone(r);
      }
    } catch (err) {
      setError(
        err instanceof ApiCallError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Import failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const panel = light
    ? "border-slate-200 bg-white text-slate-950"
    : "border-white/8 bg-slate-950 text-white";
  const muted = light ? "text-slate-600" : "text-slate-400";
  const soft = light ? "border-slate-200 bg-slate-50" : "border-white/8 bg-white/[0.03]";

  const summary = result ?? preview;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm" onClick={onClose} />
      <aside
        className={`fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] flex-col overflow-hidden rounded-t-[28px] border shadow-2xl sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-full sm:max-w-[560px] sm:rounded-none sm:border-l ${panel}`}
      >
        <div className={`flex items-start justify-between gap-3 border-b px-5 py-4 ${light ? "border-slate-200" : "border-white/8"}`}>
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">Bulk users</div>
            <h3 className="mt-1 text-lg font-semibold tracking-tight">Import CSV</h3>
            <p className={`mt-1 text-sm ${muted}`}>
              Create or update users from a spreadsheet. Passwords are never exported.
            </p>
          </div>
          <button
            onClick={onClose}
            className={`rounded-full border p-2 ${light ? "border-slate-200 hover:bg-slate-50" : "border-white/10 hover:bg-white/5"}`}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {error && (
            <div className="rounded-[20px] border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          <section className={`rounded-[24px] border px-4 py-4 ${soft}`}>
            <div className="mb-3 flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-sky-400" />
              <div className="text-sm font-semibold">1. Get a template or export</div>
            </div>
            <p className={`mb-3 text-sm ${muted}`}>
              Columns: username, email, fullName, password, role, status, group, certEnabled,
              validFrom, validUntil, devices. Group must match an existing name (e.g. Guest).
              Devices use <code className="font-mono text-[11px]">mac|label|status</code> entries
              separated by <code className="font-mono text-[11px]">;</code>
              {" "}(prefix MAC with <code className="font-mono text-[11px]">*</code> for primary).
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void downloadUsersImportTemplate(token).catch((e: Error) => setError(e.message))}
              className={`inline-flex items-center gap-2 rounded-[18px] border px-3 py-2 text-sm ${light ? "border-slate-200 hover:bg-white" : "border-white/10 hover:bg-white/5"}`}
            >
              <Download className="h-4 w-4" />
              Download template
            </button>
          </section>

          <section className={`rounded-[24px] border px-4 py-4 ${soft}`}>
            <div className="mb-3 text-sm font-semibold">2. Choose CSV file</div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e)} />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-[20px] border border-dashed border-sky-400/40 bg-sky-400/10 px-4 py-8 text-sm font-medium text-sky-200 transition hover:bg-sky-400/15"
            >
              <Upload className="h-4 w-4" />
              {fileName ? fileName : "Select .csv file"}
            </button>
            {rowCount > 0 && (
              <p className={`mt-2 text-xs ${muted}`}>{rowCount} data row{rowCount === 1 ? "" : "s"} detected</p>
            )}
          </section>

          <section className={`rounded-[24px] border px-4 py-4 ${soft}`}>
            <div className="mb-3 text-sm font-semibold">3. Import mode</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["create", "Create only", "Skip usernames that already exist"],
                  ["upsert", "Create + update", "Update matching usernames; set password only if column filled"],
                ] as const
              ).map(([value, title, hint]) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => { setMode(value); setPreview(null); }}
                  className={`rounded-[20px] border px-3 py-3 text-left transition ${
                    mode === value
                      ? "border-sky-400/50 bg-sky-400/10"
                      : light
                        ? "border-slate-200 bg-white hover:border-slate-300"
                        : "border-white/8 bg-slate-950/40 hover:border-white/15"
                  }`}
                >
                  <div className="text-sm font-semibold">{title}</div>
                  <div className={`mt-1 text-xs ${muted}`}>{hint}</div>
                </button>
              ))}
            </div>
          </section>

          {summary && (
            <section className={`rounded-[24px] border px-4 py-4 ${soft}`}>
              <div className="mb-3 flex items-center gap-2">
                {result ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : null}
                <div className="text-sm font-semibold">
                  {result ? "Import complete" : "Dry-run preview"}
                  {summary.dryRun ? " (no changes written)" : ""}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ["Created", summary.created],
                  ["Updated", summary.updated],
                  ["Skipped", summary.skipped],
                  ["Failed", summary.failed],
                  ["Dev +", summary.devicesCreated],
                  ["Dev ~", summary.devicesUpdated],
                ].map(([label, n]) => (
                  <div key={label as string} className={`rounded-[16px] border px-3 py-2 ${light ? "border-slate-200 bg-white" : "border-white/8 bg-slate-950/50"}`}>
                    <div className={`text-[10px] uppercase tracking-wider ${muted}`}>{label}</div>
                    <div className="mt-1 text-lg font-semibold">{n as number}</div>
                  </div>
                ))}
              </div>
              <div className={`mt-3 max-h-48 overflow-auto rounded-[16px] border text-xs ${light ? "border-slate-200" : "border-white/8"}`}>
                <table className="w-full text-left">
                  <thead className={light ? "bg-slate-50 text-slate-500" : "bg-white/[0.03] text-slate-500"}>
                    <tr>
                      <th className="px-3 py-2 font-medium">Line</th>
                      <th className="px-3 py-2 font-medium">User</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                      <th className="px-3 py-2 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.map((r) => (
                      <tr key={`${r.line}-${r.username}`} className={light ? "border-t border-slate-100" : "border-t border-white/5"}>
                        <td className="px-3 py-1.5 tabular-nums">{r.line}</td>
                        <td className="px-3 py-1.5 font-mono">{r.username}</td>
                        <td className="px-3 py-1.5">{r.action}</td>
                        <td className={`px-3 py-1.5 ${r.action === "failed" ? "text-rose-300" : muted}`}>{r.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        <div className={`flex flex-wrap items-center justify-end gap-2 border-t px-5 py-4 ${light ? "border-slate-200" : "border-white/8"}`}>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className={`rounded-[18px] border px-4 py-2.5 text-sm ${light ? "border-slate-200 hover:bg-slate-50" : "border-white/10 hover:bg-white/5"}`}
          >
            Close
          </button>
          <button
            type="button"
            disabled={busy || !csv.trim()}
            onClick={() => void run(true)}
            className={`inline-flex items-center gap-2 rounded-[18px] border px-4 py-2.5 text-sm disabled:opacity-50 ${light ? "border-slate-200 hover:bg-slate-50" : "border-white/10 hover:bg-white/5"}`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Dry run
          </button>
          <button
            type="button"
            disabled={busy || !csv.trim()}
            onClick={() => void run(false)}
            className="inline-flex items-center gap-2 rounded-[18px] bg-gradient-to-r from-sky-400 via-cyan-400 to-teal-400 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Import users
          </button>
        </div>
      </aside>
    </>
  );
}
