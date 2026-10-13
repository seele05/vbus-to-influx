'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');

const { SerialPort } = require('serialport');
const { Connection, TcpConnectionEndpoint, Specification, HeaderSetConsolidator } = require('resol-vbus');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const { objectIdOf, transformValue } = require('./lib/iobroker-compat');
const { Game, SETTING_KEYS: GAME_KEYS } = require('./lib/game');
const config = require('./config');


const spec = new Specification({ language: config.language ?? 'de' });

const INTERVAL_MS = (config.vbusInterval ?? 15) * 1000;

// Ueber das Web-Interface geaenderte Werte liegen hier und ueberlagern config.js,
// damit die kommentierte config.js unveraendert bleibt.
const OVERRIDE_PATH = path.join(__dirname, 'config.local.json');
const GAME_STATE_PATH = path.join(__dirname, 'game-state.json');
const PAGE_PATH = path.join(__dirname, 'web', 'index.html');

const EDITABLE_KEYS = ['url', 'token', 'org', 'bucket', 'namespace', 'from'];

// TCP-Clients, die so viele Bytes nicht abholen, werden getrennt (statt den Speicher zu fuellen)
const TCP_MAX_BACKLOG = 1024 * 1024;


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


const overridesAtStart = loadOverrides();

let influxSettings = { ...config.influx, ...(overridesAtStart.influx ?? {}) };
let influxWriteApi = createWriteApi();

const game = new Game({
    settings: { ...config.game, ...(overridesAtStart.game ?? {}) },
    statePath: GAME_STATE_PATH,
    intervalMs: INTERVAL_MS,
});


// Whitelist der zu schreibenden Datenpunkte. null/undefined => alle.
const datapointFilter = Array.isArray(config.datapoints) ? new Set(config.datapoints) : null;

// Shared state fuer das Web-Interface
const portStates = new Map();   // channel -> { path, status, lastSeen, clients }
const latestFields = new Map(); // objectId -> { name, objectId, textValue, value, unit, logged, written, channel, timestamp }
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

// Aktuell offene serielle Ports und aktive TCP-Clients je Kanal
const serialPorts = new Map();  // channel -> SerialPort
const tcpClients = new Map();   // channel -> Set<Socket>


