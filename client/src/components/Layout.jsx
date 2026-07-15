import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { Navbar, Container, Nav } from 'react-bootstrap';

// App shell with SecureVault design: top primary header, and bottom navigation.
export default function Layout() {
  const location = useLocation();

  // Simple helper to extract the page title for the header
  const getPageTitle = () => {
    const path = location.pathname;
    if (path.startsWith('/credentials')) return 'Add Credential';
    if (path.startsWith('/documents')) return 'Secure Documents';
    if (path.startsWith('/health')) return 'Password Health';
    if (path.startsWith('/activity')) return 'Audit Log';
    if (path.startsWith('/login')) return 'Login';
    return 'Vault Dashboard';
  };

  return (
    <div className="d-flex flex-column vh-100 bg-light">
      {/* Top Header */}
      <Navbar bg="primary" variant="dark" className="flex-shrink-0 shadow-sm">
        <Container>
          <Navbar.Brand className="fw-bold">SecureVault</Navbar.Brand>
          <Nav className="align-items-center">
            <Navbar.Text className="text-white opacity-75 small me-3">
              {getPageTitle()}
            </Navbar.Text>
            {/* Header entry point to the Login screen (wireframe Fig 9 places
                "Login" top-right). Hidden on the login page itself, where the
                page-title text above already reads "Login" — showing both
                produced a duplicate. Lightweight for now: full auth-gating
                (redirect unauthenticated users here, show Logout when signed
                in) is a follow-up once the DB migration makes login work. */}
            {!location.pathname.startsWith('/login') && (
              <Nav.Link as={NavLink} to="/login" className="text-white fw-semibold">
                Login
              </Nav.Link>
            )}
          </Nav>
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
