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
  // Home: experiment cards on the spine and the installation tools beside them.
  const card = target.closest('.px-exp-open');
  if (card) {
    const title = card.querySelector('.px-exp-name')?.textContent ?? '';
    return { action: /calibration/i.test(title) ? 'open_calibration' : 'open_experiment' };
  }
  const launch = target.closest('.portal-launch-card');
  if (launch) {
    if (launch.classList.contains('is-health')) return { action: 'open_health' };
    const title = launch.querySelector('.portal-launch-title')?.textContent ?? '';
    return { action: /calibration/i.test(title) ? 'open_calibration' : 'open_experiment' };
  }
  if (target.closest('.px-node a')) return { action: 'open_health' };
  if (target.closest('.px-crumb, .px-nav a')) return { action: 'navigate_home' };
  // Experiment: Overview (Waterline) and Pots.
  if (target.closest('.px-pot-chip, .px-table a, .pot-toggle')) return { action: 'select_pot' };
  if (target.closest('.px-tabs a, .px-waterline select, .px-segmented[aria-label="Measure"] button')) return { action: 'change_graph_view' };
  if (target.closest('.px-segmented[aria-label="Time window"] button, .time-range-control')) return { action: 'change_time_range' };
  if (target.closest('.px-chart, .canvas-chart')) return { action: 'inspect_chart' };
  if (target.closest('.expand-button')) return { action: 'expand_chart' };
  const viewButton = target.closest('.chart-view-toggle button');
  if (viewButton) {
    const view = viewFromLabel(viewButton.textContent ?? '');
    return { action: 'change_graph_view', ...(view ? { view } : {}) };
  }
  if (target.closest('.group-toggle')) return { action: 'toggle_pot_group' };
  if (target.closest('.preset-filter, .px-waterline input[type="checkbox"]')) return { action: 'filter_pots' };
  const back = target.closest('.header-action, .support-back-button');
  if (back && /home/i.test(back.textContent ?? '')) return { action: 'navigate_home' };
  return null;
}

export function startDemoBridge() {
  let lastExperimentHref: string | null = null;
  let restoreExperimentFocus = false;
  // Focus messages stay separate from the fixed analytics contract.
  const focusMessage = (action: string, title?: string) => {
    if (window.parent !== window) window.parent.postMessage({ type: 'exacth2o-demo-focus', action, title }, window.location.origin);
  };
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== 'exacth2o-demo-focus' || event.data.action !== 'close') return;
    restoreExperimentFocus = true;
    window.history.replaceState(null, '', window.location.pathname);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open], [role="dialog"]')) focusMessage('escape');
  });
  new MutationObserver(() => {
    if (!restoreExperimentFocus) return;
    const card = [...document.querySelectorAll<HTMLAnchorElement>('.px-exp-open')].find(link => link.getAttribute('href') === lastExperimentHref);
    if (card) { restoreExperimentFocus = false; card.focus({ preventScroll: true }); }
  }).observe(document.getElementById('root')!, {childList: true, subtree: true});
  let ready = false;
  const announceReady = () => {
    if (ready || !document.querySelector('.px-spine, .px-home')) return;
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
    const card = event.target.closest<HTMLAnchorElement>('.px-exp-open');
    if (card && event instanceof MouseEvent && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
      lastExperimentHref = card.getAttribute('href');
      focusMessage('open', card.querySelector('.px-exp-name')?.textContent || 'Experiment');
    }
    const match = actionFor(event.target);
    if (match) post({ name: 'demo_interacted', ...match });
  };
  document.addEventListener('click', onActivate, { capture: true });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Element && event.target.closest('.time-range-handle, .time-range-slider')) onActivate(event);
  }, { capture: true });
}
