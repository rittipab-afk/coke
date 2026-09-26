// Minimal PI Web API mock for testing pi-check.html. Each scenario listens on its own port.
// Scenarios: ok | nocors | unauth | notag
import http from 'node:http';

const DS = { Name: 'MOCKPI01', WebId: 'F1DSmock', IsConnected: true, ServerVersion: '3.4.440.477' };
const POINTS = [
  { Name: 'FIC101.PV', WebId: 'F1DPfic101pv', Descriptor: 'Feed flow', PointType: 'Float32', EngineeringUnits: 'm3/h' },
  { Name: 'FIC101.SV', WebId: 'F1DPfic101sv', Descriptor: 'Feed flow SV', PointType: 'Float32', EngineeringUnits: 'm3/h' },
  { Name: 'FIC101.MV', WebId: 'F1DPfic101mv', Descriptor: 'Feed flow MV', PointType: 'Float32', EngineeringUnits: '%' },
];

function send(res, status, body, cors, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (cors) {
    headers['Access-Control-Allow-Origin'] = origin || '*';
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Accept, Content-Type';
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(body == null ? '' : JSON.stringify(body));
}

function values(n, stepS, bad = 0) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const ts = new Date(now - (n - 1 - i) * stepS * 1000).toISOString();
    if (i < bad) return { Timestamp: ts, Value: { Name: 'I/O Timeout', Value: 246 }, Good: false };
    return { Timestamp: ts, Value: 25 + Math.sin(i / 20), Good: true };
  });
}

function handler(scenario) {
  return (req, res) => {
    const origin = req.headers.origin;
    const cors = scenario !== 'nocors';
    if (req.method === 'OPTIONS') return send(res, 204, null, cors, origin);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '');
    if (scenario === 'unauth') return send(res, 401, { Errors: ['Authorization has been denied for this request.'] }, true, origin);
    if (p === '/piwebapi') return send(res, 200, { Links: { Self: 'x', System: 'x', DataServers: 'x' } }, cors, origin);
    if (p === '/piwebapi/system') return send(res, 200, { ProductTitle: 'PI Web API 2023', ProductVersion: '1.19.0.0' }, cors, origin);
    if (p === '/piwebapi/system/userinfo') return send(res, 200, { IdentityType: 'WindowsIdentity', Name: 'GCM\\coke', IsAuthenticated: true }, cors, origin);
    if (p === '/piwebapi/dataservers') return send(res, 200, { Items: [DS] }, cors, origin);
    if (p === '/piwebapi/points') {
      const path = url.searchParams.get('path') || '';
      const pt = scenario === 'notag' ? null : POINTS.find((x) => `\\\\${DS.Name}\\${x.Name}`.toLowerCase() === path.toLowerCase());
      return pt ? send(res, 200, pt, cors, origin) : send(res, 404, { Errors: [`PI Point not found '${path}'.`] }, cors, origin);
    }
    if (p === `/piwebapi/dataservers/${DS.WebId}/points`) {
      const f = (url.searchParams.get('nameFilter') || '*').replace(/\*/g, '').toLowerCase();
      return send(res, 200, { Items: POINTS.filter((x) => x.Name.toLowerCase().includes(f)) }, cors, origin);
    }
    const m = /^\/piwebapi\/streams\/([^/]+)\/(interpolated|recorded)$/.exec(p);
    if (m && POINTS.some((x) => x.WebId === m[1])) {
      // recorded: heavily compressed (12 values in 10 min) to exercise the compression note
      return send(res, 200, { Items: m[2] === 'interpolated' ? values(601, 1, 3) : values(12, 50) }, cors, origin);
    }
    return send(res, 404, { Errors: ['Not found'] }, cors, origin);
  };
}

/** Start all scenarios; resolves to { ports: {ok, nocors, unauth, notag, closed}, close() }. */
export async function startMocks() {
  const servers = {};
  const ports = {};
  for (const s of ['ok', 'nocors', 'unauth', 'notag']) {
    servers[s] = http.createServer(handler(s));
    await new Promise((r) => servers[s].listen(0, '127.0.0.1', r));
    ports[s] = servers[s].address().port;
  }
  // a port that is guaranteed closed
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  ports.closed = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  return { ports, close: () => Promise.all(Object.values(servers).map((s) => new Promise((r) => s.close(r)))) };
}
