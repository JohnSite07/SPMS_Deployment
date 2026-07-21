import { useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import PublicLayout from './components/PublicLayout.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Welcome from './pages/Welcome.jsx';
import Login from './pages/Login.jsx';
import SignUp from './pages/SignUp.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import TwoFactorSetup from './pages/TwoFactorSetup.jsx';
import Credentials from './pages/Credentials.jsx';
import Documents from './pages/Documents.jsx';
import PasswordHealth from './pages/PasswordHealth.jsx';
import Activity from './pages/Activity.jsx';
import NotFound from './pages/NotFound.jsx';
import { setRedirectHandler } from './services/session.js';

// Route table for the core use-case screens (docs/requirements/
// functional-requirements.md UC-01..UC-05) plus a 404 catch-all.
//
// Two groups, mirroring Figure 7's navigation map: the pre-session screens
// (login, forgot/reset) render under PublicLayout — a bare shell with no app
// chrome — while every vault screen sits behind RequireAuth and the tabbed
// Layout. The guard is what makes login actually gate the app: without a live
// session, a protected URL redirects to /login. Vault screens themselves are
// still inert placeholders — their behaviour is added in later PRDs.
export default function App() {
  // Give the API client a way to send an expired/ended session back to login
  // (PRD 0012). Registered here because navigate() is only available inside
  // the router; the services stay framework-agnostic behind setRedirectHandler.
  const navigate = useNavigate();
  useEffect(() => {
    setRedirectHandler(() => navigate('/login'));
    return () => setRedirectHandler(null);
  }, [navigate]);

  return (
    <Routes>
      {/* Public: reachable without a session, no bottom-nav / logout chrome. */}
      <Route element={<PublicLayout />}>
        <Route path="welcome" element={<Welcome />} />
        <Route path="login" element={<Login />} />
        <Route path="signup" element={<SignUp />} />
        <Route path="forgot-password" element={<ForgotPassword />} />
        <Route path="reset-password" element={<ResetPassword />} />
        <Route path="2fa-setup" element={<TwoFactorSetup />} />
      </Route>

      {/* Protected: the Vault Dashboard hub and its spokes, all auth-gated. */}
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="credentials" element={<Credentials />} />
        <Route path="documents" element={<Documents />} />
        <Route path="health" element={<PasswordHealth />} />
        <Route path="activity" element={<Activity />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
