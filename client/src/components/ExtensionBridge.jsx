import { useEffect } from 'react';
import { listCredentials } from '../services/credentials-service';
import { decryptField } from '../services/vault-crypto';
import * as vaultKeyStore from '../services/vault-key-store';

export default function ExtensionBridge() {
  useEffect(() => {
    // Notify the extension that the vault is open
    window.postMessage({ type: 'SECUREVAULT_READY' }, '*');

    async function handleMessage(event) {
      if (event.source !== window) return;
      const data = event.data;

      if (data.type === 'SECUREVAULT_REQUEST_CREDENTIALS') {
        const domain = data.domain;
        const key = vaultKeyStore.getVaultKey();
        
        if (!key) {
          window.postMessage({ type: 'SECUREVAULT_RESPONSE_CREDENTIALS', domain, credentials: [] }, '*');
          return;
        }

        try {
          const items = await listCredentials();
          // Find credentials that match the domain
          // A real implementation would parse the URL properly, but this is a simple check
          const matchingItems = items.filter(item => 
            item.url && item.url.toLowerCase().includes(domain.toLowerCase())
          );

          // Decrypt passwords for matching items
          const credentials = await Promise.all(matchingItems.map(async (item) => {
            const password = await decryptField(key, item.encryptedPassword);
            return {
              username: item.username,
              password: password
            };
          }));

          window.postMessage({
            type: 'SECUREVAULT_RESPONSE_CREDENTIALS',
            domain,
            credentials
          }, '*');

        } catch (err) {
          console.error("Extension bridge failed to fetch credentials:", err);
          window.postMessage({ type: 'SECUREVAULT_RESPONSE_CREDENTIALS', domain, credentials: [] }, '*');
        }
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return null; // This component doesn't render anything
}
