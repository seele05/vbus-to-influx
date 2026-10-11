'use strict';

/*
 * Bildet die Datenpunkt-IDs und Wert-Transformationen des ioBroker-Adapters
 * `iobroker.resol` 1.5.1 exakt nach, damit dieses Tool die bestehenden
 * InfluxDB-Serien nahtlos weiterschreibt.
 *
 * Referenz: iobroker.resol/main.js
 *   - Zeilen 758-760  → ID-Bildung
 *   - Zeilen 772-836  → Wert-Transformation je rootTypeId / unitId
 */


/**
 * `<deviceId ohne _>.<selfAddress dezimal>.<packetFieldId ohne _>`
 * Beispiel: 0010.7721.000010100000000000020
 */
function objectIdOf(packetField) {
    const device = packetField.packetSpec.sourceDevice;

    return `${device.deviceId.replace(/_/g, '')}.${device.selfAddress}.${packetField.id.replace(/_/g, '')}`;
}


function isBitField(packetField) {
    const parts = packetField.packetFieldSpec.parts;

    return !!parts && parts.length === 1 && parts[0].mask !== 0xFF;
}


/**
 * Liefert `{ value, extra }`. `extra` ist der zusaetzliche `_1`-Datenpunkt,
 * den der Adapter fuer Prozent-Felder als Relais-Aktiv-Flag anlegt.
 * `value === null` bedeutet: nicht schreiben (defekter/fehlender Sensor).
 */
function transformValue(spec, packetField) {
    const type = packetField.packetFieldSpec.type;
    const rawValue = packetField.rawValue;

    let value;
    if (rawValue === undefined || rawValue === null) {
        value = 0;
    } else if (type.rootTypeId === 'Number') {
        value = Math.round(parseFloat(rawValue.toFixed(type.precision)) * 100) / 100;
    } else if (type.rootTypeId === 'Time') {
        value = spec.i18n.moment(rawValue * 60000).utc().format('HH:mm');
    } else if (type.rootTypeId === 'Weektime') {
        value = spec.i18n.moment((rawValue + 5760) * 60000).utc().format('dd,HH:mm');
    } else if (type.rootTypeId === 'DateTime') {
        value = spec.i18n.moment((rawValue + 978307200) * 1000).utc().format('L HH:mm:ss');
    }

    let extra = null;

    switch (type.unit.unitId) {
        case 'DegreesCelsius':
            // 999 / 888 sind die Fehlercodes fuer "Sensor offen" bzw. "Kurzschluss"
            if (Math.abs(Math.trunc(value)) === 999 || Math.abs(Math.trunc(value)) === 888) {
                value = null;
            }
            break;
        case 'Percent':
            extra = { suffix: '_1', value: value > 0 };
            break;
        case 'None':
            if (isBitField(packetField)) {
                value = (value === 1);
            }
            break;
    }

    return { value, extra };
}


module.exports = { objectIdOf, transformValue, isBitField };
