// Background Service Worker

let vaultTabId = null;
// Maps a domain to an array of sendResponse callbacks waiting for credentials
const pendingRequests = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  if (request.type === 'REGISTER_VAULT_TAB') {
    vaultTabId = sender.tab.id;
    console.log(`Registered SecureVault tab: ${vaultTabId}`);
    return false; // No async response needed
  }

  if (request.type === 'CHECK_STATUS') {
    sendResponse({ connected: vaultTabId !== null });
    return false;
  }

  if (request.type === 'REQUEST_CREDENTIALS') {
    if (!vaultTabId) {
      console.log('No SecureVault tab registered.');
      sendResponse({ credentials: [] });
      return false;
    }

    const domain = request.domain;
    
    // Save the sendResponse callback
    if (!pendingRequests.has(domain)) {
      pendingRequests.set(domain, []);
    }
    pendingRequests.get(domain).push(sendResponse);

    // Ask the vault tab for credentials for this domain
    chrome.tabs.sendMessage(vaultTabId, {
      type: 'GET_CREDENTIALS_FOR_DOMAIN',
      domain: domain
    }, (response) => {
      // If the vault tab is closed or error, chrome.runtime.lastError will be set
      if (chrome.runtime.lastError) {
        console.error('Vault tab unresponsive:', chrome.runtime.lastError.message);
        vaultTabId = null; // Clear the dead tab
        
        // Fulfill pending requests with empty array
        const callbacks = pendingRequests.get(domain) || [];
        callbacks.forEach(cb => cb({ credentials: [] }));
        pendingRequests.delete(domain);
      }
    });

    // Return true to indicate we will call sendResponse asynchronously
    return true; 
  }

  if (request.type === 'FORWARD_CREDENTIALS') {
    const domain = request.domain;
    const callbacks = pendingRequests.get(domain) || [];
    
    // Fulfill all waiting pages for this domain
    callbacks.forEach(cb => cb({ credentials: request.credentials }));
    pendingRequests.delete(domain);
    
    return false;
  }
});

// Clean up if the vault tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === vaultTabId) {
    vaultTabId = null;
    console.log('SecureVault tab closed.');
  }
});
