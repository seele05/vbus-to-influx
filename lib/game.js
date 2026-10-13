'use strict';

/*
 * Gamification der Solaranlage: Tagesbilanz, Allzeit-Rekorde, Sonnentage-Serie,
 * Erfahrungspunkte/Level und freischaltbare Abzeichen.
 *
 * Grundlage sind vier frei zuordenbare Datenpunkte (Kollektor- und Speicher-
 * temperatur, Solarpumpe, optional Einstrahlung). Der Zustand wird in einer
 * JSON-Datei gehalten und nur periodisch geschrieben (SD-Karte schonen).
 */

const fs = require('fs');


const SETTING_KEYS = ['collector', 'storage', 'pump', 'irradiation', 'sunnyDayMinutes'];

const DEFAULT_SETTINGS = {
    collector: null,
    storage: null,
    pump: null,
    irradiation: null,
    sunnyDayMinutes: 60,
};

const HISTORY_DAYS = 400;
const EVENT_LIMIT = 30;
const SAVE_INTERVAL_MS = 5 * 60_000;

const LEVEL_TITLES = [
    'Schattenparker',
    'Sonnenlehrling',
    'Lichtsammler',
    'Wärmejäger',
    'Kollektorflüsterer',
    'Speicherfüller',
    'Sonnenernter',
    'Strahlungsprofi',
    'Solarmeister',
    'Sonnenkönig',
    'Fusionsreaktor',
];


/**
 * Abzeichen. `requires` blendet ein Abzeichen aus, solange der benoetigte
 * Datenpunkt nicht zugeordnet ist. `progress` liefert den Fortschritt als
 * [aktuell, Ziel]; freigeschaltet wird, sobald aktuell >= Ziel.
 */
