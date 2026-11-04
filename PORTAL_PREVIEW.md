# Portal homepage release

The website and portal share the approved compact typography and buttons. Rhee Lab, Walker Pi and Chamber are separate collapsible sections. The primary experiment catalog and controller actions retain their existing authorization and data paths.

Walker experiments are stored in `walker_portal_experiments`, isolated from the irrigation experiment catalog. Creation selects verified Walker sensors and starts the observation window at creation time. The backend validates installation access and never writes pairings, targets, calibrations, control plans or commands. Historical Walker archives remain untouched.

Website analytics uses the existing seven-day aggregate service. The local design preview at `http://127.0.0.1:5178/browser-tests/portal-home-preview.html` keeps clearly labeled sample data; production uses actual portal records.

The website slideshow and homepage graph continue automatically without visible pause/replay buttons.

Retain both local worktrees for further review. Experiment-screen design changes remain a separate next step.
