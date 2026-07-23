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
          // A real implementation would use a library like psl to get the exact root domain,
          // but for this simple extension we'll do a basic subdomain check
          const domainParts = domain.split('.');
          const rootDomain = domainParts.length >= 2 ? domainParts.slice(-2).join('.') : domain;

          const matchingItems = items.filter(item => {
            if (!item.url) return false;
            try {
              // Ensure we have a valid URL format for parsing
              const urlStr = item.url.startsWith('http') ? item.url : `https://${item.url}`;
              const itemHostname = new window.URL(urlStr).hostname;
              
              // Match if the vault item's hostname is a subdomain of the current site
              // OR if the current site is a subdomain of the vault item's root domain
              return domain.endsWith(itemHostname) || itemHostname.endsWith(rootDomain);
            } catch {
              // Fallback to basic string match if URL parsing fails
              return item.url.toLowerCase().includes(rootDomain.toLowerCase());
            }
          });

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