const ACHIEVEMENTS = [
    { id: 'first-sun', icon: '🌅', xp: 10, requires: 'pump', title: 'Erste Sonnenminute', desc: 'Die Solarpumpe läuft zum ersten Mal', progress: s => [s.totals.pumpSeconds / 60, 1] },
    { id: 'day-1h', icon: '⏱️', xp: 25, requires: 'pump', title: 'Fleißige Pumpe', desc: '1 h Solarbetrieb an einem Tag', progress: s => [s.records.pumpDay.value / 3600, 1] },
    { id: 'day-4h', icon: '🌞', xp: 50, requires: 'pump', title: 'Sonnenanbeter', desc: '4 h Solarbetrieb an einem Tag', progress: s => [s.records.pumpDay.value / 3600, 4] },
    { id: 'day-8h', icon: '🏖️', xp: 100, requires: 'pump', title: 'Hochsommer', desc: '8 h Solarbetrieb an einem Tag', progress: s => [s.records.pumpDay.value / 3600, 8] },
    { id: 'total-10h', icon: '🔋', xp: 25, requires: 'pump', title: 'Warmlaufen', desc: '10 h Solarbetrieb insgesamt', progress: s => [s.totals.pumpSeconds / 3600, 10] },
    { id: 'total-100h', icon: '⚡', xp: 75, requires: 'pump', title: 'Dauerläufer', desc: '100 h Solarbetrieb insgesamt', progress: s => [s.totals.pumpSeconds / 3600, 100] },
    { id: 'total-500h', icon: '🚀', xp: 200, requires: 'pump', title: 'Marathon', desc: '500 h Solarbetrieb insgesamt', progress: s => [s.totals.pumpSeconds / 3600, 500] },
    { id: 'total-1000h', icon: '🏆', xp: 500, requires: 'pump', title: 'Tausendsassa', desc: '1000 h Solarbetrieb insgesamt', progress: s => [s.totals.pumpSeconds / 3600, 1000] },
    { id: 'sunny-10', icon: '📅', xp: 25, requires: 'pump', title: 'Sonnensammler', desc: '10 Sonnentage insgesamt', progress: s => [s.totals.sunnyDays, 10] },
    { id: 'sunny-50', icon: '🗓️', xp: 100, requires: 'pump', title: 'Sonnenkalender', desc: '50 Sonnentage insgesamt', progress: s => [s.totals.sunnyDays, 50] },
    { id: 'sunny-100', icon: '💯', xp: 250, requires: 'pump', title: 'Hundert Sonnen', desc: '100 Sonnentage insgesamt', progress: s => [s.totals.sunnyDays, 100] },
    { id: 'streak-3', icon: '🔥', xp: 30, requires: 'pump', title: 'Sonnenserie', desc: '3 Sonnentage in Folge', progress: s => [s.records.streak.value, 3] },
    { id: 'streak-7', icon: '🔥', xp: 50, requires: 'pump', title: 'Sonnenwoche', desc: '7 Sonnentage in Folge', progress: s => [s.records.streak.value, 7] },
    { id: 'streak-14', icon: '🔥', xp: 100, requires: 'pump', title: 'Zwei Wochen Sonne', desc: '14 Sonnentage in Folge', progress: s => [s.records.streak.value, 14] },
    { id: 'streak-30', icon: '☄️', xp: 250, requires: 'pump', title: 'Sonnenmonat', desc: '30 Sonnentage in Folge', progress: s => [s.records.streak.value, 30] },
    { id: 'early-bird', icon: '🐓', xp: 30, requires: 'pump', title: 'Frühaufsteher', desc: 'Solarbetrieb vor 8:00 Uhr', progress: s => [s.flags.earlyBird ? 1 : 0, 1] },
    { id: 'evening-sun', icon: '🌇', xp: 30, requires: 'pump', title: 'Abendsonne', desc: 'Solarbetrieb nach 19:00 Uhr', progress: s => [s.flags.eveningSun ? 1 : 0, 1] },
    { id: 'winter-sun', icon: '❄️', xp: 75, requires: 'pump', title: 'Wintersonne', desc: 'Ein Sonnentag im Dezember, Januar oder Februar', progress: s => [s.flags.winterSun ? 1 : 0, 1] },
    { id: 'collector-60', icon: '♨️', xp: 25, requires: 'collector', title: 'Heißer Kollektor', desc: 'Kollektor erreicht 60 °C', progress: s => [s.records.collectorMax.value ?? 0, 60] },
    { id: 'collector-80', icon: '🍳', xp: 50, requires: 'collector', title: 'Kochplatte', desc: 'Kollektor erreicht 80 °C', progress: s => [s.records.collectorMax.value ?? 0, 80] },
    { id: 'collector-100', icon: '🌋', xp: 100, requires: 'collector', title: 'Siedepunkt', desc: 'Kollektor erreicht 100 °C', progress: s => [s.records.collectorMax.value ?? 0, 100] },
    { id: 'storage-50', icon: '🚿', xp: 25, requires: 'storage', title: 'Warmduscher', desc: 'Speicher erreicht 50 °C', progress: s => [s.records.storageMax.value ?? 0, 50] },
    { id: 'storage-60', icon: '🛁', xp: 50, requires: 'storage', title: 'Badetag', desc: 'Speicher erreicht 60 °C', progress: s => [s.records.storageMax.value ?? 0, 60] },
    { id: 'storage-70', icon: '🫖', xp: 100, requires: 'storage', title: 'Volle Ladung', desc: 'Speicher erreicht 70 °C', progress: s => [s.records.storageMax.value ?? 0, 70] },
    { id: 'irr-800', icon: '🔆', xp: 25, requires: 'irradiation', title: 'Volle Sonne', desc: 'Einstrahlung erreicht 800 W/m²', progress: s => [s.records.irradiationMax.value ?? 0, 800] },
    { id: 'irr-1000', icon: '✨', xp: 75, requires: 'irradiation', title: 'Gleißend hell', desc: 'Einstrahlung erreicht 1000 W/m²', progress: s => [s.records.irradiationMax.value ?? 0, 1000] },
];


/** Lokales Datum (Zeitzone des Systems) als YYYY-MM-DD. */
function dayKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


function previousDayKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d - 1, 12));
}


/** Kumulierte XP, die fuer Level `level` noetig sind: 0, 100, 300, 600, … */
function xpForLevel(level) {
    return 50 * level * (level - 1);
}


function levelForXp(xp) {
    return Math.max(1, Math.floor((1 + Math.sqrt(1 + xp / 12.5)) / 2));
}


function levelTitle(level) {
    return LEVEL_TITLES[Math.min(Math.floor((level - 1) / 3), LEVEL_TITLES.length - 1)];
}


