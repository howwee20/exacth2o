# Gas mixer and lighting schedules

Schedules are shared within the existing Gas Mixer installation. Researchers with control access can create, edit, pause, resume, and delete them. The existing native controls, remote screen, and lighting controls remain available.

- Lab timezone: America/Detroit. Daily/custom weekday and one-time schedules, start/end dates, exact gas recipes, and optional lighting intensity.
- PostgreSQL cron checks every five seconds. It stores due occurrences and advances the next run in the same transaction, with a unique schedule/version/due-time constraint and an advisory lock. No browser, persistent user JWT, new device software, or Mac connection is needed.
- Only bounded security-definer RPCs are available to researchers. Permissions and owner revocation are rechecked during execution. Direct table and worker access is denied.
- Scheduled gas recipes use the existing `set_field` bridge. When composition changes, flow is set to zero; decreasing ratios precede increasing ratios, total flow is restored, and LI-COR is enabled last if requested. Commands wait for acknowledgments and matching controller state. A no-op recipe is recorded as already applied.
- Combined routines complete gas before lighting. This is not atomic across two devices. Run history distinguishes partial execution, controller acknowledgment, and physical verification.
- Commands retain the existing 15/20-second expiry and revision checks. A routine must finish within two minutes. Failed or missed routines pause and are not replayed later; check current equipment state before resuming.
- Manual native commands, remote screen taps, and entering a remote-control session pause schedules for that device. Pausing cancels queued steps, but already accepted commands may finish. It does not turn equipment off. Pause schedules before using local controls or the legacy local lighting timeline.
- Daylight saving: skip nonexistent spring times; use the standard-time occurrence once for repeated fall times. Schedules for the same device need three minutes of separation.
- No notification emails are sent. The portal shows results and warns if the cron worker has not succeeded within 30 seconds.

Deployment: apply `supabase/migrations/20260910140000_chamber_schedules.sql` and deploy the built portal. The migration creates no active schedules. Rollback operationally by unscheduling `exacth2o-chamber-schedules` and disabling `chamber_schedules.enabled`; retain run history. Removing the UI does not disable stored schedules.

Verification for this release is limited to static/build checks and database transactions that were rolled back. No live gas or lighting actuation was performed. Researcher acceptance testing remains outstanding.

Lifecycle polish: Resume is a direct action that revalidates the saved schedule and permissions. Ended schedules offer Change time. Delete pauses the schedule, hides it from the active list, and retains run history. Stale versions are rejected so another researcher’s edits cannot be silently deleted or resumed. Selected weekdays have checkmarks and a text summary; help is a small hover/focus/tap icon.
