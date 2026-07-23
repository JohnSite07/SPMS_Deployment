import { useEffect, useState } from 'react';
import * as store from '../services/token-store';

// Visibility of system status (design principle) and business rule 5 made
// visible (wireframe Figure 10, "Auto-lock in 09:41"): show how long until the
// idle auto-lock fires. Display only — the lock itself is armed by
// services/session.js. The expiry lives in token-store module state with no
// change events, so we re-read it on a one-second tick.
//
// setTimeout is used recursively rather than setInterval because only
// setTimeout/clearTimeout are in the client ESLint globals.
function remainingMs() {
  const expiresAt = store.getExpiresAt();
  return expiresAt ? expiresAt.getTime() - Date.now() : null;
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function AutoLockCountdown() {
  const [ms, setMs] = useState(() => remainingMs());

  useEffect(() => {
    let timerId;
    function tick() {
      setMs(remainingMs());
      timerId = setTimeout(tick, 1000);
    }
    tick();
    return () => clearTimeout(timerId);
  }, []);

  // Before the first authenticated response arms the sliding window there is
  // no expiry to show; render nothing rather than a misleading placeholder.
  if (ms === null) {
    return null;
  }

  return (
    <span className="text-white small font-monospace">Auto-lock {formatRemaining(ms)}</span>
  );
}
