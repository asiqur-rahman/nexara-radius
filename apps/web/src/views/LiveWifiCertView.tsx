import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Lock,
  ShieldCheck,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import type { ProvisionUserCertResponse, UserClientCert } from "@app/shared";
import { listMyCerts, provisionMyCert, revokeMyCert, downloadMyCertPkcs12 } from "../api/endpoints";
import { apiDownload } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { usePortalTheme } from "../theme/portalTheme";

function CertStatusBadge({ cert }: { cert: UserClientCert }) {
  const expired = new Date(cert.expiresAt) < new Date();
  if (expired) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">
        Expired
      </span>
    );
  }
  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">
      Active
    </span>
  );
}

function useCopyText() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }, []);
  return { copied, copy };
}

function PasswordReveal({ password }: { password: string }) {
  const t = usePortalTheme();
  const [visible, setVisible] = useState(false);
  const { copied, copy } = useCopyText();

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span className={`text-[11px] font-medium ${t.faint}`}>P12 password:</span>
      <code className={`text-[11px] font-mono rounded px-1.5 py-0.5 select-all ${t.soft} ${t.title}`}>
        {visible ? password : "••••••••••••"}
      </code>
      <button
        onClick={() => setVisible((v) => !v)}
        className={t.btnIcon}
        title={visible ? "Hide password" : "Show password"}
      >
        {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
      {visible && (
        <button
          onClick={() => copy(password, "pwd-" + password.slice(0, 4))}
          className={t.btnIcon}
          title="Copy password"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      )}
    </div>
  );
}

