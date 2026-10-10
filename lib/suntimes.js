// Sunrise / sunset / civil dawn / civil dusk for schedule start and end
// times. NOAA's simplified solar position algorithm (accurate to about a
// minute, which is plenty for a light show). Returns local Date objects, or
// null for polar day/night.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function dayOfYear(d) {
  const start = Date.UTC(d.getFullYear(), 0, 0);
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((now - start) / 86400000);
}

// zenith: 90.833 for sunrise/sunset, 96 for civil twilight.
function solarEvent(date, lat, lon, rising, zenith) {
  const N = dayOfYear(date);
  const lngHour = lon / 15;
  const t = N + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(rad(M)) + 0.020 * Math.sin(rad(2 * M)) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = deg(Math.atan(0.91764 * Math.tan(rad(L))));
  RA = ((RA % 360) + 360) % 360;
  RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
  RA /= 15;
  const sinDec = 0.39782 * Math.sin(rad(L));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(rad(zenith)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
  if (cosH > 1 || cosH < -1) return null;
  let H = rising ? 360 - deg(Math.acos(cosH)) : deg(Math.acos(cosH));
  H /= 15;
  const T = H + RA - 0.06571 * t - 6.622;
  let UT = T - lngHour;
  UT = ((UT % 24) + 24) % 24;
  const ms = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + UT * 3600000;
  let d = new Date(ms);
  // UT may land on the neighbouring UTC day; pull it onto the requested local day.
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  while (d - local >= 86400000) d = new Date(d - 86400000);
  while (d < local) d = new Date(+d + 86400000);
  return d;
}

function sunTimes(date, lat, lon) {
  if (lat === null || lon === null || lat === undefined || lon === undefined || lat === '' || lon === '') return null;
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    dawn: solarEvent(date, lat, lon, true, 96),
    sunrise: solarEvent(date, lat, lon, true, 90.833),
    sunset: solarEvent(date, lat, lon, false, 90.833),
    dusk: solarEvent(date, lat, lon, false, 96),
  };
}

module.exports = { sunTimes };
