import { useEffect, useState } from 'react';
import { isClosingSoon, timeLeft } from '../api';

interface CountdownProps {
  closesAt: number;
  id?: string;
  /**
   * The lot is no longer accepting bids. A buy-it-now purchase settles a lot
   * before `closes_at` elapses, so the gate time is still in the future even
   * though bidding is over — without this the board would keep counting down
   * to a gate that already closed early.
   */
  stopped?: boolean;
}

export default function Countdown({ closesAt, id, stopped }: CountdownProps) {
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    if (stopped) return;
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(tick);
  }, [id, stopped]);

  const past = stopped || now >= closesAt;
  const left = timeLeft(closesAt, now);
  const soon = isClosingSoon(closesAt, now);

  if (past) {
    return <span className="cell-mono muted">CLOSED</span>;
  }
  return (
    <span className={`cell-mono${soon ? ' closing-soon' : ''}`} aria-label={`Closes in ${left}`}>
      {left}
    </span>
  );
}
