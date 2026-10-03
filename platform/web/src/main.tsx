import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth';
import { PrefsProvider } from './prefs';
import { registerServiceWorker } from './lib/pwa';
import './styles.css';

registerServiceWorker();
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><AuthProvider><PrefsProvider><App /></PrefsProvider></AuthProvider></BrowserRouter></StrictMode>);
