# ExactH2O

ExactH2O is a multi-tenant research portal, experiment service, telemetry
system, and approval-gated irrigation controller.

The researcher portal is natural-language first: researchers can inspect live
experiments, draft experiment specifications, propose supported setting
changes, schedule work, and create monitors. Reads execute immediately. Every
write is converted into a visible specification and requires review before it
can create database records or controller commands.

Start here:

- [Platform contracts and architecture](platform/README.md)
- [Production operations](platform/OPERATIONS.md)
- [Controller simulator](platform/controller-simulator/README.md)
- [Database baseline and restoration](supabase/baseline/README.md)
- [Supabase deployment requirements](supabase/README.md)
- [Research portal](research-portal/README.md)

The operation ledger distinguishes a command from a verified physical outcome.
A successful valve command does not prove water delivery; flow, pressure,
weight, or equivalent evidence is required for that claim.
