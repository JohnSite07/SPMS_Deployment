import { Navigate } from 'react-router-dom';
import { isAuthenticated } from '../services/auth-service';

// Client-side route guard. Every protected screen sits behind this, so the
// login page actually gates the app (Figure 7: the whole flow starts at
// Login). With no live session the user is sent to /login; `replace` keeps the
// guarded URL out of history so Back doesn't bounce them straight back here.
//
// The token is in-memory only (ADR 0010 / token-store.js), so a hard refresh
// or a new tab legitimately lands here with no token and is redirected to
// login — the intended trade-off of never persisting the session.
export default function RequireAuth({ children }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
