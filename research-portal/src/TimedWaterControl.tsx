import { useEffect, useState } from 'react';
import type { ManualWaterClient } from './manualWaterApi';

export function TimedWaterControl({ client, pairingName, label }: { client: ManualWaterClient; pairingName: string; label: string }) {
  const [seconds, setSeconds] = useState(2);
  const [command, setCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!command) return;
    let cancelled = false;
    const check = async () => {
      try {
        const status = await client.timedStatus(command);
        if (cancelled) return;
        if (status.status === 'succeeded') {
          setMessage(status.result?.interrupted ? 'Watering ended early. Check the command record.' : 'Watering finished. Valve reported closed.');
          setBusy(false); setCommand(null);
        } else if (['failed', 'expired', 'canceled', 'quarantined'].includes(status.status)) {
          setMessage(status.error || `Watering ${status.status}. Check the command record before trying again.`);
          setBusy(false); setCommand(null);
        } else setMessage(status.status === 'running' ? 'Watering request is running…' : 'Request queued. Waiting for the controller…');
      } catch { if (!cancelled) setMessage('Status connection lost. Checking the same request…'); }
    };
    void check();
    const timer = window.setInterval(() => void check(), 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client, command]);
  return <div className="px-route-form">
    <label>Watering time
      <select aria-label="Watering time" value={seconds} disabled={busy} onChange={event => setSeconds(Number(event.target.value))}>
        {[2, 3, 4, 5].map(value => <option key={value} value={value}>{value} seconds</option>)}
      </select>
    </label>
    <button type="button" className="px-button is-primary" disabled={busy} onClick={async () => {
      setBusy(true); setMessage('Sending watering request…');
      try { setCommand(await client.timedWater(pairingName, seconds, crypto.randomUUID())); }
      catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed'); if ((error as { definite?: boolean })?.definite) setBusy(false); }
    }}>{busy ? 'Watering request pending' : `Water ${label} for ${seconds} seconds`}</button>
    <p className="px-muted px-small">The controller closes the valve automatically after the selected time.</p>
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
