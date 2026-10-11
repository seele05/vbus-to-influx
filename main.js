'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const { SerialPort } = require('serialport');
const { Connection, TcpConnectionEndpoint, Specification, HeaderSetConsolidator } = require('resol-vbus');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const { objectIdOf, transformValue } = require('./lib/iobroker-compat');
const config = require('./config');


const spec = new Specification({ language: config.language ?? 'de' });

// Ueber das Web-Interface geaenderte Werte liegen hier und ueberlagern config.js,
// damit die kommentierte config.js unveraendert bleibt.
const OVERRIDE_PATH = path.join(__dirname, 'config.local.json');

const EDITABLE_KEYS = ['url', 'token', 'org', 'bucket', 'namespace', 'from'];


function loadOverrides() {
    try {
        return JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`config.local.json unlesbar (${err.message}), wird ignoriert`);
        }
        return {};
    }
}


function saveOverrides(overrides) {
    fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(overrides, null, 4) + '\n');
}


let influxSettings = { ...config.influx, ...(loadOverrides().influx ?? {}) };
let influxWriteApi = createWriteApi();

function createWriteApi() {
    return new InfluxDB({
        url: influxSettings.url,
        token: influxSettings.token ?? '',
    }).getWriteApi(influxSettings.org ?? '', influxSettings.bucket, 'ms');
}


// Whitelist der zu schreibenden Datenpunkte. null/undefined => alle.
const datapointFilter = Array.isArray(config.datapoints) ? new Set(config.datapoints) : null;

// Shared state fuer das Web-Interface
const portStates = new Map();   // channel -> { path, status, lastSeen, clients }
const latestFields = new Map(); // objectId -> { name, objectId, textValue, value, logged, channel, timestamp }
const startedAt = Date.now();

const influxState = {
    status: 'unknown',   // unknown | ok | error
    version: null,
    message: null,
    lastCheck: null,
    lastError: null,
    lastWrite: null,
    writes: 0,
    failures: 0,
};

// Registry fuer den TCP-Endpunkt und aktive TCP-Clients je Kanal
const serialPorts = [];
const tcpClients = new Map();


function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}


function clientsFor(channel) {
    if (!tcpClients.has(channel)) {
        tcpClients.set(channel, new Set());
    }
    return tcpClients.get(channel);
}


/**
 * Fragt den /health-Endpunkt ab. Den gibt es sowohl bei InfluxDB 1.8 als auch 2.x.
 */
async function checkInflux() {
    const url = String(influxSettings.url ?? '').replace(/\/+$/, '') + '/health';

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        const body = await res.json();

        influxState.status = (body.status === 'pass') ? 'ok' : 'error';
        influxState.version = body.version ?? null;
        influxState.message = body.message ?? null;
        influxState.lastError = (body.status === 'pass') ? null : JSON.stringify(body);
    } catch (err) {
        influxState.status = 'error';
        influxState.version = null;
        influxState.message = null;
        influxState.lastError = err.message;
    }

    influxState.lastCheck = Date.now();
}


/**
 * Schreibt einen Datenpunkt im ioBroker-Schema: ein Measurement pro Datenpunkt,
 * keine Tags, Felder `value` / `ack` / `from` / `q`. Der Typ von `value` muss
 * dem der bestehenden Serie entsprechen, sonst weist InfluxDB den Punkt ab.
 */
function buildPoint(objectId, value, timestamp) {
    const point = new Point(`${influxSettings.namespace ?? 'resol.0'}.${objectId}`);

    if (typeof value === 'boolean') {
        point.booleanField('value', value);
    } else if (typeof value === 'string') {
        point.stringField('value', value);
    } else {
        point.floatField('value', value);
    }

    point.booleanField('ack', true);
    point.stringField('from', influxSettings.from ?? 'system.adapter.resol.0');
    point.floatField('q', 0);
    point.timestamp(timestamp);

    return point;
}


