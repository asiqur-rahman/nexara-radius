import { useEffect, useState } from "react";
import { Activity, Clock, Laptop, ShieldCheck, Smartphone, Wifi } from "lucide-react";
import type { RadiusSession, UserDevice } from "@app/shared";
import { listMyDevices, listMySessions } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { usePortalTheme } from "../theme/portalTheme";

function duration(seconds: string): string {
  const total = Number(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function when(value: string | null): string {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function LivePortalOverview() {
  const t = usePortalTheme();
  const { token, user } = useAuth();
  const [sessions, setSessions] = useState<RadiusSession[]>([]);
  const [devices, setDevices] = useState<UserDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([listMySessions(token), listMyDevices(token)])
      .then(([sessionResult, deviceResult]) => {
        if (!cancelled) {
          setSessions(sessionResult.items);
          setDevices(deviceResult);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const active = sessions.find((session) => session.stoppedAt === null);
  const recent = sessions.slice(0, 5);

  return (
    <div className="space-y-6">
      <div
        className={`preserve-on-dark relative overflow-hidden rounded-[28px] p-5 sm:rounded-3xl sm:p-8 ${
          active
            ? "bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 text-white"
            : t.light
              ? "border border-slate-200 bg-gradient-to-br from-slate-100 to-slate-200 text-slate-900"
              : "bg-gradient-to-br from-slate-700 to-slate-900 text-white"
        }`}
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full -translate-y-32 translate-x-32 blur-2xl" />
        <div className="relative">
          <div
            className={`flex items-center gap-2 mb-2 ${
              active || !t.light ? "text-white/85" : "text-slate-600"
            }`}
          >
            <div
              className={`w-2 h-2 rounded-full ${
                active ? "bg-white animate-pulse" : t.light ? "bg-slate-400" : "bg-slate-400"
              }`}
            />
            <span className="text-xs font-semibold uppercase tracking-wider">
              {active ? "Connected" : "No active Wi-Fi session"}
            </span>
          </div>
          <h2
            className={`text-[1.65rem] sm:text-3xl font-semibold tracking-tight leading-tight ${
              active || !t.light ? "text-white" : "text-slate-900"
            }`}
            style={{ fontFamily: "ui-serif, Georgia, serif" }}
          >
            {active ? "You're online." : "You're currently offline."}
          </h2>
          {active && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:mt-6 sm:grid-cols-4 sm:gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/70">Device</div>
                <div className="mt-1 text-sm font-semibold sm:text-base text-white">
                  {active.deviceLabel || active.callingStationId}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/70">Access Point</div>
                <div className="mt-1 text-sm font-semibold sm:text-base text-white">{active.nasName || active.nasIp}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/70">IP Address</div>
                <div className="mt-1 text-sm font-semibold font-mono sm:text-base text-white">
                  {active.framedIpAddress || "-"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/70">Session</div>
                <div className="mt-1 text-sm font-semibold sm:text-base text-white">{duration(active.durationSeconds)}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <div className={`border rounded-xl px-4 py-3 text-sm ${t.noticeErr}`}>{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className={`${t.card} p-5`}>
          <ShieldCheck className="w-5 h-5 text-emerald-400 mb-3" />
          <div className={`text-2xl font-semibold ${t.title}`}>{user?.mfaEnabled ? "Enabled" : "Optional"}</div>
          <div className={`text-xs mt-1 ${t.muted}`}>Two-factor authentication</div>
        </div>
        <div className={`${t.card} p-5`}>
          <Smartphone className="w-5 h-5 text-sky-400 mb-3" />
          <div className={`text-2xl font-semibold ${t.title}`}>{devices.length} devices</div>
          <div className={`text-xs mt-1 ${t.muted}`}>Registered for network access</div>
        </div>
        <div className={`${t.card} p-5`}>
          <Activity className="w-5 h-5 text-amber-400 mb-3" />
          <div className={`text-2xl font-semibold ${t.title}`}>
            {sessions.filter((session) => session.stoppedAt === null).length}
          </div>
          <div className={`text-xs mt-1 ${t.muted}`}>Current RADIUS sessions</div>
        </div>
      </div>

      <div className={`${t.card} rounded-[24px] p-5 sm:rounded-2xl sm:p-6`}>
        <h3 className={`text-base font-semibold mb-4 ${t.title}`} style={{ fontFamily: "ui-serif, Georgia, serif" }}>
          Recent network sessions
        </h3>
        {recent.length === 0 ? (
          <p className={`text-sm ${t.muted}`}>No accounting activity recorded yet.</p>
        ) : (
          recent.map((session) => (
            <div
              key={session.id}
              className={`flex items-center gap-3 py-3 border-b last:border-b-0 ${t.divider}`}
            >
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center ${
                  session.stoppedAt
                    ? t.light
                      ? "bg-stone-100 text-stone-500"
                      : "bg-white/[0.06] text-slate-400"
                    : "bg-emerald-500/15 text-emerald-400"
                }`}
              >
                {session.stoppedAt ? <Laptop className="w-4 h-4" /> : <Wifi className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-medium ${t.title}`}>
                  {session.deviceLabel || session.callingStationId}
                </div>
                <div className={`truncate text-xs ${t.muted}`}>{session.nasName || session.nasIp}</div>
              </div>
              <div className={`hidden text-xs sm:flex items-center gap-1 ${t.muted}`}>
                <Clock className="w-3 h-3" />
                {when(session.updatedAt || session.startedAt)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
