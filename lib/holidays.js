// Holiday dates for schedule start/end dates, using FPP's shortNames so FPP
// schedules import as-is ("Thanksgiving" + 1 day through "0000-01-06").
// User holidays from config/user-holidays.json (FPP format:
// [{ name, shortName, month, day }]) are added on top.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

// Gregorian Easter Sunday (anonymous algorithm).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
// nth weekday (n >= 1) of a month, or the last one (n = -1). wd: 0 = Sunday.
function nth(y, month, wd, n) {
  if (n > 0) {
    const first = new Date(y, month - 1, 1);
    return new Date(y, month - 1, 1 + ((wd - first.getDay() + 7) % 7) + (n - 1) * 7);
  }
  const last = new Date(y, month, 0);
  return new Date(y, month - 1, last.getDate() - ((last.getDay() - wd + 7) % 7));
}
const fixed = (m, d) => (y) => new Date(y, m - 1, d);
const add = (fn, days) => (y) => { const t = fn(y); return new Date(t.getFullYear(), t.getMonth(), t.getDate() + days); };

const BUILTIN = [
  ['NewYearsDay', "New Year's Day", fixed(1, 1)],
  ['MLKDay', 'Martin Luther King Jr. Day', (y) => nth(y, 1, 1, 3)],
  ['ValentinesDay', "Valentine's Day", fixed(2, 14)],
  ['PresidentsDay', "Presidents' Day", (y) => nth(y, 2, 1, 3)],
  ['StPatricksDay', "St. Patrick's Day", fixed(3, 17)],
  ['PalmSunday', 'Palm Sunday', add(easter, -7)],
  ['GoodFriday', 'Good Friday', add(easter, -2)],
  ['EasterSaturday', 'Easter Saturday', add(easter, -1)],
  ['Easter', 'Easter', easter],
  ['EasterMonday', 'Easter Monday', add(easter, 1)],
  ['MothersDay', "Mother's Day", (y) => nth(y, 5, 0, 2)],
  ['MemorialDayFri', 'Friday before Memorial Day', add((y) => nth(y, 5, 1, -1), -3)],
  ['MemorialDay', 'Memorial Day', (y) => nth(y, 5, 1, -1)],
  ['FathersDay', "Father's Day", (y) => nth(y, 6, 0, 3)],
  ['IndependenceDay', 'Independence Day', fixed(7, 4)],
  ['LaborDayFri', 'Friday before Labor Day', add((y) => nth(y, 9, 1, 1), -3)],
  ['LaborDay', 'Labor Day', (y) => nth(y, 9, 1, 1)],
  ['Halloween', 'Halloween', fixed(10, 31)],
  ['VeteransDay', 'Veterans Day', fixed(11, 11)],
  ['Thanksgiving', 'Thanksgiving (US)', (y) => nth(y, 11, 4, 4)],
  ['BlackFriday', 'Black Friday', add((y) => nth(y, 11, 4, 4), 1)],
  ['ChristmasEve', 'Christmas Eve', fixed(12, 24)],
  ['Christmas', 'Christmas Day', fixed(12, 25)],
  ['BoxingDay', 'Boxing Day', fixed(12, 26)],
  ['NewYearsEve', "New Year's Eve", fixed(12, 31)],
];

// Cached: dateOf() runs for every entry and day when listing next runs.
let cache = { at: 0, list: [] };
function userHolidays() {
  if (Date.now() - cache.at < 5000) return cache.list;
  cache = { at: Date.now(), list: readUserHolidays() };
  return cache.list;
}
function reload() { cache.at = 0; }

function readUserHolidays() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(paths.dir('config'), 'user-holidays.json'), 'utf8'));
    return (Array.isArray(j) ? j : []).filter((h) => h && h.shortName && h.month >= 1 && h.month <= 12 && h.day >= 1 && h.day <= 31)
      .map((h) => [String(h.shortName), String(h.name || h.shortName), fixed(+h.month, +h.day)]);
  } catch { return []; }
}

let merged = { src: null, map: null };
function all() {
  const u = userHolidays();
  if (merged.src !== u) {
    const map = new Map();
    for (const h of [...BUILTIN, ...u]) map.set(h[0], h);
    merged = { src: u, map };
  }
  return merged.map;
}

function list() { return [...all().values()].map(([shortName, name]) => ({ shortName, name })); }

// Date (local midnight) of a holiday in a year, or null if unknown.
function dateOf(shortName, year) {
  const h = all().get(shortName);
  return h ? h[2](year) : null;
}

module.exports = { list, dateOf, easter, reload };