function handleHeaderSet(portConfig, headerSet) {
    const packetFields = spec.getPacketFieldsForHeaders(headerSet.getSortedHeaders());
    const timestamp = headerSet.timestamp;
    const points = [];

    const record = (objectId, name, value, textValue) => {
        const logged = !datapointFilter || datapointFilter.has(objectId);

        latestFields.set(objectId, {
            objectId,
            name,
            value,
            textValue,
            logged,
            channel: portConfig.channel,
            timestamp,
        });

        if (logged && value !== null && value !== undefined) {
            points.push(buildPoint(objectId, value, timestamp));
        }
    };

    for (const packetField of packetFields) {
        const objectId = objectIdOf(packetField);
        const { value, extra } = transformValue(spec, packetField);

        record(objectId, packetField.name, value, packetField.formatTextValue());

        if (extra) {
            record(objectId + extra.suffix, `${packetField.name} (aktiv)`, extra.value, String(extra.value));
        }
    }

    const state = portStates.get(portConfig.channel);
    if (state) {
        state.lastSeen = timestamp;
    }

    if (points.length === 0) {
        return;
    }

    const writeApi = influxWriteApi;
    writeApi.writePoints(points);
    writeApi.flush().then(() => {
        influxState.lastWrite = Date.now();
        influxState.writes += points.length;
        influxState.lastError = null;
        console.log(`[ch${portConfig.channel}] ${points.length} Datenpunkte -> InfluxDB`);
    }).catch(err => {
        influxState.failures += 1;
        influxState.lastError = err.message;
        influxState.status = 'error';
        console.error(`[ch${portConfig.channel}] InfluxDB-Schreibfehler:`, err.message);
    });
}


/**
 * Uebernimmt geaenderte InfluxDB-Einstellungen zur Laufzeit: Overrides sichern,
 * Schreib-Client neu aufbauen, Erreichbarkeit sofort neu pruefen.
 */
async function applyInfluxSettings(patch) {
    const next = { ...influxSettings };

    for (const key of EDITABLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
            next[key] = String(patch[key] ?? '');
        }
    }

    if (!/^https?:\/\/.+/.test(next.url)) {
        throw new Error('url muss mit http:// oder https:// beginnen');
    }
    if (!next.bucket) {
        throw new Error('bucket darf nicht leer sein');
    }

    const overrides = loadOverrides();
    overrides.influx = Object.fromEntries(EDITABLE_KEYS.map(k => [k, next[k]]));
    saveOverrides(overrides);

    const previous = influxWriteApi;
    influxSettings = next;
    influxWriteApi = createWriteApi();

    await previous.close().catch(() => {});
    await checkInflux();

    console.log(`InfluxDB-Einstellungen geaendert -> ${influxSettings.url} bucket=${influxSettings.bucket}`);
}


/**
 * Oeffnet den seriellen Port genau einmal und faechert den Rohstrom auf:
 * an alle TCP-Clients (Rolle der alten serial-to-tcp-Bridge) und an den
 * VBus-Parser (Rolle des ioBroker-Adapters).
 */
