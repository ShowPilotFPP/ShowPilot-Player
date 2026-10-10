// System timezone (schedules run in local time).
const { execFile } = require('child_process');

const VALID = /^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/;

function current() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }

function list() {
  return new Promise((resolve) => {
    execFile('timedatectl', ['list-timezones'], { timeout: 10000 }, (err, out) => {
      resolve(err ? [current()] : String(out).split('\n').filter(Boolean));
    });
  });
}

function set(tz) {
  return new Promise((resolve, reject) => {
    tz = String(tz || '');
    if (!VALID.test(tz)) return reject(new Error('bad timezone'));
    execFile('timedatectl', ['set-timezone', tz], { timeout: 10000 }, (err) => {
      if (err) return reject(new Error('could not set the timezone: ' + err.message));
      process.env.TZ = tz; // takes effect for new Date() in this process right away
      resolve(tz);
    });
  });
}

module.exports = { current, list, set, VALID };
