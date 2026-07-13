import { Link, Outlet } from 'react-router-dom';

// Minimal app shell: a nav that exercises the router, plus the outlet where
// the matched page renders. Plain semantic HTML — no design system yet.
export default function Layout() {
  return (
    <div>
      <header>
        <h1>SecureVault</h1>
        <nav>
          <Link to="/">Dashboard</Link>
          {' | '}
          <Link to="/credentials">Credentials</Link>
          {' | '}
          <Link to="/documents">Documents</Link>
          <Link to="/health">Password Health</Link>
          {' | '}
          <Link to="/activity">Activity</Link>
          {' | '}
          <Link to="/login">Log In</Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