function emptyDay(day) {
    return {
        day,
        pumpSeconds: 0,
        collectorMax: null,
        storageMax: null,
        irradiationMax: null,
        irradiationWh: 0,
        sunny: false,
    };
}


function emptyState() {
    return {
        version: 1,
        lastSample: null,
        level: 1,
        totals: { pumpSeconds: 0, sunnyDays: 0 },
        today: null,
        history: [],
        records: {
            collectorMax: { value: null, at: null },
            storageMax: { value: null, at: null },
            irradiationMax: { value: null, at: null },
            pumpDay: { value: 0, at: null },
            streak: { value: 0, at: null },
        },
        streak: { count: 0, lastDay: null },
        flags: { earlyBird: false, eveningSun: false, winterSun: false },
        achievements: {},
        events: [],
        nextEventId: 1,
    };
}


/** Fuehrt einen geladenen (evtl. aelteren/unvollstaendigen) Zustand mit den Defaults zusammen. */
function mergeState(loaded) {
    const base = emptyState();
    if (!loaded || typeof loaded !== 'object') {
        return base;
    }

    return {
        ...base,
        ...loaded,
        totals: { ...base.totals, ...loaded.totals },
        records: Object.fromEntries(Object.entries(base.records).map(([k, v]) => [k, { ...v, ...loaded.records?.[k] }])),
        streak: { ...base.streak, ...loaded.streak },
        flags: { ...base.flags, ...loaded.flags },
        achievements: { ...loaded.achievements },
        history: Array.isArray(loaded.history) ? loaded.history : [],
        events: Array.isArray(loaded.events) ? loaded.events : [],
    };
}


function normalizeSettings(input) {
    const out = { ...DEFAULT_SETTINGS };

    for (const key of ['collector', 'storage', 'pump', 'irradiation']) {
        const v = input?.[key];
        out[key] = (typeof v === 'string' && v.trim()) ? v.trim() : null;
    }

    const minutes = Number(input?.sunnyDayMinutes);
    out.sunnyDayMinutes = (Number.isFinite(minutes) && minutes > 0) ? Math.round(minutes) : DEFAULT_SETTINGS.sunnyDayMinutes;

    return out;
}


function isNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}


function maxOf(a, b) {
    return isNumber(a) ? (isNumber(b) ? Math.max(a, b) : a) : b;
}


class Game {
    /**
     * @param {object} opts
     * @param {object} opts.settings   Zuordnung der Datenpunkte, siehe DEFAULT_SETTINGS
     * @param {string} [opts.statePath] JSON-Datei fuer den Spielstand; ohne => nur im Speicher
     * @param {number} [opts.intervalMs] Sammelintervall; Luecken > 4 Intervalle zaehlen nicht als Laufzeit
     * @param {function} [opts.log]
     */
    constructor({ settings, statePath = null, intervalMs = 15_000, log = console } = {}) {
        this.settings = normalizeSettings(settings);
        this.statePath = statePath;
        this.maxGapMs = Math.max(60_000, intervalMs * 4);
        this.log = log;
        this.dirty = false;
        this.live = { collector: null, storage: null, pump: null, irradiation: null, at: null };
        this.state = this.load();
    }

