document.addEventListener('DOMContentLoaded', () => {
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const openVaultLink = document.getElementById('openVaultLink');

  // Check connection status with background script
  chrome.runtime.sendMessage({ type: 'CHECK_STATUS' }, (response) => {
    if (response && response.connected) {
      statusIndicator.className = 'status-indicator connected';
      statusText.textContent = 'Connected to SecureVault';
    } else {
      statusIndicator.className = 'status-indicator disconnected';
      statusText.textContent = 'Not Connected';
    }
  });

  // Example handler if we knew the prod URL, for now we just log
  openVaultLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'http://localhost:5173' });
  });

  const credentialsList = document.getElementById('credentialsList');

  // Request credentials for the current tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    const currentTab = tabs[0];
    if (!currentTab.url) return;

    let domain;
    try {
      domain = new URL(currentTab.url).hostname;
    } catch (e) {
      return;
    }

    credentialsList.innerHTML = '<div class="no-credentials">Loading credentials...</div>';

    chrome.runtime.sendMessage(
      { type: 'REQUEST_CREDENTIALS', domain: domain },
      (response) => {
        credentialsList.innerHTML = ''; // clear loading
        
        if (response && response.credentials && response.credentials.length > 0) {
          response.credentials.forEach(cred => {
            const item = document.createElement('div');
            item.className = 'credential-item';
            
            const title = document.createElement('strong');
            title.textContent = cred.username || 'No Username';
            
            const sub = document.createElement('span');
            sub.textContent = 'Click to autofill';
            
            item.appendChild(title);
            item.appendChild(sub);
            
            item.addEventListener('click', () => {
              // Send message to content script in the active tab to autofill THIS credential
              chrome.tabs.sendMessage(currentTab.id, {
                type: 'FILL_CREDENTIAL',
                credential: cred
              });
              window.close(); // Close the popup
            });
            
            credentialsList.appendChild(item);
          });
        } else {
          credentialsList.innerHTML = '<div class="no-credentials">No credentials found for this site.</div>';
        }
      }
    );
  });
});
