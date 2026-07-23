import { useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Navbar, Container, Nav, Button, Offcanvas } from 'react-bootstrap';
import { logout } from '../services/auth-service';
import AutoLockCountdown from './AutoLockCountdown.jsx';

// App shell for the authenticated screens: top header (brand, auto-lock
// countdown, logout) and a persistent LEFT SIDE navigation panel. This layout
// is only ever rendered behind RequireAuth, so the nav and the logout control
// are never shown to a logged-out visitor — the login/reset screens use
// PublicLayout instead.
//
// The nav is a left sidebar on md+ screens; below md it collapses into a
// hamburger-toggled Offcanvas panel sliding in from the left, so small screens
// keep the full width for content and nothing sits in a footer.

const NAV_ITEMS = [
  { to: '/', label: 'Vault', end: true },
  { to: '/documents', label: 'Documents' },
  { to: '/health', label: 'Health' },
  { to: '/activity', label: 'Activity' },
];

// The four destinations, rendered vertically. Shared by the desktop sidebar
// and the mobile Offcanvas so the two never drift. `onNavigate` lets the
// mobile panel close itself when a link is tapped.
function SideNavLinks({ onNavigate }) {
  return (
    <Nav variant="pills" className="flex-column gap-1 p-2">
      {NAV_ITEMS.map((item) => (
        <Nav.Link
          key={item.to}
          as={NavLink}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className="px-3 py-2"
        >
          {item.label}
        </Nav.Link>
      ))}
    </Nav>
  );
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [showNav, setShowNav] = useState(false);

  // Simple helper to extract the page title for the header.
  const getPageTitle = () => {
    const path = location.pathname;
    if (path.startsWith('/documents')) return 'Secure Documents';
    if (path.startsWith('/health')) return 'Password Health';
    if (path.startsWith('/activity')) return 'Activity';
    return 'Vault Dashboard';
  };

  // Figure 7's `logout -> Login` edge. logout() clears the in-memory token
  // (best-effort server revoke) regardless of the network result, so the
  // redirect always lands on the login screen with no live session.
  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  const closeNav = () => setShowNav(false);

  return (
    <div className="d-flex flex-column vh-100 bg-light">
      {/* Top Header */}
      <Navbar bg="primary" variant="dark" className="flex-shrink-0 shadow-sm">
        <Container fluid>
          <div className="d-flex align-items-center gap-2">
            <Button
              variant="outline-light"
              size="sm"
              className="d-md-none d-inline-flex align-items-center"
              onClick={() => setShowNav(true)}
              aria-label="Open navigation menu"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5" />
              </svg>
            </Button>
            <Navbar.Brand className="fw-bold">SecureVault</Navbar.Brand>
          </div>
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

      {/* Body: side panel + scrollable content */}
      <div className="d-flex flex-grow-1 overflow-hidden">
        {/* Desktop sidebar (md and up) */}
        <aside
          className="d-none d-md-flex flex-column flex-shrink-0 bg-white border-end shadow-sm"
          style={{ width: '220px' }}
        >
          <SideNavLinks />
        </aside>

        {/* Mobile navigation drawer (opened by the header hamburger). A plain
            Offcanvas renders nothing while closed, so the desktop sidebar
            above is the only nav in the tree at rest. */}
        <Offcanvas show={showNav} onHide={closeNav} className="d-md-none">
          <Offcanvas.Header closeButton>
            <Offcanvas.Title className="fw-bold">SecureVault</Offcanvas.Title>
          </Offcanvas.Header>
          <Offcanvas.Body className="p-0">
            <SideNavLinks onNavigate={closeNav} />
          </Offcanvas.Body>
        </Offcanvas>

        {/* Main Content Area */}
        <main className="flex-grow-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
