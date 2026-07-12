import { useMemo } from "react";
import { useTheme } from "./ThemeContext";

/**
 * Theme-aware class tokens for the user portal views.
 * Prefer these over hardcoded stone/white colors so dark mode stays readable.
 */
export function usePortalTheme() {
  const { isWhiteTheme: light } = useTheme();

  return useMemo(
    () => ({
      light,
      pageTitle: "text-2xl font-semibold tracking-tight theme-text-primary",
      pageSub: "text-sm theme-text-muted mt-1",
      title: "theme-text-primary",
      body: "theme-text-secondary",
      muted: "theme-text-muted",
      faint: "theme-text-faint",
      card: "theme-surface rounded-2xl",
      soft: "theme-soft-card rounded-xl",
      softHover: light
        ? "hover:bg-slate-50"
        : "hover:bg-white/[0.04]",
      divider: "theme-divider",
      input: "theme-input w-full px-3 py-2.5 rounded-lg text-sm",
      btnPrimary: light
        ? "bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition disabled:opacity-60"
        : "bg-gradient-to-r from-sky-400 via-cyan-400 to-teal-400 text-slate-950 text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg shadow-sky-500/20 transition hover:brightness-105 disabled:opacity-60",
      btnGhost: "theme-ghost-button inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium",
      btnIcon: light
        ? "p-2 rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-800 transition-colors"
        : "p-2 rounded-lg text-slate-400 hover:bg-white/[0.06] hover:text-slate-100 transition-colors",
      chipIdle: light
        ? "bg-stone-100 text-stone-600 hover:bg-stone-200"
        : "bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]",
      chipActive: light
        ? "bg-stone-900 text-white"
        : "bg-sky-400 text-slate-950",
      noticeOk: light
        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
        : "bg-emerald-500/10 border-emerald-500/25 text-emerald-200",
      noticeErr: light
        ? "bg-rose-50 border-rose-200 text-rose-800"
        : "bg-rose-500/10 border-rose-500/25 text-rose-200",
      iconBox: light ? "bg-indigo-50 text-indigo-600" : "bg-sky-400/15 text-sky-300",
      code: light
        ? "font-mono text-sm theme-text-primary bg-stone-50 border border-stone-200 rounded-lg px-3 py-2"
        : "font-mono text-sm theme-text-primary bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2",
      accordionBtn: light
        ? "w-full flex items-center justify-between px-5 py-4 bg-white hover:bg-stone-50 transition-colors text-left"
        : "w-full flex items-center justify-between px-5 py-4 bg-transparent hover:bg-white/[0.03] transition-colors text-left",
      accordionBody: light
        ? "border-t border-stone-100 bg-white px-5 py-5 space-y-4"
        : "border-t border-white/6 bg-transparent px-5 py-5 space-y-4",
      stepBadge: light
        ? "bg-stone-900 text-white"
        : "bg-sky-400/20 text-sky-200",
      methodActive: light
        ? "border-stone-900 bg-stone-900 text-white"
        : "border-sky-400 bg-sky-400/15 text-white",
      methodIdle: light
        ? "border-stone-200 bg-stone-50 text-stone-700 hover:border-stone-400"
        : "border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/20",
    }),
    [light],
  );
}
