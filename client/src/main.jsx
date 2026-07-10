import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';

// Single BrowserRouter for the whole app. BrowserRouter (clean paths) means
// the Express server must serve index.html as an SPA fallback for unknown
// client routes — see PRD 0010's serving follow-up.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
