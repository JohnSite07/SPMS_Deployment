import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Login from './pages/Login.jsx';
import Credentials from './pages/Credentials.jsx';
import Documents from './pages/Documents.jsx';
import PasswordHealth from './pages/PasswordHealth.jsx';
import NotFound from './pages/NotFound.jsx';

// Route table for the core use-case screens (docs/requirements/
// functional-requirements.md UC-01..UC-05) plus a 404 catch-all.
// Pages are inert placeholders — behaviour is added in later PRDs.
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="login" element={<Login />} />
        <Route path="credentials" element={<Credentials />} />
        <Route path="documents" element={<Documents />} />
        <Route path="health" element={<PasswordHealth />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
