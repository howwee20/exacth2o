-- Restore the experiment completion and restore audit events.
--
-- 20260728010000 replaced experiment_audit_events_event_type_check without 'completed' and
-- 'restored', but complete_assistant_experiment and restore_assistant_experiment still insert
-- those values, so completing or restoring an experiment fails the check. This widens the check
-- to the union of every value written by current functions. It changes no row, no controller
-- configuration and no permission. Rollback: re-create the 20260728010000 constraint (only if no
-- 'completed'/'restored' rows were written in between).

alter table public.experiment_audit_events
  drop constraint if exists experiment_audit_events_event_type_check;

alter table public.experiment_audit_events
  add constraint experiment_audit_events_event_type_check
  check (
    event_type in (
      'legacy_imported',
      'published_sensing',
      'revision_created',
      'activation_requested',
      'activation_succeeded',
      'activation_failed',
      'completed',
      'archived',
      'restored'
    )
  );
