'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Game, dayKey, previousDayKey, levelForXp, xpForLevel, normalizeSettings } = require('../lib/game');


const IDS = { collector: 'c', storage: 's', pump: 'p', irradiation: 'i' };
const quiet = { error() {} };

function newGame(extra = {}) {
    return new Game({ settings: { ...IDS, sunnyDayMinutes: 60, ...extra }, intervalMs: 15_000, log: quiet });
}

function sample(values) {
    return new Map(Object.entries(values).map(([k, v]) => [IDS[k], v]));
}

/** Simuliert `minutes` Minuten Messzyklen im 15-s-Takt ab `start`. Liefert den Zeitpunkt danach. */
function run(game, start, minutes, values) {
    let t = start.getTime();
    const end = t + minutes * 60_000;
    for (; t <= end; t += 15_000) {
        game.update(sample(typeof values === 'function' ? values(t) : values), t);
    }
    return new Date(t);
}

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min);


test('dayKey / previousDayKey arbeiten mit lokalem Datum, auch ueber Monatsgrenzen', () => {
    assert.equal(dayKey(at(2026, 3, 1, 0, 5)), '2026-03-01');
    assert.equal(previousDayKey('2026-03-01'), '2026-02-28');
    assert.equal(previousDayKey('2026-01-01'), '2025-12-31');
    assert.equal(previousDayKey('2024-03-01'), '2024-02-29');
});


test('Level-Kurve: 0/100/300/600 XP fuer Level 1/2/3/4', () => {
    assert.deepEqual([1, 2, 3, 4].map(xpForLevel), [0, 100, 300, 600]);
    assert.equal(levelForXp(0), 1);
    assert.equal(levelForXp(99), 1);
    assert.equal(levelForXp(100), 2);
    assert.equal(levelForXp(299), 2);
    assert.equal(levelForXp(300), 3);
    for (let xp = 0; xp < 50_000; xp += 37) {
        const l = levelForXp(xp);
        assert.ok(xpForLevel(l) <= xp && xp < xpForLevel(l + 1), `xp=${xp} l=${l}`);
    }
});


test('normalizeSettings: leere IDs -> null, ungueltige Minuten -> Default', () => {
    assert.deepEqual(normalizeSettings({ collector: '  ', pump: 'x', sunnyDayMinutes: 'abc' }), {
        collector: null, storage: null, pump: 'x', irradiation: null, sunnyDayMinutes: 60,
    });
    assert.equal(normalizeSettings({ sunnyDayMinutes: 0 }).sunnyDayMinutes, 60);
    assert.equal(normalizeSettings({ sunnyDayMinutes: 45.4 }).sunnyDayMinutes, 45);
});


test('Pumpenlaufzeit zaehlt nur bei laufender Pumpe und ohne Messluecken', () => {
    const g = newGame();
    let t = run(g, at(2026, 6, 1, 10), 30, { pump: 100, collector: 50, storage: 40 });
    assert.equal(Math.round(g.state.today.pumpSeconds), 30 * 60);

    // Pumpe aus: keine Laufzeit
    t = run(g, t, 10, { pump: 0, collector: 50, storage: 40 });
    assert.equal(Math.round(g.state.today.pumpSeconds), 30 * 60);

    // Luecke von 10 min (z. B. Neustart) zaehlt nicht
    const g2 = newGame();
    g2.update(sample({ pump: 100 }), at(2026, 6, 1, 10).getTime());
    g2.update(sample({ pump: 100 }), at(2026, 6, 1, 10, 10).getTime());
    assert.equal(g2.state.today.pumpSeconds, 0);
    g2.update(sample({ pump: 100 }), at(2026, 6, 1, 10, 10).getTime() + 15_000);
    assert.equal(g2.state.today.pumpSeconds, 15);
});