function BundleDownloadPanel({
  bundle,
  onDismiss,
}: {
  bundle: ProvisionUserCertResponse;
  onDismiss: () => void;
}) {
  const t = usePortalTheme();
  const { copied, copy } = useCopyText();

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadPkcs12 = () => {
    const bin = atob(bundle.pkcs12Base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/x-pkcs12" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wifi-certificate.p12";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={`rounded-2xl p-6 space-y-4 border ${
        t.light
          ? "bg-amber-50 border-amber-300"
          : "bg-amber-500/10 border-amber-500/30"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
              t.light ? "bg-amber-200 text-amber-800" : "bg-amber-400/20 text-amber-200"
            }`}
          >
            <Key className="w-5 h-5" />
          </div>
          <div>
            <h3 className={`font-semibold ${t.light ? "text-amber-900" : "text-amber-100"}`}>
              Certificate ready — download your .p12 now
            </h3>
            <p className={`text-xs mt-1 leading-relaxed max-w-lg ${t.light ? "text-amber-800" : "text-amber-200/80"}`}>
              Download the <strong>.p12 file</strong> — you cannot re-download it later (the private key is not
              stored on the server). The password is saved and always visible in your cert list below.
            </p>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className={`mt-0.5 flex-shrink-0 ${t.light ? "text-amber-600 hover:text-amber-900" : "text-amber-300 hover:text-amber-100"}`}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          onClick={downloadPkcs12}
          className="flex items-center justify-center gap-2 bg-amber-700 hover:bg-amber-800 text-white text-sm font-medium px-4 py-3 rounded-xl transition-colors"
        >
          <Download className="w-4 h-4" />
          Download wifi-certificate.p12
        </button>
        <button
          onClick={() => downloadFile(bundle.certificatePem, "wifi-cert.pem", "application/x-pem-file")}
          className={`flex items-center justify-center gap-2 text-sm font-medium px-4 py-3 rounded-xl transition-colors border ${
            t.light
              ? "bg-white border-amber-300 hover:bg-amber-50 text-amber-900"
              : "bg-white/[0.04] border-amber-500/30 hover:bg-white/[0.08] text-amber-100"
          }`}
        >
          <Download className="w-4 h-4" />
          Download cert.pem (optional)
        </button>
      </div>

      <div className={`${t.soft} p-4 space-y-2`}>
        <div className={`text-xs font-semibold uppercase tracking-wider ${t.light ? "text-amber-800" : "text-amber-200"}`}>
          P12 Password
        </div>
        <div className="flex items-center gap-2">
          <code className={`flex-1 select-all break-all ${t.code}`}>{bundle.pkcs12Password}</code>
          <button
            onClick={() => copy(bundle.pkcs12Password, "pwd")}
            className={t.btnIcon}
            title="Copy password"
          >
            {copied === "pwd" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
        <p className={`text-[11px] ${t.light ? "text-amber-700" : "text-amber-200/70"}`}>
          You'll need this password when importing the .p12 on your device. It's also visible any time in your
          cert list below.
        </p>
      </div>

      <div className={`text-xs font-semibold ${t.title}`}>
        Common name: <code className={`font-mono ${t.muted}`}>{bundle.commonName}</code>
        &nbsp;·&nbsp; Expires: {new Date(bundle.expiresAt).toLocaleDateString()}
      </div>
    </div>
  );
}

type Platform = "ios" | "windows" | "android" | "macos";

const PLATFORM_GUIDES: Record<Platform, { label: string; steps: string[] }> = {
  ios: {
    label: "iOS",
    steps: [
      "AirDrop or email yourself the wifi-certificate.p12 file.",
      "Open the file — iOS will prompt to install a profile. Tap Allow.",
      "Go to Settings → General → VPN & Device Management → tap the new profile → Install.",
      "Enter the P12 password when prompted.",
      "Go to Settings → Wi-Fi → tap your corporate network → configure for EAP-TLS.",
      "Select your imported certificate when asked for client identity.",
    ],
  },
  macos: {
    label: "macOS",
    steps: [
      "Double-click the wifi-certificate.p12 file to open Keychain Access.",
      "Enter the P12 password — the cert and key are imported to your login keychain.",
      "Open System Settings → Wi-Fi → select your corporate network → Edit.",
      "Under Authentication, choose TLS, then pick your certificate.",
      "Trust the CA certificate when prompted.",
    ],
  },
  windows: {
    label: "Windows",
    steps: [
      "Double-click wifi-certificate.p12 → Import Wizard → Local Machine → Next.",
      "Confirm the file path, enter the P12 password, check Mark key as exportable.",
      "Place certificate in Personal store → Finish.",
      "Open Network & Internet → Wi-Fi → Manage known networks → select your corporate network.",
      "Authentication: set EAP method to Microsoft: Smart Card or other certificate.",
      "Click Settings → Use a certificate on this computer → select your cert.",
    ],
  },
  android: {
    label: "Android",
    steps: [
      "Transfer the wifi-certificate.p12 to your device (Files app, USB, or email).",
      "Go to Settings → Security → Encryption & credentials → Install a certificate → Wi-Fi certificate.",
      "Select the .p12 file, enter the password, and give it a name.",
      "Go to Settings → Network → Wi-Fi → tap your corporate network.",
      "Set EAP method to TLS, pick your certificate for client identity.",
      "Leave CA certificate as System or import the CA PEM if required.",
    ],
  },
};

function InstallGuide() {
  const t = usePortalTheme();
  const [platform, setPlatform] = useState<Platform>("ios");
  const [open, setOpen] = useState(false);
  const guide = PLATFORM_GUIDES[platform];

  return (
    <div className={`${t.card} overflow-hidden`}>
      <button onClick={() => setOpen((p) => !p)} className={t.accordionBtn}>
        <div className="flex items-center gap-3">
          <Wifi className={`w-5 h-5 ${t.light ? "text-indigo-600" : "text-sky-300"}`} />
          <div>
            <div className={`font-semibold text-sm ${t.title}`}>How to install on your device</div>
            <div className={`text-xs ${t.muted}`}>Step-by-step guide for iOS, macOS, Windows, Android</div>
          </div>
        </div>
        {open ? <ChevronUp className={`w-4 h-4 ${t.faint}`} /> : <ChevronDown className={`w-4 h-4 ${t.faint}`} />}
      </button>
      {open && (
        <div className={t.accordionBody}>
          <div className="flex gap-2 flex-wrap">
            {(Object.keys(PLATFORM_GUIDES) as Platform[]).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  platform === p ? t.chipActive : t.chipIdle
                }`}
              >
                {PLATFORM_GUIDES[p].label}
              </button>
            ))}
          </div>
          <ol className="space-y-2.5">
            {guide.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 mt-0.5 ${t.stepBadge}`}
                >
                  {i + 1}
                </span>
                <span className={`text-sm leading-relaxed ${t.body}`}>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function LiveWifiCertView() {
  const t = usePortalTheme();
  const { token } = useAuth();
  const [certs, setCerts] = useState<UserClientCert[]>([]);
  const [userSelfService, setUserSelfService] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<ProvisionUserCertResponse | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCerts = useCallback(async () => {
    if (!token) return;
    try {
      const res = await listMyCerts(token);
      setCerts(res.certs);
      setUserSelfService(res.userSelfService);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load certificates");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadCerts();
  }, [loadCerts]);

  const activeCerts = certs.filter((c) => new Date(c.expiresAt) >= new Date());

  const handleProvision = async () => {
    if (!token) return;
    setProvisioning(true);
    setNotice(null);
    try {
      const result = await provisionMyCert(token, {});
      setBundle(result);
      await loadCerts();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Failed to generate certificate" });
    } finally {
      setProvisioning(false);
    }
  };

  const handleRevoke = async (certId: string) => {
    if (!token) return;
    setRevoking(certId);
    try {
      await revokeMyCert(token, certId);
      await loadCerts();
      setNotice({ ok: true, text: "Certificate deleted. Generate a new one any time." });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Failed to delete certificate" });
    } finally {
      setRevoking(null);
    }
  };

  const handleDownloadPkcs12 = async (certId: string, fallbackName: string) => {
    if (!token) return;
    setDownloading(certId);
    setNotice(null);
    try {
      const file = await downloadMyCertPkcs12(token, certId);
      const bin = atob(file.pkcs12Base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/x-pkcs12" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${file.commonName || fallbackName}.p12`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setNotice({
        ok: true,
        text: file.pkcs12Password
          ? "Downloaded wifi-certificate.p12 — use the P12 password shown below when importing."
          : "Downloaded wifi-certificate.p12.",
      });
    } catch (err) {
      setNotice({
        ok: false,
        text: err instanceof Error ? err.message : "Unable to download .p12 — generate a new certificate.",
      });
    } finally {
      setDownloading(null);
    }
  };

  const downloadCa = async () => {
    if (!token) return;
    try {
      await apiDownload("/api/v1/me/wifi-ca", "wifi-ca.pem", { token });
    } catch {
      setNotice({ ok: false, text: "CA certificate not available on this server." });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className={t.pageTitle} style={{ fontFamily: "ui-serif, Georgia, serif" }}>
          WiFi Certificate
        </h2>
        <p className={t.pageSub}>
          Certificate-based (EAP-TLS) access — connect without a password. Your identity is proven by a private
          key that never leaves your device.
        </p>
      </div>

      {notice && (
        <div className={`border rounded-xl px-4 py-3 text-sm flex items-start gap-2 ${notice.ok ? t.noticeOk : t.noticeErr}`}>
          {notice.ok ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      {bundle && <BundleDownloadPanel bundle={bundle} onDismiss={() => setBundle(null)} />}

      <div className={`${t.card} p-6 space-y-5`}>
        <div className="flex items-start gap-4">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${t.iconBox}`}>
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 className={`font-semibold ${t.title}`}>How certificate authentication works</h3>
            <p className={`text-xs mt-1 leading-relaxed max-w-lg ${t.muted}`}>
              You receive a personal certificate (.p12 file). Install it on any of your devices. When connecting
              to the corporate WiFi, your device presents this certificate instead of a username and password.
              The network verifies it was signed by the company CA.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          {[
            { icon: Key, text: "Private key stays on your device only" },
            { icon: ShieldCheck, text: "Signed by the company CA — tamper-proof" },
            { icon: Wifi, text: "Connect from any approved device, no password" },
          ].map(({ icon: Icon, text }, i) => (
            <div key={i} className={`flex items-start gap-2.5 p-3 ${t.soft}`}>
              <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${t.light ? "text-indigo-600" : "text-sky-300"}`} />
              <span className={`text-xs leading-relaxed ${t.body}`}>{text}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 pt-2 flex-wrap">
          {userSelfService ? (
            <button onClick={handleProvision} disabled={provisioning} className={`flex items-center gap-2 ${t.btnPrimary}`}>
              {provisioning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Key className="w-4 h-4" />
                  Generate My WiFi Certificate
                </>
              )}
            </button>
          ) : (
            <div className={`flex items-center gap-2 text-sm px-4 py-2.5 ${t.soft} ${t.muted}`}>
              <Lock className="w-4 h-4 flex-shrink-0" />
              <span>
                Certificate generation is managed by your administrator. Certs issued for you appear in the list
                below.
              </span>
            </div>
          )}
          <button onClick={downloadCa} className={t.btnGhost}>
            <Download className="w-4 h-4" />
            Download CA Certificate
          </button>
        </div>
        {userSelfService && (
          <p className={`text-[11px] ${t.faint}`}>
            Generating a new certificate replaces your existing one. Save the .p12 file immediately — the private
            key is not stored on the server. The password is always visible in the cert list below.
          </p>
        )}
      </div>

      <div className={`${t.card} p-6 space-y-4`}>
        <div>
          <h3 className={`font-semibold ${t.title}`}>Your certificates</h3>
          <p className={`text-xs mt-0.5 ${t.muted}`}>
            {loading ? "Loading…" : activeCerts.length === 0 ? "No active certificate" : "1 active certificate"}
          </p>
        </div>

        {loading && (
          <div className={`flex items-center justify-center py-8 ${t.faint}`}>
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading certificates…
          </div>
        )}

        {!loading && error && (
          <div className={`text-sm border rounded-xl px-4 py-3 ${t.noticeErr}`}>{error}</div>
        )}

        {!loading && !error && certs.length === 0 && (
          <div className={`text-center py-8 text-sm ${t.faint}`}>
            {userSelfService
              ? "No certificates yet. Generate one above to get started."
              : "No certificates have been issued for you yet. Contact your administrator."}
          </div>
        )}

        {!loading && !error && certs.length > 0 && (
          <div className="space-y-3">
            {certs.map((cert) => {
              const isActive = new Date(cert.expiresAt) >= new Date();
              return (
                <div
                  key={cert.id}
                  className={`rounded-xl border p-4 transition-colors ${t.soft} ${isActive ? "" : "opacity-60"}`}
                >
                  <div className="flex items-start gap-4">
                    <Key
                      className={`w-4 h-4 flex-shrink-0 mt-1 ${
                        isActive ? (t.light ? "text-indigo-600" : "text-sky-300") : t.faint
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium font-mono truncate ${t.title}`}>{cert.commonName}</div>
                      <div className={`text-xs mt-0.5 truncate font-mono ${t.muted}`}>{cert.fingerprint}</div>
                      <div className={`text-xs mt-0.5 ${t.faint}`}>
                        Expires {new Date(cert.expiresAt).toLocaleDateString()}
                        {cert.notes && ` · ${cert.notes}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                      <CertStatusBadge cert={cert} />
                      {isActive && (
                        <button
                          onClick={() => handleRevoke(cert.id)}
                          disabled={revoking === cert.id}
                          className={`${t.btnIcon} hover:text-rose-400 disabled:opacity-50`}
                          title="Delete certificate"
                        >
                          {revoking === cert.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {isActive && (
                    <div className={`mt-3 space-y-2 border-t pt-3 ${t.divider}`}>
                      {cert.pkcs12Password ? (
                        <PasswordReveal password={cert.pkcs12Password} />
                      ) : (
                        <p className={`text-[11px] ${t.faint}`}>
                          No import password on file for this certificate.
                        </p>
                      )}

                      {cert.hasPkcs12 ? (
                        <button
                          onClick={() => void handleDownloadPkcs12(cert.id, cert.commonName)}
                          disabled={downloading === cert.id}
                          className={`${t.btnPrimary} inline-flex items-center gap-2`}
                        >
                          {downloading === cert.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Download className="w-4 h-4" />
                          )}
                          Download .p12 for import
                        </button>
                      ) : (
                        <p className={`text-xs leading-relaxed ${t.muted}`}>
                          This older certificate cannot be re-downloaded as a .p12 (private key was not kept).
                          Generate a new WiFi certificate above, then download the .p12 and use the password shown
                          here to import it on your device.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <InstallGuide />

      <div className={`${t.soft} p-5 flex items-start gap-3`}>
        <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
        <div className={`text-xs leading-relaxed ${t.body}`}>
          <strong className={t.title}>CA certificate trust:</strong> Your device must trust the company CA to
          verify the network's server certificate during EAP-TLS. Download the CA PEM above and import it to your
          device's trusted certificate store if prompted. On managed devices this is usually pushed automatically
          by IT.
        </div>
      </div>
    </div>
  );
}
