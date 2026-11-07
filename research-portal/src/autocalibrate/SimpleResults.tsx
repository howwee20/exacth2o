import { RestoreStep } from "./RestorePots";
import { potName } from "./present";
import { valveLabel, type WorkspaceContext } from "./workspaceContext";

/** Results and finish stay on this page. Applying new connections is optional. */
export function SimpleResults({ ctx, onReview }: { ctx: WorkspaceContext; onReview: () => void }) {
  const result = ctx.result;
  if (!result) return <p role="status">{ctx.resultError ?? "Loading results…"}</p>;
  const matches = new Map(result.proposals.map(match => [match.valveKey, match]));
  const unmatched = new Map(result.unresolved.map(item => [item.valveKey, item]));
  return <>
    <section className="settings-card ac-step" aria-labelledby="ac-simple-results">
      <h3 id="ac-simple-results">Results</h3>
      <p>{matches.size} matched · {result.pots.length - matches.size} unmatched</p>
      <div className="settings-table-wrap">
        <table className="settings-table">
          <thead><tr><th>Valve</th><th>Sensor in pot</th><th>Result</th></tr></thead>
          <tbody>{result.pots.map(pot => {
            const match = matches.get(pot.valveKey);
            return <tr key={pot.valveKey}>
              <td>{valveLabel(pot.valveKey)}</td>
              <td>{match ? potName(ctx.potForSensor.get(match.proposedSensorKey), match.proposedSensorKey) : "—"}</td>
              <td>{match ? "Matched" : unmatched.get(pot.valveKey)?.detail ?? "Unmatched"}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="settings-muted">Measured matches are shown above. Uncertain or unapplied connections keep automatic watering off.</p>
      <button type="button" className="ac-link" onClick={onReview}>Review connection changes (optional)</button>
    </section>
    <RestoreStep ctx={ctx} onBack={null} compact />
  </>;
}
