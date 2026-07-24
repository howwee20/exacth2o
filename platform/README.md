# ExactH2O platform contracts

`contracts/` is the canonical machine-readable boundary shared by the portal,
Supabase services, controller executor, simulator, and tests.

- `capabilities.json` defines what the platform can read or change, who may
  request it, the required approval class, and the controller commands it can
  compile.
- `identity.schema.json` defines the complete project-to-pot-to-hardware
  identity chain.
- `operation.schema.json` defines the lifecycle used to trace researcher intent
  through approval, execution, and evidence.

Run `node scripts/generate-platform-contracts.mjs` after changing a contract.
CI runs the same command with `--check` and fails if a consumer has drifted.

These contracts describe authority. They do not grant it: database RLS, Edge
Function policy, controller state gates, and executor safety checks remain the
enforcement layers.

The contracts are accompanied by:

- `controller-simulator/`, which tests experiment and watering behavior without
  greenhouse hardware;
- the database operation ledger and identity tables in
  `supabase/migrations/20260724220000_create_platform_foundation_v1.sql`;
- [OPERATIONS.md](OPERATIONS.md), the deployment, recovery, and commissioning
  runbook.
