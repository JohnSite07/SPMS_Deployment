// This content script runs on all pages. It serves two purposes:
// 1. On normal pages: Detects login forms and requests credentials.
// 2. On SecureVault webapp: Acts as a bridge between the extension and the React app.

// --- 1. NORMAL PAGE LOGIC ---
function detectAndFillForms() {
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  if (passwordInputs.length === 0) return;

  // Found a login form. Request credentials from background.
  chrome.runtime.sendMessage(
    { type: 'REQUEST_CREDENTIALS', domain: window.location.hostname },
    (response) => {
      if (response && response.credentials && response.credentials.length > 0) {
        // Simple autofill logic: grab the first matching credential
        const cred = response.credentials[0];
        
        passwordInputs.forEach((pwdInput) => {
          pwdInput.value = cred.password;
          pwdInput.dispatchEvent(new Event('input', { bubbles: true })); // trigger React/Vue handlers

          // Try to find a username input nearby
          const form = pwdInput.closest('form');
          if (form) {
            const userInput = form.querySelector('input[type="text"], input[type="email"]');
            if (userInput && cred.username) {
              userInput.value = cred.username;
              userInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        });
      }
    }
  );
}

// Run the detection on load
window.addEventListener('load', detectAndFillForms);


// --- 2. SECUREVAULT WEBAPP LOGIC ---

// Listen for messages from the SecureVault React app via window.postMessage
window.addEventListener('message', (event) => {
  // We only accept messages from ourselves
  if (event.source !== window) return;

  const data = event.data;

  // The webapp says it's ready and holds the vault
  if (data.type === 'SECUREVAULT_READY') {
    chrome.runtime.sendMessage({ type: 'REGISTER_VAULT_TAB' });
  }

  // The webapp is responding with decrypted credentials for a domain
  if (data.type === 'SECUREVAULT_RESPONSE_CREDENTIALS') {
    chrome.runtime.sendMessage({
      type: 'FORWARD_CREDENTIALS',
      domain: data.domain,
      credentials: data.credentials
    });
  }
});

// Listen for messages from background.js asking for credentials
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_CREDENTIALS_FOR_DOMAIN') {
    // We are the vault tab. Forward the request to the React app via postMessage.
    window.postMessage({
      type: 'SECUREVAULT_REQUEST_CREDENTIALS',
      domain: request.domain
    }, '*');
    
    // We can't respond immediately because postMessage is async.
    // The background script will wait for FORWARD_CREDENTIALS instead.
    sendResponse({ status: 'request_forwarded' });
  }
});
