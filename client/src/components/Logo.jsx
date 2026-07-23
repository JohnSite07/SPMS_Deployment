// SecureVault brand mark (PRD 0018) — an original SVG interpretation of the
// milestone cover-page branding (docs/milestones/SecureVault_Milestone4_Design.pdf,
// not pixel-copied — no image asset is extracted from the PDF): a banner-style
// shield (pointed bottom, like a ribbon) with a white keyhole cutout (a circle
// over a small trapezoid, the classic keyhole silhouette).
//
// The shield fill is `currentColor`, never a hardcoded hex, and the wrapping
// element carries Bootstrap's `text-primary` utility class — the same class
// every other screen already uses for its plain-text "SecureVault" wordmark
// (Login.jsx, ForgotPassword.jsx, TwoFactorSetup.jsx) — so
// the mark's colour tracks the `$primary` token in theme.scss rather than
// being baked in here (frontend rule 2).
//
// Only Welcome.jsx uses the full lockup (icon + wordmark + tagline); every
// other screen deliberately keeps its existing plain-text wordmark — retrofitting
// this everywhere is out of scope for PRD 0018 (see its "Out of scope" section).
function ShieldKeyholeIcon({ size }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 72"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
    >
      {/* Banner/shield body: flat-topped, pointed bottom, coloured via currentColor
          so it inherits text-primary from the wrapping element. */}
      <path
        d="M32 2 L60 10 V34 C60 52 48 64 32 70 C16 64 4 52 4 34 V10 Z"
        fill="currentColor"
      />
      {/* Keyhole cutout, rendered in white so it reads as a hole in the shield
          regardless of the current primary colour. */}
      <circle cx="32" cy="32" r="8" fill="#fff" />
      <path d="M27 38 H37 L34 52 H30 Z" fill="#fff" />
    </svg>
  );
}

/**
 * @param {'full'|'icon'} variant - 'full' renders the icon, wordmark, and
 *   (optionally) the tagline; 'icon' renders just the mark, for tighter spots.
 * @param {boolean} tagline - whether to show the "Secure Password Management
 *   System" line under the wordmark. Only meaningful for variant="full".
 * @param {number} size - icon pixel size (both width and height, it's square).
 */
export default function Logo({ variant = 'full', tagline = true, size = 56, className = '' }) {
  if (variant === 'icon') {
    return (
      <span className={`text-primary d-inline-flex ${className}`}>
        <ShieldKeyholeIcon size={size} />
      </span>
    );
  }

  return (
    <div className={`text-primary d-inline-flex align-items-center gap-3 ${className}`}>
      <ShieldKeyholeIcon size={size} />
      <div className="text-start">
        <div className="fw-bold fs-3 lh-1">SecureVault</div>
        {tagline && <div className="small text-muted mt-1">Secure Password Management System</div>}
      </div>
    </div>
  );
}
