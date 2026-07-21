import { Navigate } from 'react-router-dom';
import { isAuthenticated } from '../services/auth-service';

// Client-side route guard. Every protected screen sits behind this. With no
// live session the visitor is sent to /welcome (PRD 0018) rather than
// straight into the login form: an unauthenticated visitor now lands on the
// public landing page first, where Sign In and Sign Up are both one click
// away — /login remains directly reachable as its own URL and via Welcome's
// link, this only changes where the *gate* redirects to. `replace` keeps the
// guarded URL out of history so Back doesn't bounce them straight back here.
//
// The token is in-memory only (ADR 0010 / token-store.js), so a hard refresh
// or a new tab legitimately lands here with no token and is redirected to
// welcome — the intended trade-off of never persisting the session.
export default function RequireAuth({ children }) {
  if (!isAuthenticated()) {
    return <Navigate to="/welcome" replace />;
  }
  return children;
}
