import { Link, useSearchParams } from 'react-router-dom';
import { Attend } from './LabDetail';
import { Card } from '../components/ui';
import { useT } from '../lib/i18n';

/** Landing page for the coordinator's QR code: opens with the code in the link so a phone camera scan is one tap away from checking in. */
export default function LabAttend() {
  const t = useT(); const [q] = useSearchParams(); const token = q.get('token') ?? '';
  return (
    <div><h1>{t('Lab check-in')}</h1>
      <Card>{token ? <Attend initialToken={token} onDone={() => undefined} /> : <p>{t('This page needs the code from the QR code shown in the lab. Scan it again, or open your lab booking and scan or enter the code there.')} <Link to="/labs">{t('Go to my labs')}</Link></p>}</Card>
      <p><Link to="/labs">{t('Back to labs')}</Link></p></div>
  );
}
