import { Navigate, Route, Routes } from "react-router-dom";
import { BrandLogo } from "./components/BrandLogo";
import { PwaInstallPrompt } from "./components/PwaInstallPrompt";
import { PwaUpdateBanner } from "./components/PwaUpdateBanner";
import { useAuth } from "./auth/AuthContext";
import { Login } from "./pages/Login";
import { useTheme } from "./theme/ThemeContext";
import AdminDashboard from "./pages/AdminDashboard";
import ClientPortal from "./pages/ClientPortal";

export function App() {
  const { status, user } = useAuth();
  const { isWhiteTheme } = useTheme();

  if (status === "loading") {
    return (
      <div className={`min-h-screen bg-transparent px-4 ${isWhiteTheme ? "text-slate-700" : "text-slate-200"}`}>
        <div className="mx-auto flex min-h-screen max-w-md items-center justify-center">
          <div className="theme-surface-strong w-full rounded-[32px] px-6 py-10 text-center">
            <BrandLogo className="mx-auto h-14 w-14 animate-pulse" />
            <div className={`mt-5 text-lg font-semibold tracking-tight ${isWhiteTheme ? "text-slate-950" : "text-white"}`}>
              Loading workspace
            </div>
            <div className={`mt-2 text-sm ${isWhiteTheme ? "text-slate-500" : "text-slate-400"}`}>
              Preparing your enterprise Wi-Fi control surfaces.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === "anonymous" || !user) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <PwaUpdateBanner />
        <PwaInstallPrompt />
      </>
    );
  }

  return (
    <>
      <Routes>
        {user.role === "admin" ? (
          <>
            <Route path="/admin/*" element={<AdminDashboard />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </>
        ) : (
          <>
            <Route path="/portal/*" element={<ClientPortal />} />
            <Route path="*" element={<Navigate to="/portal" replace />} />
          </>
        )}
      </Routes>
      <PwaUpdateBanner />
      <PwaInstallPrompt />
    </>
  );
}
