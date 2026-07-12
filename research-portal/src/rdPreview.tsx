import replayFixture from "./rdReplayFixture.json";
import { ResponseCurveLab } from "./ResponseCurveLab";
import type { RdLabSnapshot } from "./rdTypes";

export default function RdPreview() {
  return (
    <main className="dashboard-shell portal-admin-shell rd-preview-shell">
      <header className="dashboard-header">
        <a className="dashboard-logo" href="#preview">exact<span>H</span>2<span>O</span></a>
        <div className="rd-preview-label">LOCAL REPLAY · SYNTHETIC DATA</div>
      </header>
      <ResponseCurveLab snapshot={replayFixture as RdLabSnapshot} />
    </main>
  );
}

