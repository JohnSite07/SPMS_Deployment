import { useState, useEffect } from 'react';
import { Container, Table, Button, Spinner, Alert } from 'react-bootstrap';
import { getAuditLog } from '../services/audit';

export default function Activity() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Keyset pagination: the backend gives us nextCursor for the next page.
  // To allow "Previous" navigation, we keep a stack of cursors we used to get to the current page.
  const [currentCursor, setCurrentCursor] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [cursorHistory, setCursorHistory] = useState([]);
  
  const LIMIT = 20;

  useEffect(() => {
    let ignore = false;
    
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await getAuditLog(LIMIT, currentCursor);
        if (!ignore) {
          setEntries(data.entries);
          setNextCursor(data.nextCursor);
        }
      } catch (err) {
        if (!ignore) {
          setError(err.description || err.message || 'Failed to load activity log.');
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }
    
    load();
    return () => { ignore = true; };
  }, [currentCursor]);

  const handleNext = () => {
    if (nextCursor) {
      setCursorHistory([...cursorHistory, currentCursor]);
      setCurrentCursor(nextCursor);
    }
  };

  const handlePrevious = () => {
    if (cursorHistory.length > 0) {
      const historyCopy = [...cursorHistory];
      const prevCursor = historyCopy.pop();
      setCursorHistory(historyCopy);
      setCurrentCursor(prevCursor);
    }
  };

  const formatAction = (action) => {
    // Convert actions like 'login.succeeded' to 'Login Succeeded'
    return action
      .split('.')
      .map((word) => word.replace(/_/g, ' '))
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  return (
    <Container className="py-4">
      <h2>Activity</h2>
      <p className="text-muted">A complete record of your account activity.</p>
      
      {error && <Alert variant="danger">{error}</Alert>}
      
      {loading ? (
        <div className="text-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading...</span>
          </Spinner>
        </div>
      ) : (
        <>
          <Table responsive striped bordered hover className="mt-3">
            <thead>
              <tr>
                <th>Date & Time</th>
                <th>Action</th>
                <th>IP Address</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan="3" className="text-center py-4 text-muted">
                    No activity records found.
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.entryId}>
                    <td>{new Date(entry.timestamp).toLocaleString()}</td>
                    <td>{formatAction(entry.action)}</td>
                    <td className="text-monospace text-muted">{entry.ipAddress || 'System'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>

          <div className="d-flex justify-content-between align-items-center mt-3">
            <Button 
              variant="outline-secondary" 
              onClick={handlePrevious} 
              disabled={cursorHistory.length === 0}
            >
              &larr; Previous
            </Button>
            <span className="text-muted text-sm">
              Page {cursorHistory.length + 1}
            </span>
            <Button 
              variant="outline-secondary" 
              onClick={handleNext} 
              disabled={!nextCursor}
            >
              Next &rarr;
            </Button>
          </div>
        </>
      )}
    </Container>
  );
}