test('Laufzeit wird dem Zustand zum Zeitpunkt der Messung zugeordnet', () => {
    const g = newGame();
    const t0 = at(2026, 6, 1, 10).getTime();
    g.update(sample({ pump: 0 }), t0);
    g.update(sample({ pump: 100 }), t0 + 15_000);
    g.update(sample({ pump: 100 }), t0 + 30_000);
    g.update(sample({ pump: 0 }), t0 + 45_000);
    // gezaehlt werden die Intervalle, an deren Ende die Pumpe lief
    assert.equal(g.state.today.pumpSeconds, 30);
});


test('Tageswechsel schiebt den Tag in die Historie', () => {
    const g = newGame();
    run(g, at(2026, 6, 1, 23, 50), 5, { pump: 100, collector: 70 });
    run(g, at(2026, 6, 2, 0, 1), 1, { pump: 0, collector: 20 });
    assert.equal(g.state.history.length, 1);
    assert.equal(g.state.history[0].day, '2026-06-01');
    assert.equal(g.state.history[0].collectorMax, 70);
    assert.equal(g.state.today.day, '2026-06-02');
    assert.equal(g.state.today.collectorMax, 20);
});


test('Sonnentage und Serie: aufeinanderfolgend zaehlt hoch, Luecke setzt zurueck', () => {
    const g = newGame({ sunnyDayMinutes: 30 });

    run(g, at(2026, 6, 1, 11), 31, { pump: 100 });
    run(g, at(2026, 6, 2, 11), 31, { pump: 100 });
    run(g, at(2026, 6, 3, 11), 31, { pump: 100 });
    assert.equal(g.state.totals.sunnyDays, 3);
    assert.equal(g.state.streak.count, 3);
    assert.equal(g.currentStreak(at(2026, 6, 3, 18).getTime()), 3);
    assert.equal(g.currentStreak(at(2026, 6, 4, 9).getTime()), 3, 'am Folgetag morgens noch nicht verloren');
    assert.equal(g.currentStreak(at(2026, 6, 5, 9).getTime()), 0, 'nach einem verpassten Tag verloren');
    assert.ok(g.state.achievements['streak-3']);

    // 4.6. nur 10 min -> kein Sonnentag; 5.6. wieder Sonne -> neue Serie
    run(g, at(2026, 6, 4, 11), 10, { pump: 100 });
    run(g, at(2026, 6, 5, 11), 31, { pump: 100 });
    assert.equal(g.state.streak.count, 1);
    assert.equal(g.state.records.streak.value, 3);
});


test('Rekord-Ereignis nur beim Brechen eines Vortagsrekords, einmal pro Tag', () => {
    const g = newGame();
    run(g, at(2026, 6, 1, 12), 2, t => ({ collector: 60 + (t % 60_000) / 10_000 }));
    const recordEvents = () => g.state.events.filter(e => e.type === 'record' && /Kollektor/.test(e.text));
    assert.equal(recordEvents().length, 0, 'erster Tag stellt nur auf');

    run(g, at(2026, 6, 2, 12), 2, { collector: 50 });
    assert.equal(recordEvents().length, 0, 'nicht gebrochen');

    run(g, at(2026, 6, 3, 12), 5, t => ({ collector: 70 + (t - at(2026, 6, 3, 12).getTime()) / 60_000 }));
    assert.equal(recordEvents().length, 1, 'gebrochen, aber nur ein Ereignis am Tag');
    assert.equal(g.state.records.collectorMax.value, 75);
});


