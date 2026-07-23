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
});
