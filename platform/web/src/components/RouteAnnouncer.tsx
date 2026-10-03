import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { documentTitle, routeTitle } from '../lib/titles';

/**
 * Tells everyone the page changed. The tab title follows the route (WCAG 2.4.2), a polite live region announces the new page to screen readers
 * (4.1.3), and keyboard focus moves to the start of the content so the next Tab does not start again from the top of the navigation (2.4.3).
 * Nothing happens on the first load (the browser announces that itself) or when only the query string changes.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation(); const first = useRef(true); const [said, setSaid] = useState('');
  useEffect(() => {
    document.title = documentTitle(pathname);
    if (first.current) { first.current = false; return; }
    setSaid(routeTitle(pathname)); document.getElementById('main')?.focus({ preventScroll: false });
    const t = setTimeout(() => setSaid(''), 3000); return () => clearTimeout(t);
  }, [pathname]);
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{said ? `${said}, page loaded` : ''}</div>;
}