async function runPort(portConfig) {
    const channel = portConfig.channel;

    portStates.set(channel, {
        path: portConfig.path,
        status: 'disconnected',
        lastSeen: null,
        clients: 0,
    });

    const parser = new Connection();
    const hsc = new HeaderSetConsolidator({
        interval: (config.vbusInterval ?? 15) * 1000,
        timeToLive: ((config.vbusInterval ?? 15) * 1000) + 1000,
    });

    parser.on('packet', p => hsc.addHeader(p));
    parser.on('datagram', d => hsc.addHeader(d));
    hsc.on('headerSet', hs => handleHeaderSet(portConfig, hs));
    hsc.startTimer();

    let backoff = 2_000;

    while (true) {
        portStates.get(channel).status = 'connecting';
        console.log(`[ch${channel}] oeffne ${portConfig.path} …`);

        let port;
        try {
            port = await new Promise((resolve, reject) => {
                const p = new SerialPort({
                    path: portConfig.path,
                    baudRate: portConfig.baudrate ?? 9600,
                }, err => (err ? reject(err) : resolve(p)));
            });
        } catch (err) {
            console.error(`[ch${channel}] ${err.message}`);
            portStates.get(channel).status = 'disconnected';
            console.log(`[ch${channel}] neuer Versuch in ${backoff / 1000}s …`);
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 30_000);
            continue;
        }

        portStates.get(channel).status = 'connected';
        console.log(`[ch${channel}] verbunden`);
        backoff = 2_000;

        const entry = { channel, port };
        serialPorts.push(entry);

        port.on('readable', () => {
            let chunk;
            while ((chunk = port.read())) {
                for (const socket of clientsFor(channel)) {
                    socket.write(chunk);
                }
                parser.receive(new Date(), chunk);
            }
        });

        await new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (!done) {
                    done = true;
                    resolve();
                }
            };
            port.on('error', err => {
                console.error(`[ch${channel}] Portfehler: ${err.message}`);
                finish();
            });
            port.on('close', finish);
            port.on('end', finish);
        });

        const idx = serialPorts.indexOf(entry);
        if (idx >= 0) {
            serialPorts.splice(idx, 1);
        }

        portStates.get(channel).status = 'disconnected';
        console.log(`[ch${channel}] getrennt`);

        try {
            if (port.isOpen) port.close();
        } catch (_) { /* egal */ }

        console.log(`[ch${channel}] neuer Versuch in ${backoff / 1000}s …`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
    }
}


/**
 * TCP-Endpunkt in der Rolle der alten serial-to-tcp-Bridge, damit weitere
 * VBus-Clients unveraendert weiterlaufen koennen.
 */
async function startTcpEndpoint() {
    const channels = config.serialPorts.reduce((memo, portConfig) => {
        memo[portConfig.channel] = `VBus ${portConfig.channel}: ${portConfig.path}`;
        return memo;
    }, []);

    const endpoint = new TcpConnectionEndpoint({
        port: config.tcp.port,
        channels,
    });

    endpoint.on('connection', connectionInfo => {
        const channel = +(connectionInfo.channel || '0');
        const entry = serialPorts.find(p => p.channel === channel);
        const socket = connectionInfo.socket;

        if (!entry) {
            console.log(`[tcp] weise Verbindung fuer unbekannten Kanal ${channel} ab`);
            socket.end();
            return;
        }

        console.log(`[tcp] Client verbunden (Kanal ${channel})`);

        const clients = clientsFor(channel);
        clients.add(socket);
        const state = portStates.get(channel);
        if (state) state.clients = clients.size;

        const remove = () => {
            clients.delete(socket);
            if (state) state.clients = clients.size;
        };

        socket.on('error', err => {
            console.error(`[tcp] ${err.message}`);
            remove();
        });
        socket.on('end', () => {
            console.log(`[tcp] Client getrennt (Kanal ${channel})`);
            remove();
        });
        socket.on('readable', () => {
            let chunk;
            while ((chunk = socket.read())) {
                entry.port.write(chunk);
            }
        });
    });

    await endpoint.start();
    console.log(`TCP-Endpunkt -> Port ${config.tcp.port}`);
}


