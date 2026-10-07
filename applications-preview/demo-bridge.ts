// Tells the Applications page when the embedded demo is ready and which deliberate
// actions a visitor takes. Only fixed action names leave this frame, through
// postMessage to the same-origin parent; the frame itself has no network access
// (connect-src 'none'), and the parent decides whether anything is recorded.
import {
  demoMessageType,
  demoMessageVersion,
  type DemoAction,
  type GraphView,
} from '../research-portal/src/siteMetricsContract';

function post(message: Record<string, unknown>) {
  if (window.parent === window) return;
  window.parent.postMessage({ type: demoMessageType, version: demoMessageVersion, ...message }, window.location.origin);
}

function viewFromLabel(text: string): GraphView | undefined {
  const label = text.trim().toLowerCase();
  return label === 'vwc' || label === 'watering' || label === 'overlay' ? label : undefined;
}

function actionFor(target: Element): { action: DemoAction; view?: GraphView } | null {
  const launch = target.closest('.portal-launch-card');
  if (launch) {
    if (launch.classList.contains('is-health')) return { action: 'open_health' };
    const title = launch.querySelector('.portal-launch-title')?.textContent ?? '';
    return { action: /calibration/i.test(title) ? 'open_calibration' : 'open_experiment' };
  }
  if (target.closest('.experiment-graph-card, .expand-button')) return { action: 'expand_chart' };
  const viewButton = target.closest('.chart-view-toggle button');
  if (viewButton) {
    const view = viewFromLabel(viewButton.textContent ?? '');
    return { action: 'change_graph_view', ...(view ? { view } : {}) };
  }
  if (target.closest('.pot-toggle')) return { action: 'select_pot' };
  if (target.closest('.group-toggle')) return { action: 'toggle_pot_group' };
  if (target.closest('.preset-filter')) return { action: 'filter_pots' };
  if (target.closest('.time-range-control')) return { action: 'change_time_range' };
  if (target.closest('.canvas-chart')) return { action: 'inspect_chart' };
  const back = target.closest('.header-action, .support-back-button');
  if (back && /home/i.test(back.textContent ?? '')) return { action: 'navigate_home' };
  return null;
}

export function startDemoBridge() {
  let ready = false;
  const announceReady = () => {
    if (ready || !document.querySelector('.portal-launch-grid')) return;
    ready = true;
    post({ name: 'demo_ready' });
  };
  // Ready means the overview tiles have rendered, not merely that the script loaded.
  const observer = new MutationObserver(() => {
    announceReady();
    if (ready) observer.disconnect();
  });
  observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
  announceReady();

  // Only trusted (visitor-generated) pointer and keyboard activations count as interaction.
  const onActivate = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const match = actionFor(event.target);
    if (match) post({ name: 'demo_interacted', ...match });
  };
  document.addEventListener('click', onActivate, { capture: true });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Element && event.target.closest('.time-range-handle, .time-range-slider')) onActivate(event);
  }, { capture: true });
}