test('Abzeichen, XP und Level-Aufstieg', () => {
    const g = newGame();
    run(g, at(2026, 7, 1, 7, 50), 130, { pump: 100, collector: 85, storage: 62, irradiation: 900 });

    for (const id of ['first-sun', 'day-1h', 'early-bird', 'collector-60', 'collector-80', 'storage-50', 'storage-60', 'irr-800']) {
        assert.ok(g.state.achievements[id], `${id} freigeschaltet`);
    }
    for (const id of ['day-4h', 'collector-100', 'storage-70', 'irr-1000', 'evening-sun', 'winter-sun']) {
        assert.ok(!g.state.achievements[id], `${id} noch gesperrt`);
    }

    const view = g.view(at(2026, 7, 1, 10).getTime());
    const bonus = view.achievements.filter(a => a.unlockedAt).reduce((s, a) => s + a.xp, 0);
    assert.equal(view.xp, 130 + bonus);
    assert.equal(view.level, levelForXp(view.xp));
    assert.ok(g.state.events.some(e => e.type === 'level'));
    assert.ok(view.today.irradiationWh > 1900 && view.today.irradiationWh < 2000, `Wh/m2=${view.today.irradiationWh}`);
});


test('Wintersonne nur bei Sonnentag im Dez/Jan/Feb', () => {
    const g = newGame({ sunnyDayMinutes: 10 });
    run(g, at(2026, 3, 1, 12), 11, { pump: 100 });
    assert.ok(!g.state.achievements['winter-sun']);
    run(g, at(2026, 12, 2, 12), 11, { pump: 100 });
    assert.ok(g.state.achievements['winter-sun']);
});


test('Abzeichen ohne zugeordneten Datenpunkt werden ausgeblendet und nicht vergeben', () => {
    const g = new Game({ settings: { pump: 'p' }, log: quiet });
    g.update(new Map([['p', 100], ['c', 120]]), at(2026, 6, 1).getTime());
    const ids = g.view().achievements.map(a => a.id);
    assert.ok(ids.includes('first-sun'));
    assert.ok(!ids.some(id => id.startsWith('collector-') || id.startsWith('irr-')));
    assert.equal(g.state.records.collectorMax.value, null);
});


test('Ohne zugeordnete Werte im Zyklus aendert sich nichts', () => {
    const g = newGame();
    g.update(new Map([['fremd', 1]]), at(2026, 6, 1).getTime());
    assert.equal(g.state.today, null);
    assert.equal(g.dirty, false);
});


test('Boolean-Pumpe (Relais-aktiv-Flag) wird unterstuetzt', () => {
    const g = newGame();
    run(g, at(2026, 6, 1, 12), 2, { pump: true });
    assert.equal(g.state.today.pumpSeconds, 120);
    assert.equal(g.live.pump, 100);
    assert.equal(g.live.pumpOn, true);
});


test('view() liefert 14 Tage inkl. Luecken und heute als letzten Eintrag', () => {
    const g = newGame();
    run(g, at(2026, 6, 1, 12), 5, { pump: 100 });
    run(g, at(2026, 6, 10, 12), 5, { pump: 100 });
    const v = g.view(at(2026, 6, 10, 13).getTime());
    assert.equal(v.days.length, 14);
    assert.equal(v.days[13].day, '2026-06-10');
    assert.equal(v.days[0].day, '2026-05-28');
    assert.equal(v.days.find(d => d.day === '2026-06-01').pumpSeconds, 300);
    assert.equal(v.days.find(d => d.day === '2026-06-05').pumpSeconds, 0);
});


test('Spielstand wird atomar gespeichert und wieder geladen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbus-game-'));
    const file = path.join(dir, 'state.json');
    try {
        const g = new Game({ settings: IDS, statePath: file, log: quiet });
        run(g, at(2026, 6, 1, 12), 20, { pump: 100, collector: 66 });
        g.save();
        assert.equal(g.dirty, false);
        assert.ok(!fs.existsSync(file + '.tmp'));

        const g2 = new Game({ settings: IDS, statePath: file, log: quiet });
        assert.deepEqual(g2.state, JSON.parse(JSON.stringify(g.state)));

        // defekte Datei -> Neustart statt Absturz
        fs.writeFileSync(file, '{kaputt');
        const g3 = new Game({ settings: IDS, statePath: file, log: quiet });
        assert.equal(g3.state.totals.pumpSeconds, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
