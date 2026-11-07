const sections = ['pairings', 'calibrations', 'sensors', 'valves', 'groups'];

async function readJson(fetchImpl, url, options, label, timeoutMs) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}

/** Read every authoritative section before publishing any configuration. */
export async function collectConfiguration(config, fetchImpl = globalThis.fetch) {
  const base = config.localApiBase.replace(/\/+$/, '');
  const names = ['system', ...sections];
  const results = await Promise.all(names.map(async name => [name, await readJson(
    fetchImpl, `${base}/${name}`, { method: 'GET' }, `Controller ${name}`,
    config.localApiTimeoutMs || 10000,
  )]));
  const values = Object.fromEntries(results);
  if (!values.system || Array.isArray(values.system) || typeof values.system !== 'object') {
    throw new Error('Controller system response is invalid');
  }
  const snapshot = {};
  for (const name of sections) {
    const value = Array.isArray(values[name]) ? values[name] : values[name]?.data;
    if (!Array.isArray(value)) throw new Error(`Controller ${name} response is incomplete`);
    snapshot[name] = value;
  }
  const boards = values.system.configuration?.boardConfigs;
  if (!Array.isArray(boards)) throw new Error('Controller board configuration is incomplete');
  snapshot.board_config = boards;
  return { device_id: config.deviceId, config: snapshot, system: values.system,
    endpoint_status: Object.fromEntries(names.map(name => [name, { ok: true }])) };
}

export async function publishConfiguration(config, fetchImpl = globalThis.fetch) {
  if (!config.deviceId || !config.projectId || !config.ingestToken || !config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('Device-push scope and credentials are required');
  }
  const payload = await collectConfiguration(config, fetchImpl);
  const result = await readJson(fetchImpl,
    `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/device_publish_configuration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}` },
      body: JSON.stringify({ device_token: config.ingestToken, payload }),
    }, 'Device configuration upload', config.supabaseRpcTimeoutMs || 15000);
  if (result?.ok !== true || result.project_id !== config.projectId || result.device_id !== config.deviceId) {
    throw new Error('Device configuration upload returned a different scope');
  }
  if (result.config_updated !== true) throw new Error('Controller configuration was retained rather than updated');
  return { ok: true, status: 200, body: result };
}