function createWriteApi() {
    // Die Hooks werden fuer jeden Batch aufgerufen, auch fuer spaetere Wiederholungen
    // aus dem Retry-Puffer des Clients. So stimmen die Zaehler in der Web-UI.
    return new InfluxDB({
        url: influxSettings.url,
        token: influxSettings.token ?? '',
    }).getWriteApi(influxSettings.org ?? '', influxSettings.bucket, 'ms', {
        writeSuccess(lines) {
            influxState.lastWrite = Date.now();
            influxState.writes += lines.length;
            influxState.lastError = null;
            influxState.status = 'ok';
        },
        writeFailed(error) {
            influxState.failures += 1;
            influxState.lastError = error.message;
            influxState.status = 'error';
        },
    });
}


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
    const values = new Map();

    const record = (objectId, name, value, textValue, unit) => {
        const logged = !datapointFilter || datapointFilter.has(objectId);
        const hasValue = value !== null && value !== undefined;

        latestFields.set(objectId, {
            objectId,
            name,
            value,
            textValue,
            unit,
            logged,
            written: logged && hasValue,
            channel: portConfig.channel,
            timestamp,
        });

        if (hasValue) {
            values.set(objectId, value);
            if (logged) {
                points.push(buildPoint(objectId, value, timestamp));
            }
        }
    };

    for (const packetField of packetFields) {
        const objectId = objectIdOf(packetField);
        const { value, extra } = transformValue(spec, packetField);

        record(objectId, packetField.name, value, packetField.formatTextValue(), packetField.packetFieldSpec.type.unit.unitId);

        if (extra) {
            record(objectId + extra.suffix, `${packetField.name} (aktiv)`, extra.value, String(extra.value), 'Boolean');
        }
    }

    const state = portStates.get(portConfig.channel);
    if (state) {
        state.lastSeen = timestamp;
    }

    try {
        game.update(values, timestamp);
    } catch (err) {
        console.error('Spiel-Auswertung fehlgeschlagen:', err);
    }

    if (points.length === 0) {
        return;
    }

    // Erfolg/Fehler zaehlen die Hooks in createWriteApi(); fehlgeschlagene Batches
    // landen im Retry-Puffer des Clients und werden spaeter erneut gesendet.
    influxWriteApi.writePoints(points);
    influxWriteApi.flush().then(() => {
        console.log(`[ch${portConfig.channel}] ${points.length} Datenpunkte -> InfluxDB`);
    }).catch(err => {
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
    overrides.influx = Object.fromEntries(EDITABLE_KEYS.map(k => [k, next[k] ?? '']));
    saveOverrides(overrides);

    const previous = influxWriteApi;
    influxSettings = next;
    influxWriteApi = createWriteApi();

    await previous.close().catch(() => {});
    await checkInflux();

    console.log(`InfluxDB-Einstellungen geaendert -> ${influxSettings.url} bucket=${influxSettings.bucket}`);
}


/**
 * Uebernimmt die Datenpunkt-Zuordnung des Spiels zur Laufzeit.
 */
function applyGameSettings(patch) {
    const filtered = Object.fromEntries(
        GAME_KEYS.filter(k => Object.prototype.hasOwnProperty.call(patch, k)).map(k => [k, patch[k]])
    );

    for (const key of ['collector', 'storage', 'pump', 'irradiation']) {
        const v = filtered[key];
        if (v !== undefined && v !== null && v !== '' && !/^[0-9A-Za-z_.]+$/.test(String(v))) {
            throw new Error(`${key}: ungueltige Datenpunkt-ID`);
        }
    }

    game.setSettings(filtered);

    const overrides = loadOverrides();
    overrides.game = game.settings;
    saveOverrides(overrides);

    console.log(`Spiel-Zuordnung geaendert -> ${JSON.stringify(game.settings)}`);
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
        interval: INTERVAL_MS,
        timeToLive: INTERVAL_MS + 1000,
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

        serialPorts.set(channel, port);

        port.on('readable', () => {
            let chunk;
            while ((chunk = port.read())) {
                for (const socket of clientsFor(channel)) {
                    if (socket.writableLength > TCP_MAX_BACKLOG) {
                        console.error(`[tcp] Client liest nicht mit (${socket.writableLength} Bytes Rueckstau), trenne`);
                        socket.destroy();
                        continue;
                    }
                    socket.write(chunk);
                }
                parser.receive(new Date(), chunk);
            }
        });

        await new Promise(resolve => {
            port.on('error', err => {
                console.error(`[ch${channel}] Portfehler: ${err.message}`);
                resolve();
            });
            port.on('close', resolve);
            port.on('end', resolve);
        });

        if (serialPorts.get(channel) === port) {
            serialPorts.delete(channel);
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
 * VBus-Clients unveraendert weiterlaufen koennen. Clients bleiben auch ueber
 * einen Neuaufbau des seriellen Ports hinweg verbunden.
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
        const socket = connectionInfo.socket;
        const state = portStates.get(channel);

        if (!state) {
            console.log(`[tcp] weise Verbindung fuer unbekannten Kanal ${channel} ab`);
            socket.end();
            return;
        }

        console.log(`[tcp] Client verbunden (Kanal ${channel})`);

        const clients = clientsFor(channel);
        clients.add(socket);
        state.clients = clients.size;

        socket.on('error', err => {
            console.error(`[tcp] ${err.message}`);
        });
        // 'close' kommt in jedem Fall (Ende, Fehler, destroy) genau einmal
        socket.on('close', () => {
            clients.delete(socket);
            state.clients = clients.size;
            console.log(`[tcp] Client getrennt (Kanal ${channel})`);
        });
        socket.on('readable', () => {
            let chunk;
            while ((chunk = socket.read())) {
                // immer den aktuell offenen Port nehmen, nicht den zum Verbindungszeitpunkt
                const port = serialPorts.get(channel);
                if (port && port.isOpen) {
                    port.write(chunk);
                }
            }
        });
    });

    await endpoint.start();
    console.log(`TCP-Endpunkt -> Port ${config.tcp.port}`);
}


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
                const body = raw ? JSON.parse(raw) : {};
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    throw new Error();
                }
                resolve(body);
            } catch (err) {
                reject(new Error('ungueltiges JSON'));
            }
        });
        req.on('error', reject);
    });
}


function startWebServer() {
    const webPort = config.web?.port ?? 80;

    // Seite einmal laden und vorkomprimieren; auf dem Pi Zero spart das bei jedem Abruf CPU
    const page = fs.readFileSync(PAGE_PATH);
    const pageGzip = zlib.gzipSync(page, { level: 9 });

    const sendJson = (res, code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
    };

    // Das Token verlaesst den Server nicht; die UI erfaehrt nur, ob eines gesetzt ist
    const influxView = () => ({
        ...Object.fromEntries(EDITABLE_KEYS.filter(k => k !== 'token').map(k => [k, influxSettings[k] ?? ''])),
        tokenSet: !!influxSettings.token,
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

        if (url === '/api/status' && req.method === 'GET') {
            return sendJson(res, 200, {
                now: Date.now(),
                ports: Object.fromEntries(portStates),
                fields: Object.fromEntries(latestFields),
                influx: influxView(),
                game: game.view(),
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

        if (url === '/api/game' && req.method === 'POST') {
            try {
                applyGameSettings(await readJsonBody(req));
                return sendJson(res, 200, { ok: true, game: game.view() });
            } catch (err) {
                return sendJson(res, 400, { error: err.message });
            }
        }

        if ((url === '/' || url === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
            const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
            const body = gzip ? pageGzip : page;
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': body.length,
                'Cache-Control': 'no-cache',
                'Vary': 'Accept-Encoding',
                'X-Content-Type-Options': 'nosniff',
                ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
            });
            return res.end(req.method === 'HEAD' ? undefined : body);
        }

        sendJson(res, 404, { error: 'nicht gefunden' });
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
    console.log(`Intervall: ${INTERVAL_MS / 1000}s  Datenpunkte: ${datapointFilter ? datapointFilter.size + ' (Whitelist)' : 'alle'}`);

    if (config.web !== false) {
        startWebServer();
    }

    game.startAutosave();

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
        game.save();
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
