import { Link, useSearchParams } from 'react-router-dom';
import { Attend } from './LabDetail';
import { Card } from '../components/ui';

/** Landing page for the coordinator's QR code: opens with the code in the link so a phone camera scan is one tap away from checking in. */
export default function LabAttend() {
  const [q] = useSearchParams(); const token = q.get('token') ?? '';
  return (
    <div><h1>Lab check-in</h1>
      <Card>{token ? <Attend initialToken={token} onDone={() => undefined} /> : <p>This page needs the code from the QR code shown in the lab. Scan it again, or open your <Link to="/labs">lab booking</Link> and enter the code there.</p>}</Card>
      <p><Link to="/labs">Back to labs</Link></p></div>
  );
}
