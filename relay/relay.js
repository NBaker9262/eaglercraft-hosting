// Shared world relay: Node port of the official EaglercraftX sp-relay
// (EaglerRelayJS, AGPL-3.0). Config is mounted at RELAY_CONFIG and written
// by the backend (admin settings -> render.js). The health endpoint lets
// the backend's alert loop notice outages.
import http from 'http';
import fs from 'node:fs';
import { EaglerSPRelay } from 'eaglerrelayjs';

const PORT = Number(process.env.RELAY_PORT || 8081);
const CONFIG = process.env.RELAY_CONFIG || '/data/relay-config.json';

// The backend writes the config at startup; wait for it (max ~1 min) so a
// cold start always runs with the real origin whitelist and TURN list.
async function waitForConfig(file, ms = 60_000) {
  const start = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - start > ms) return undefined;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const config = await waitForConfig(CONFIG);
if (config) console.log(`loaded relay config from ${CONFIG}`);
else {
  console.warn(`no config at ${CONFIG} after wait, using defaults`);
}
const relay = new EaglerSPRelay(config);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('Upgrade Required (WebSocket)');
});

server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));

server.listen(PORT, () => console.log(`shared world relay listening on :${PORT}`));
