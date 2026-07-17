import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Navbar, Container, Nav, Button } from 'react-bootstrap';
import { logout } from '../services/auth-service';
import AutoLockCountdown from './AutoLockCountdown.jsx';

// App shell for the authenticated screens: top header (brand, auto-lock
// countdown, logout) and the persistent bottom navigation. This layout is only
// ever rendered behind RequireAuth, so the tabs and the logout control are
// never shown to a logged-out visitor — the login/reset screens use
// PublicLayout instead. This replaces the earlier header "Login" link, which
// was a stopgap until auth-gating landed (the follow-up its own comment named).
export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();

  // Simple helper to extract the page title for the header.
  const getPageTitle = () => {
    const path = location.pathname;
    if (path.startsWith('/credentials')) return 'Add Credential';
    if (path.startsWith('/documents')) return 'Secure Documents';
    if (path.startsWith('/health')) return 'Password Health';
    if (path.startsWith('/activity')) return 'Audit Log';
    return 'Vault Dashboard';
  };

  // Figure 7's `logout -> Login` edge. logout() clears the in-memory token
  // (best-effort server revoke) regardless of the network result, so the
  // redirect always lands on the login screen with no live session.
  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="d-flex flex-column vh-100 bg-light">
      {/* Top Header */}
      <Navbar bg="primary" variant="dark" className="flex-shrink-0 shadow-sm">
        <Container>
          <Navbar.Brand className="fw-bold">SecureVault</Navbar.Brand>
          <div className="d-flex align-items-center gap-3">
            <AutoLockCountdown />
            <Navbar.Text className="text-white opacity-75 small d-none d-sm-inline">
              {getPageTitle()}
            </Navbar.Text>
            <Button variant="outline-light" size="sm" onClick={handleLogout}>
              Log out
            </Button>
          </div>
        </Container>
      </Navbar>

      {/* Main Content Area */}
      <main className="flex-grow-1 overflow-auto pb-5 mb-5">
        <Outlet />
      </main>

      {/* Bottom Navigation */}
      <Navbar fixed="bottom" bg="white" className="border-top shadow-sm flex-shrink-0 p-0">
        <Container fluid className="p-0">
          <Nav className="w-100 justify-content-around text-center" style={{ fontSize: '0.85rem' }}>
            <Nav.Link as={NavLink} to="/" end className="py-3 text-secondary flex-grow-1 border-end">
              Vault
            </Nav.Link>
            <Nav.Link as={NavLink} to="/documents" className="py-3 text-secondary flex-grow-1 border-end">
              Documents
            </Nav.Link>
            <Nav.Link as={NavLink} to="/health" className="py-3 text-secondary flex-grow-1 border-end">
              Health
            </Nav.Link>
            <Nav.Link as={NavLink} to="/activity" className="py-3 text-secondary flex-grow-1">
              Activity
            </Nav.Link>
          </Nav>
        </Container>
      </Navbar>
    </div>
  );
}
