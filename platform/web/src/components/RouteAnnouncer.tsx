import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { documentTitle, routeTitle } from '../lib/titles';
import { useT } from '../lib/i18n';

/**
 * Tells everyone the page changed. The tab title follows the route (WCAG 2.4.2), a polite live region announces the new page to screen readers
 * (4.1.3), and keyboard focus moves to the start of the content so the next Tab does not start again from the top of the navigation (2.4.3).
 * Nothing happens on the first load (the browser announces that itself) or when only the query string changes.
 */
export function RouteAnnouncer() {
  const t = useT(); const { pathname } = useLocation(); const first = useRef(true); const [said, setSaid] = useState('');
  useEffect(() => { document.title = documentTitle(pathname); }, [pathname, t]); // the tab title also follows a language change
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSaid(routeTitle(pathname)); document.getElementById('main')?.focus({ preventScroll: false });
    const timer = setTimeout(() => setSaid(''), 3000); return () => clearTimeout(timer);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{said ? t('{page}, page loaded', { page: said }) : ''}</div>;
}
