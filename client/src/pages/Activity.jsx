import { useState, useEffect } from 'react';
import { Container, ListGroup, Button, Spinner, Alert, Card } from 'react-bootstrap';
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
  
  // Small enough that a page fits on screen without scrolling, which is what
  // makes the Previous/Next controls reachable rather than below the fold.
  const LIMIT = 7;

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
      
      {error && <Alert variant="danger" className="mt-3">{error}</Alert>}
      
      {loading ? (
        <div className="text-center py-5">
          <Spinner animation="border" variant="primary" role="status">
            <span className="visually-hidden">Loading...</span>
          </Spinner>
        </div>
      ) : (
        <>
          <Card className="shadow-sm border-0 mt-4 mb-4">
            <ListGroup variant="flush" className="rounded">
              {entries.length === 0 ? (
                <ListGroup.Item className="text-center py-4 text-muted border-0">
                  No activity records found.
                </ListGroup.Item>
              ) : (
                entries.map((entry) => (
                  <ListGroup.Item key={entry.entryId} className="d-flex justify-content-between align-items-center py-3 border-bottom">
                    <div className="ms-2 me-auto fw-bold text-dark">
                      {formatAction(entry.action)}
                    </div>
                    {/* The IP address is deliberately not shown. It is still
                        recorded on every entry for forensics, but it is noise
                        to the person reading their own history — what they
                        need is what happened and when. */}
                    <div className="text-muted small text-nowrap ms-3">
                      {new Date(entry.timestamp).toLocaleString()}
                    </div>
                  </ListGroup.Item>
                ))
              )}
            </ListGroup>
          </Card>

          <div className="d-flex justify-content-between align-items-center mt-4">
            <Button 
              variant="outline-primary" 
              onClick={handlePrevious} 
              disabled={cursorHistory.length === 0}
              className="px-4 rounded-pill"
            >
              &larr; Previous
            </Button>
            <span className="text-muted small fw-medium">
              Page {cursorHistory.length + 1}
            </span>
            <Button 
              variant="outline-primary" 
              onClick={handleNext} 
              disabled={!nextCursor}
              className="px-4 rounded-pill"
            >
              Next &rarr;
            </Button>
          </div>
        </>
      )}
    </Container>
  );
}
