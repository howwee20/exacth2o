# exactH2O Research Portal

Authenticated researcher dashboard for the existing exactH2O Supabase project.

## What this is

- React/Vite frontend embedded in this website repo under `research-portal/`.
- Supabase Auth login using the browser-safe anon key.
- Invite-only account setup through a Supabase Edge Function. The browser sends
  an invite token, email, and password; the service-role key stays server-side.
- Portal settings can queue authenticated control commands through a Supabase
  Edge Function. The browser never writes hardware settings directly.
- Dashboard queries the existing tables:
  - `pairings`
  - `sensor_readings`
  - `valve_events`
  - `latest_device_state`
  - `project_control_commands`
- Data source prefixes:
  - imported Matt/Balena rows: `balena-export-v2:%`
  - future live device rows: `live-device:%`

## What this is not

- No service role key in the frontend.
- No open public signup that automatically grants project access.
- No fake live data.
- No direct browser-to-device irrigation actuation.
- No frontend mutation of valve mappings, calibrations, or board config.
- No device-side command executor in this static site; queued commands require
  a protected backend/device bridge to apply them to the controller.

## Local run

For the website entry point:

```bash
cd research-portal
npm install
cp .env.example .env.local
# replace VITE_SUPABASE_ANON_KEY with the project anon key
npm run build
cd ..
python3 -m http.server 8123 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8123/portal.html`.

The build writes browser-ready assets to `../portal-app/`, and the website's
root `portal.html` loads those assets directly.

For active React development:

```bash
cd research-portal
npm install
cp .env.example .env.local
# replace VITE_SUPABASE_ANON_KEY with the project anon key
npm run dev
```

The portal uses snapshot mode automatically when no `live-device:%` rows are available.

## Invite access

Apply the `project_invites` migration and deploy the `accept-invite` Edge Function.
Create a Matt project invite from the Supabase SQL editor:

```sql
select *
from public.create_project_invite('person@example.com');
```

Send the returned `invite_url`. The raw token is only returned once; the database
stores only its SHA-256 hash.
