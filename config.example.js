module.exports = {
    // Sprache der Feldnamen ('de' oder 'en')
    language: 'de',

    // Sammel-/Schreibintervall in Sekunden.
    // 15 entspricht dem, was der ioBroker-Adapter schreibt.
    vbusInterval: 15,

    // Serielle Ports
    serialPorts: [{
        channel: 0,
        path: '/dev/vbus',       // stabiler Name via contrib/99-vbus.rules
        baudrate: 9600,
    }],

    // TCP-Endpunkt fuer weitere VBus-Clients. Auf false setzen zum Deaktivieren.
    tcp: {
        port: 7053,
    },

    // Web-Oberflaeche (ohne Authentifizierung!). Auf false setzen zum Deaktivieren.
    web: {
        port: 80,
    },

    influx: {
        // InfluxDB 1.x wird ueber den v2-Kompatibilitaetslayer angesprochen:
        //   bucket = '<datenbank>/<retention policy>', token = '' bzw. 'user:passwort'
        // Fuer InfluxDB 2.x stattdessen url/token/org/bucket regulaer setzen.
        url: 'http://influxdb.example:8086',
        token: '',
        org: '',
        bucket: 'resol/autogen',

        // Measurement-Praefix (ioBroker-Adapter-Namespace).
        namespace: 'resol.0',

        // Inhalt des `from`-Feldes, wie ihn der ioBroker-InfluxDB-Adapter setzt.
        from: 'system.adapter.resol.0',
    },

    // Gamification (Level, Rekorde, Sonnenserie, Abzeichen) in der Web-Oberflaeche.
    // Die Datenpunkt-IDs stehen in der Web-UI in der Tabelle "Datenpunkte"; bequemer
    // ist die Zuordnung dort unter "Spiel-Zuordnung" (wird in config.local.json gespeichert
    // und ueberschreibt diese Werte). null = nicht zugeordnet.
    game: {
        collector: null,        // Temperatur am Kollektor (°C)
        storage: null,          // Speichertemperatur (°C)
        pump: null,             // Relais/Drehzahl der Solarpumpe (%), > 0 = laeuft
        irradiation: null,      // optional: Einstrahlung (W/m²)
        sunnyDayMinutes: 60,    // Pumpenlaufzeit, ab der ein Tag als Sonnentag zaehlt
    },

    // Whitelist der zu schreibenden Datenpunkt-IDs.
    // Weglassen oder auf null setzen => alle erkannten Datenpunkte schreiben.
    // Format: <Geraeteadresse>.<Quelle>.<Paket-/Feld-ID>, z. B.
    // datapoints: ['0010.7721.000010100000000000020'],
    datapoints: null,
};