    load() {
        if (!this.statePath) {
            return emptyState();
        }
        try {
            return mergeState(JSON.parse(fs.readFileSync(this.statePath, 'utf8')));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.log.error(`Spielstand ${this.statePath} unlesbar (${err.message}), starte neu`);
            }
            return emptyState();
        }
    }

    /** Schreibt atomar (tmp + rename), damit ein Stromausfall keine halbe Datei hinterlaesst. */
    save() {
        if (!this.statePath || !this.dirty) {
            return;
        }
        const tmp = this.statePath + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.state));
            fs.renameSync(tmp, this.statePath);
            this.dirty = false;
        } catch (err) {
            this.log.error(`Spielstand konnte nicht gespeichert werden: ${err.message}`);
        }
    }

    startAutosave() {
        this.autosaveTimer = setInterval(() => this.save(), SAVE_INTERVAL_MS);
        this.autosaveTimer.unref();
    }

    setSettings(patch) {
        this.settings = normalizeSettings({ ...this.settings, ...patch });
    }

    /**
     * Verarbeitet einen Messzyklus.
     * @param {Map<string, *>} values  objectId -> Wert (wie nach InfluxDB geschrieben)
     * @param {Date|number} timestamp
     */
    update(values, timestamp) {
        const ts = new Date(timestamp).getTime();
        const s = this.state;
        const read = key => (this.settings[key] ? values.get(this.settings[key]) : undefined);

        const collector = read('collector');
        const storage = read('storage');
        const pumpRaw = read('pump');
        const irradiation = read('irradiation');

        if (collector === undefined && storage === undefined && pumpRaw === undefined && irradiation === undefined) {
            return;
        }

        const pumpOn = pumpRaw === true || (isNumber(pumpRaw) && pumpRaw > 0);
        this.live = {
            collector: isNumber(collector) ? collector : null,
            storage: isNumber(storage) ? storage : null,
            pump: pumpRaw === undefined ? null : (typeof pumpRaw === 'boolean' ? (pumpRaw ? 100 : 0) : pumpRaw),
            pumpOn,
            irradiation: isNumber(irradiation) ? irradiation : null,
            at: ts,
        };

        const day = dayKey(ts);
        if (!s.today) {
            s.today = emptyDay(day);
        } else if (s.today.day !== day) {
            this.rollover(day);
        }

        // Zeit seit dem letzten Messzyklus; Luecken (Neustart, Portausfall) zaehlen nicht
        const dt = (s.lastSample !== null && ts > s.lastSample && ts - s.lastSample <= this.maxGapMs)
            ? (ts - s.lastSample) / 1000
            : 0;
        s.lastSample = ts;

        const t = s.today;

        if (pumpOn && dt > 0) {
            t.pumpSeconds += dt;
            s.totals.pumpSeconds += dt;

            const hour = new Date(ts).getHours();
            if (hour < 8) s.flags.earlyBird = true;
            if (hour >= 19) s.flags.eveningSun = true;
        }

        if (isNumber(collector)) t.collectorMax = maxOf(t.collectorMax, collector);
        if (isNumber(storage)) t.storageMax = maxOf(t.storageMax, storage);
        if (isNumber(irradiation)) {
            t.irradiationMax = maxOf(t.irradiationMax, irradiation);
            t.irradiationWh += irradiation * dt / 3600;
        }

        if (!t.sunny && t.pumpSeconds >= this.settings.sunnyDayMinutes * 60) {
            this.markSunnyDay(day, ts);
        }

        this.checkRecord('collectorMax', collector, ts, v => `Kollektor ${v.toFixed(1)} °C`, '🌡️');
        this.checkRecord('storageMax', storage, ts, v => `Speicher ${v.toFixed(1)} °C`, '🛢️');
        this.checkRecord('irradiationMax', irradiation, ts, v => `Einstrahlung ${Math.round(v)} W/m²`, '🔆');
        if (pumpOn) {
            this.checkRecord('pumpDay', t.pumpSeconds, ts, v => `${formatDuration(v)} Solarbetrieb an einem Tag`, '⏱️');
        }

        this.checkAchievements(ts);
        this.checkLevel(ts);

        this.dirty = true;
    }

    rollover(day) {
        const s = this.state;
        s.history.push(s.today);
        if (s.history.length > HISTORY_DAYS) {
            s.history.splice(0, s.history.length - HISTORY_DAYS);
        }
        s.today = emptyDay(day);
        this.dirty = true;
        this.save();
    }

    markSunnyDay(day, ts) {
        const s = this.state;
        s.today.sunny = true;
        s.totals.sunnyDays += 1;

        s.streak.count = (s.streak.lastDay === previousDayKey(day)) ? s.streak.count + 1 : 1;
        s.streak.lastDay = day;

        const month = Number(day.slice(5, 7));
        if (month === 12 || month <= 2) {
            s.flags.winterSun = true;
        }

        this.checkRecord('streak', s.streak.count, ts, v => `${v} Sonnentage in Folge`, '🔥');
        this.addEvent(ts, 'sunny', '☀️', 'Sonnentag!', `Heute schon ${this.settings.sunnyDayMinutes} min Solarbetrieb`);
    }

    /**
     * Aktualisiert einen Allzeit-Rekord. Ein Ereignis gibt es nur, wenn ein an
     * einem frueheren Tag aufgestellter Rekord heute erstmals gebrochen wird.
     */
    checkRecord(key, value, ts, describe, icon) {
        if (!isNumber(value)) {
            return;
        }
        const rec = this.state.records[key];
        if (rec.value !== null && value <= rec.value) {
            return;
        }

        const brokenToday = rec.at !== null && dayKey(rec.at) === dayKey(ts);
        const hadRecord = rec.value !== null && rec.value > 0;

        rec.value = value;
        rec.at = ts;

        if (hadRecord && !brokenToday) {
            this.addEvent(ts, 'record', icon, 'Neuer Rekord!', describe(value));
        }
    }

    checkAchievements(ts) {
        for (const a of ACHIEVEMENTS) {
            if (this.state.achievements[a.id] || !this.settings[a.requires]) {
                continue;
            }
            const [current, target] = a.progress(this.state);
            if (current >= target) {
                this.state.achievements[a.id] = ts;
                this.addEvent(ts, 'achievement', a.icon, `Abzeichen: ${a.title}`, `${a.desc} · +${a.xp} XP`);
            }
        }
    }

    xp() {
        const s = this.state;
        const bonus = ACHIEVEMENTS.reduce((sum, a) => sum + (s.achievements[a.id] ? a.xp : 0), 0);
        return Math.floor(s.totals.pumpSeconds / 60) + bonus;
    }

    checkLevel(ts) {
        const level = levelForXp(this.xp());
        if (level > this.state.level) {
            this.state.level = level;
            this.addEvent(ts, 'level', '⭐', `Level ${level} erreicht!`, levelTitle(level));
        }
    }

    addEvent(ts, type, icon, title, text) {
        const s = this.state;
        s.events.push({ id: s.nextEventId++, at: ts, type, icon, title, text });
        if (s.events.length > EVENT_LIMIT) {
            s.events.splice(0, s.events.length - EVENT_LIMIT);
        }
    }

    currentStreak(now = Date.now()) {
        const { count, lastDay } = this.state.streak;
        const today = dayKey(now);
        return (lastDay === today || lastDay === previousDayKey(today)) ? count : 0;
    }

    /** Daten fuer die Web-Oberflaeche. */
    view(now = Date.now()) {
        const s = this.state;
        const xp = this.xp();
        const level = levelForXp(xp);
        const today = (s.today && s.today.day === dayKey(now)) ? s.today : emptyDay(dayKey(now));

        // letzte 14 Tage inkl. heute, fehlende Tage als leere Eintraege
        const byDay = new Map(s.history.map(d => [d.day, d]));
        byDay.set(today.day, today);
        const days = [];
        let key = today.day;
        for (let i = 0; i < 14; i++) {
            days.unshift(byDay.get(key) ?? emptyDay(key));
            key = previousDayKey(key);
        }

        return {
            settings: this.settings,
            configured: !!(this.settings.collector || this.settings.storage || this.settings.pump),
            live: this.live,
            today,
            days: days.map(d => ({ day: d.day, pumpSeconds: d.pumpSeconds, collectorMax: d.collectorMax, sunny: d.sunny })),
            records: s.records,
            totals: s.totals,
            streak: { current: this.currentStreak(now), best: s.records.streak.value },
            xp,
            level,
            levelTitle: levelTitle(level),
            levelFloor: xpForLevel(level),
            levelCeil: xpForLevel(level + 1),
            achievements: ACHIEVEMENTS
                .filter(a => this.settings[a.requires])
                .map(a => {
                    const [current, target] = a.progress(s);
                    return {
                        id: a.id,
                        icon: a.icon,
                        title: a.title,
                        desc: a.desc,
                        xp: a.xp,
                        unlockedAt: s.achievements[a.id] ?? null,
                        progress: Math.max(0, Math.min(1, current / target)),
                    };
                }),
            events: s.events.slice(-10).reverse(),
        };
    }
}


function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}


module.exports = {
    Game,
    ACHIEVEMENTS,
    SETTING_KEYS,
    DEFAULT_SETTINGS,
    dayKey,
    previousDayKey,
    levelForXp,
    xpForLevel,
    normalizeSettings,
};
