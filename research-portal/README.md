# exactH2O Research Portal

Authenticated researcher dashboard for the existing exactH2O Supabase project.

## What this is

- React/Vite frontend embedded in this website repo under `research-portal/`.
- Supabase Auth login using the browser-safe anon key.
- Dashboard queries the existing tables:
  - `pairings`
  - `sensor_readings`
  - `valve_events`
  - `latest_device_state`
- Data source prefixes:
  - imported Matt/Balena rows: `balena-export-v2:%`
  - future live device rows: `live-device:%`

## What this is not

- No new database schema.
- No service role key in the frontend.
- No fake live data.
- No command/control or irrigation actuation.
- No new valve mappings.

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
