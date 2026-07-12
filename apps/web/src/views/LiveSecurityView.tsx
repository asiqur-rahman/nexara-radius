import { FormEvent, useEffect, useState } from "react";
import { Key, Lock, ShieldCheck } from "lucide-react";
import type { MfaSetupResponse, MfaStatus } from "@app/shared";
import { changeMyPassword, disableMfa, enableMfa, getMfaStatus, setupMfa } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { usePortalTheme } from "../theme/portalTheme";

export function LiveSecurityView() {
  const t = usePortalTheme();
  const { token } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mfaPassword, setMfaPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    getMfaStatus(token).then(setMfa).catch((err: Error) => setNotice({ ok: false, text: err.message }));
  }, [token]);

  const updatePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    if (newPassword !== confirmPassword) {
      setNotice({ ok: false, text: "New password confirmation does not match." });
      return;
    }
    setBusy("password");
    try {
      await changeMyPassword(token, { currentPassword, newPassword });
      setNotice({
        ok: true,
        text: "Password changed. Existing Wi-Fi sessions were disconnected according to policy.",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Unable to change password" });
    } finally {
      setBusy(null);
    }
  };

  const beginMfa = async () => {
    if (!token) return;
    setBusy("mfa");
    try {
      const enrollment = await setupMfa(token, mfaPassword);
      setSetup(enrollment);
      setMfa({ enabled: false, pendingEnrollment: true });
      setNotice({
        ok: true,
        text: "Add the secret to your authenticator app, then enter a code to activate MFA.",
      });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Unable to start MFA setup" });
    } finally {
      setBusy(null);
    }
  };

  const activateMfa = async () => {
    if (!token) return;
    setBusy("mfa");
    try {
      setMfa(await enableMfa(token, mfaCode));
      setSetup(null);
      setMfaCode("");
      setNotice({ ok: true, text: "Two-factor authentication is enabled." });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Unable to enable MFA" });
    } finally {
      setBusy(null);
    }
  };

  const turnOffMfa = async () => {
    if (!token) return;
    setBusy("mfa");
    try {
      setMfa(await disableMfa(token, mfaPassword, mfaCode || undefined));
      setMfaPassword("");
      setMfaCode("");
      setSetup(null);
      setNotice({ ok: true, text: "Two-factor authentication is disabled." });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Unable to disable MFA" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className={t.pageTitle} style={{ fontFamily: "ui-serif, Georgia, serif" }}>
          Security
        </h2>
        <p className={t.pageSub}>Manage credentials and two-factor protection for your account.</p>
      </div>

      {notice && (
        <div className={`border rounded-xl px-4 py-3 text-sm ${notice.ok ? t.noticeOk : t.noticeErr}`}>
          {notice.text}
        </div>
      )}

      <form onSubmit={updatePassword} className={`${t.card} p-6 space-y-4`}>
        <div className="flex gap-3 items-center mb-2">
          <Key className="w-5 h-5 text-amber-400" />
          <h3 className={`font-semibold ${t.title}`}>Password</h3>
        </div>
        <p className={`text-xs ${t.muted}`}>
          Changing your password updates RADIUS credentials and disconnects existing Wi-Fi sessions when enabled
          by policy.
        </p>
        <input
          required
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          placeholder="Current password"
          className={t.input}
        />
        <input
          required
          minLength={10}
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          placeholder="New password, at least 10 characters"
          className={t.input}
        />
        <input
          required
          minLength={10}
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="Confirm new password"
          className={t.input}
        />
        <div className="flex justify-end">
          <button disabled={busy === "password"} className={t.btnPrimary}>
            {busy === "password" ? "Updating..." : "Update password"}
          </button>
        </div>
      </form>

      <div className={`${t.card} p-6 space-y-4`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldCheck className={`w-5 h-5 ${mfa?.enabled ? "text-emerald-400" : t.faint}`} />
            <div>
              <h3 className={`font-semibold ${t.title}`}>Authenticator MFA</h3>
              <p className={`text-xs ${t.muted}`}>
                {mfa?.enabled ? "Enabled for portal sign-in" : "Add a six-digit authenticator code at sign-in"}
              </p>
            </div>
          </div>
          <span
            className={`text-xs font-semibold px-2 py-1 rounded-full ${
              mfa?.enabled
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20"
                : `${t.soft} ${t.muted}`
            }`}
          >
            {mfa?.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Lock className={`w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 ${t.faint}`} />
            <input
              type="password"
              value={mfaPassword}
              onChange={(event) => setMfaPassword(event.target.value)}
              placeholder="Current password"
              className={`${t.input} pl-9`}
            />
          </div>
          {!mfa?.enabled && !setup && (
            <button
              onClick={beginMfa}
              disabled={!mfaPassword || busy === "mfa"}
              className={t.btnPrimary}
            >
              Set up MFA
            </button>
          )}
        </div>
        {setup && (
          <div className={`${t.soft} p-4 space-y-3`}>
            <p className={`text-xs ${t.body}`}>Enter this secret in an authenticator app:</p>
            <code className={`block break-all tracking-wider ${t.code}`}>{setup.secret}</code>
            <input
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              maxLength={6}
              placeholder="6-digit verification code"
              className={`${t.input} font-mono`}
            />
            <button
              onClick={activateMfa}
              disabled={mfaCode.length !== 6 || busy === "mfa"}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg disabled:opacity-50"
            >
              Activate MFA
            </button>
          </div>
        )}
        {mfa?.enabled && (
          <div className="flex gap-3 items-center">
            <input
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              maxLength={6}
              placeholder="Authenticator code to disable"
              className={`${t.input} flex-1 font-mono`}
            />
            <button
              onClick={turnOffMfa}
              disabled={!mfaPassword || mfaCode.length !== 6 || busy === "mfa"}
              className={`px-4 py-2 text-sm rounded-lg disabled:opacity-50 border ${t.noticeErr}`}
            >
              Disable MFA
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
