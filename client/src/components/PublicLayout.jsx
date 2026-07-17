import { Outlet } from 'react-router-dom';

// Bare shell for the pre-session screens (login, forgot/reset password). It
// deliberately carries none of the app chrome — no header actions, no bottom
// navigation tabs — so a logged-out visitor can't tap through to protected
// screens, and the auth screens read as their own centred cards (wireframe
// Figure 9). Each page renders its own <Container>, so this only owns the
// full-height background.
export default function PublicLayout() {
  return (
    <div className="min-vh-100 bg-light d-flex flex-column">
      <Outlet />
    </div>
  );
}
