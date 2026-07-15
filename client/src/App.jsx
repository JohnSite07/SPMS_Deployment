import { useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Login from './pages/Login.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Credentials from './pages/Credentials.jsx';
import Documents from './pages/Documents.jsx';
import PasswordHealth from './pages/PasswordHealth.jsx';
import Activity from './pages/Activity.jsx';
import NotFound from './pages/NotFound.jsx';
import { setRedirectHandler } from './services/session.js';

// Route table for the core use-case screens (docs/requirements/
// functional-requirements.md UC-01..UC-05) plus a 404 catch-all.
// Pages are inert placeholders — behaviour is added in later PRDs.
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
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="login" element={<Login />} />
        <Route path="forgot-password" element={<ForgotPassword />} />
        <Route path="reset-password" element={<ResetPassword />} />
        <Route path="credentials" element={<Credentials />} />
        <Route path="documents" element={<Documents />} />
        <Route path="health" element={<PasswordHealth />} />
        <Route path="activity" element={<Activity />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
