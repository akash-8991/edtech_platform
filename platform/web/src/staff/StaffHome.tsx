import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { Card } from '../components/ui';
import { AREAS, canSee, isLearner } from '../lib/roles';

export default function StaffHome() {
  const { me } = useAuth(); const areas = (Object.keys(AREAS) as (keyof typeof AREAS)[]).filter((a) => canSee(me?.roles, a));
  return (
    <div>
      <h1>Welcome, {me?.name}</h1>
      {!areas.length ? <Card><p>Your role does not have a screen in this console yet. Your administrator can tell you where to do your work.</p></Card> : areas.map((a) => (
        <Card key={a} title={<Link to={`/staff/${a}`}>{AREAS[a].title}</Link>}><p>{AREAS[a].blurb}</p></Card>))}
      {isLearner(me?.roles) && <p><Link to="/">Go to the learner portal</Link></p>}
    </div>
  );
}
