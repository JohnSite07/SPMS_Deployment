import { get } from './api-client';

/**
 * Fetch a page of the user's audit log entries.
 * 
 * @param {number} limit The maximum number of entries to return.
 * @param {string|null} cursor The keyset cursor for the next page, or null for the first page.
 * @returns {Promise<{entries: Array, nextCursor: string|null}>}
 */
export async function getAuditLog(limit = 20, cursor = null) {
  let query = `limit=${limit}`;
  if (cursor) {
    query += `&cursor=${encodeURIComponent(cursor)}`;
  }
  
  return get(`/audit?${query}`);
}
