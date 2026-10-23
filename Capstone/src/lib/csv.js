// minimal csv for labelling sheet 
// (comma separated, double-quote escaping, first row = header)

const quote = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(columns, rows) {
    return [columns.join(','), ...rows.map(r => columns.map(c => quote(r[c])).join(','))].join('\n') + '\n';
}

// returns array of objects keyed by header 
// tolerates BOM and CRLF (spreadsheet exports)
export function parseCsv(text) {
    const records = [];
    let field = '';
    let record = [];
    let inQuotes = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"' && src[i + 1] === '"') {
                field += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            record.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i++;
            record.push(field);
            field = '';
            if (record.some(f => f !== '')) records.push(record);
            record = [];
        } else {
            field += ch;
        }
    }
    record.push(field);
    if (record.some(f => f !== '')) records.push(record);

    const [header, ...rows] = records;
    return rows.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}