const PAGE = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VBus Monitor</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e2e8f0; padding: 24px; min-height: 100vh; }
    h1 { font-size: 1.2rem; font-weight: 600; margin-bottom: 20px; color: #f1f5f9; letter-spacing: -0.01em; }
    .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 28px; }
    .card { background: #1a1d2e; border: 1px solid #252840; border-radius: 10px; padding: 14px 18px; min-width: 230px; }
    .card .label { font-size: 0.75rem; color: #64748b; margin-bottom: 8px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
    .card .sub { font-size: 0.8rem; color: #94a3b8; margin-bottom: 10px; font-family: ui-monospace, monospace; word-break: break-all; }
    .status-row { display: flex; align-items: center; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .dot.connected, .dot.ok { background: #22c55e; box-shadow: 0 0 8px #22c55e88; }
    .dot.disconnected, .dot.error { background: #ef4444; }
    .dot.connecting, .dot.unknown { background: #f59e0b; animation: blink 1s ease-in-out infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
    .status-text { font-size: 0.9rem; font-weight: 500; }
    .status-text.connected, .status-text.ok { color: #22c55e; }
    .status-text.disconnected, .status-text.error { color: #ef4444; }
    .status-text.connecting, .status-text.unknown { color: #f59e0b; }
    .note { font-size: 0.72rem; color: #475569; margin-top: 6px; }
    .note.bad { color: #f87171; }
    .section { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: #475569; margin: 0 0 10px; }
    .meta { font-size: 0.75rem; color: #475569; margin-bottom: 14px; }
    details { background: #151824; border: 1px solid #252840; border-radius: 10px; margin-bottom: 28px; }
    summary { cursor: pointer; padding: 12px 18px; font-size: 0.8rem; font-weight: 600; color: #94a3b8; user-select: none; }
    summary:hover { color: #e2e8f0; }
    .form { padding: 4px 18px 18px; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .field input { background: #0f1117; border: 1px solid #252840; border-radius: 6px; padding: 8px 10px; color: #e2e8f0; font-family: ui-monospace, monospace; font-size: 0.82rem; }
    .field input:focus { outline: none; border-color: #3b82f6; }
    .field .hint { font-size: 0.68rem; color: #3f4c60; }
    .actions { grid-column: 1 / -1; display: flex; align-items: center; gap: 14px; }
    button { background: #2563eb; border: 0; border-radius: 6px; color: #fff; padding: 9px 20px; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #1e293b; color: #64748b; cursor: default; }
    #formMsg { font-size: 0.78rem; }
    #formMsg.ok { color: #4ade80; }
    #formMsg.bad { color: #f87171; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    thead th { text-align: left; padding: 8px 10px; color: #64748b; font-weight: 500; font-size: 0.75rem; border-bottom: 1px solid #1a1d2e; }
    tbody td { padding: 9px 10px; border-bottom: 1px solid #151824; }
    tbody tr:hover td { background: #1a1d2e; }
    tbody tr.muted td { opacity: 0.45; }
    .field-name { color: #e2e8f0; }
    .field-value { font-family: ui-monospace, monospace; color: #93c5fd; font-size: 0.9rem; }
    .field-id { color: #475569; font-size: 0.7rem; font-family: ui-monospace, monospace; }
    .field-age { color: #334155; font-size: 0.75rem; }
    .badge { font-size: 0.65rem; padding: 2px 7px; border-radius: 20px; font-weight: 600; }
    .badge.on { background: #14331f; color: #4ade80; }
    .badge.off { background: #1e2130; color: #64748b; }
    .no-data { color: #475569; font-size: 0.85rem; padding: 16px 10px; }
  </style>
</head>
<body>
  <h1>VBus Monitor</h1>

  <div class="cards" id="cards">—</div>

  <details id="cfg">
    <summary>InfluxDB-Einstellungen</summary>
    <div class="form" id="form">
      <div class="field"><label for="f-url">URL</label><input id="f-url" spellcheck="false"><span class="hint">z. B. http://influxdb.example:8086</span></div>
      <div class="field"><label for="f-bucket">Bucket</label><input id="f-bucket" spellcheck="false"><span class="hint">bei InfluxDB 1.x: datenbank/autogen</span></div>
      <div class="field"><label for="f-token">Token</label><input id="f-token" spellcheck="false"><span class="hint">1.x ohne Auth: leer, sonst benutzer:passwort</span></div>
      <div class="field"><label for="f-org">Org</label><input id="f-org" spellcheck="false"><span class="hint">bei InfluxDB 1.x leer</span></div>
      <div class="field"><label for="f-namespace">Namespace</label><input id="f-namespace" spellcheck="false"><span class="hint">Praefix der Measurement-Namen</span></div>
      <div class="field"><label for="f-from">from-Feld</label><input id="f-from" spellcheck="false"><span class="hint">Inhalt des Feldes "from"</span></div>
      <div class="actions">
        <button id="save">Speichern und anwenden</button>
        <span id="formMsg"></span>
      </div>
    </div>
  </details>

  <div class="section">Datenpunkte</div>
  <div class="meta" id="meta">—</div>
  <table>
    <thead><tr><th>Feld</th><th>Wert</th><th>InfluxDB</th><th>Datenpunkt-ID</th><th>Alter</th></tr></thead>
    <tbody id="tbody"><tr><td colspan="5" class="no-data">Warte auf Daten…</td></tr></tbody>
  </table>

<script>
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function age(ts) {
    if (!ts) return '–';
    const s = Math.floor((Date.now() - new Date(ts)) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    return Math.floor(s / 3600) + ' h';
  }
  function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const hms = [h, m, ss].map(n => String(n).padStart(2, '0')).join(':');
    return d ? d + 'd ' + hms : hms;
  }
  const portLabel = s => s === 'connected' ? 'Verbunden' : s === 'connecting' ? 'Verbinde…' : 'Getrennt';
  const influxLabel = s => s === 'ok' ? 'Erreichbar' : s === 'error' ? 'Nicht erreichbar' : 'Unbekannt';

  let formTouched = false;
  document.getElementById('form').addEventListener('input', () => { formTouched = true; });

  function fillForm(cfg) {
    if (formTouched) return;
    for (const k of ['url','bucket','token','org','namespace','from']) {
      const el = document.getElementById('f-' + k);
      if (el) el.value = cfg[k] ?? '';
    }
  }

  document.getElementById('save').addEventListener('click', async () => {
    const btn = document.getElementById('save');
    const msg = document.getElementById('formMsg');
    const body = {};
    for (const k of ['url','bucket','token','org','namespace','from']) {
      body[k] = document.getElementById('f-' + k).value.trim();
    }
    btn.disabled = true; msg.className = ''; msg.textContent = 'Wird angewendet…';
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      msg.className = 'ok';
      msg.textContent = 'Gespeichert — InfluxDB ' + influxLabel(data.influx.status).toLowerCase() + '.';
      formTouched = false;
      refresh();
    } catch (e) {
      msg.className = 'bad';
      msg.textContent = 'Fehler: ' + e.message;
    } finally {
      btn.disabled = false;
      setTimeout(() => { if (msg.className === 'ok') { msg.textContent = ''; msg.className = ''; } }, 6000);
    }
  });

  async function refresh() {
    try {
      const data = await (await fetch('/api/status')).json();
      const inf = data.influx;

      const portCards = Object.entries(data.ports).map(([ch, p]) => \`
        <div class="card">
          <div class="label">Kanal \${ch}</div>
          <div class="sub">\${esc(p.path)}</div>
          <div class="status-row"><div class="dot \${p.status}"></div><span class="status-text \${p.status}">\${portLabel(p.status)}</span></div>
          <div class="note">\${p.lastSeen ? 'Letzte Daten vor ' + age(p.lastSeen) : 'noch keine Daten'} · \${p.clients} TCP-Client(s)</div>
        </div>\`).join('');

      const influxCard = \`
        <div class="card">
          <div class="label">InfluxDB</div>
          <div class="sub">\${esc(inf.url)}<br>\${esc(inf.bucket)}</div>
          <div class="status-row"><div class="dot \${inf.status}"></div><span class="status-text \${inf.status}">\${influxLabel(inf.status)}</span>\${inf.version ? '<span class="note" style="margin:0">v' + esc(inf.version) + '</span>' : ''}</div>
          <div class="note">Letzter Schreibvorgang vor \${age(inf.lastWrite)} · \${inf.writes} Punkte\${inf.failures ? ', ' + inf.failures + ' Fehler' : ''}</div>
          \${inf.lastError ? '<div class="note bad">' + esc(inf.lastError) + '</div>' : ''}
        </div>\`;

      document.getElementById('cards').innerHTML = portCards + influxCard;
      fillForm(inf);

      const entries = Object.values(data.fields).sort((a, b) => (b.logged - a.logged) || a.name.localeCompare(b.name, 'de'));
      const tbody = document.getElementById('tbody');
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="no-data">Noch keine Daten empfangen…</td></tr>';
      } else {
        tbody.innerHTML = entries.map(f => \`
          <tr class="\${f.logged ? '' : 'muted'}">
            <td class="field-name">\${esc(f.name)}</td>
            <td class="field-value">\${esc(f.textValue)}</td>
            <td><span class="badge \${f.logged ? 'on' : 'off'}">\${f.logged ? 'geschrieben' : 'nur Anzeige'}</span></td>
            <td class="field-id">\${esc(f.objectId)}</td>
            <td class="field-age">\${age(f.timestamp)}</td>
          </tr>\`).join('');
      }
      const written = entries.filter(f => f.logged).length;
      document.getElementById('meta').textContent =
        \`\${entries.length} Datenpunkte · \${written} nach InfluxDB · Uptime \${fmtUptime(data.uptime)} · \${new Date().toLocaleTimeString('de')}\`;
    } catch (e) {
      document.getElementById('meta').textContent = 'Verbindung zum Server unterbrochen…';
    }
  }
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`;


function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 64 * 1024) {
                reject(new Error('Anfrage zu gross'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                reject(new Error('ungueltiges JSON'));
            }
        });
        req.on('error', reject);
    });
}


function startWebServer() {
    const webPort = config.web?.port ?? 8080;

    const sendJson = (res, code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
    };

    const influxView = () => ({
        ...Object.fromEntries(EDITABLE_KEYS.map(k => [k, influxSettings[k] ?? ''])),
        status: influxState.status,
        version: influxState.version,
        message: influxState.message,
        lastCheck: influxState.lastCheck,
        lastError: influxState.lastError,
        lastWrite: influxState.lastWrite,
        writes: influxState.writes,
        failures: influxState.failures,
    });

    const server = http.createServer(async (req, res) => {
        const url = (req.url || '/').split('?')[0];

        if (url === '/api/status') {
            return sendJson(res, 200, {
                ports: Object.fromEntries(portStates),
                fields: Object.fromEntries(latestFields),
                influx: influxView(),
                uptime: Date.now() - startedAt,
            });
        }

        if (url === '/api/config' && req.method === 'GET') {
            return sendJson(res, 200, influxView());
        }

        if (url === '/api/config' && req.method === 'POST') {
            try {
                await applyInfluxSettings(await readJsonBody(req));
                return sendJson(res, 200, { ok: true, influx: influxView() });
            } catch (err) {
                return sendJson(res, 400, { error: err.message });
            }
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
    });

    server.on('error', err => {
        console.error(`Web-Interface konnte Port ${webPort} nicht belegen: ${err.message}`);
    });

    server.listen(webPort, () => {
        console.log(`Web-Interface -> http://localhost:${webPort}`);
    });
}


async function main() {
    console.log(`InfluxDB -> ${influxSettings.url}  bucket=${influxSettings.bucket}  namespace=${influxSettings.namespace ?? 'resol.0'}`);
    console.log(`Intervall: ${config.vbusInterval ?? 15}s  Datenpunkte: ${datapointFilter ? datapointFilter.size + ' (Whitelist)' : 'alle'}`);

    if (config.web !== false) {
        startWebServer();
    }

    checkInflux();
    setInterval(checkInflux, 30_000);

    for (const portConfig of config.serialPorts) {
        runPort(portConfig);
    }

    if (config.tcp && config.tcp.port) {
        await sleep(1_000);
        await startTcpEndpoint().catch(err => {
            console.error('TCP-Endpunkt konnte nicht starten:', err.message);
        });
    }

    let shuttingDown = false;
    async function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('\nBeende …');
        await influxWriteApi.close().catch(() => {});
        process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}


main().catch(err => {
    console.error(err);
    process.exit(1);
});
