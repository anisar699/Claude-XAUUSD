// Recent alerts, kept in localStorage so the app screen can list what the
// background monitor sent.

const KEY = 'xau.alerts.v1';
const MAX = 30;

export function readAlerts() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((a) => a && typeof a.title === 'string' && Number.isFinite(a.t)) : [];
  } catch {
    return [];
  }
}

export function appendAlerts(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.concat(readAlerts()).slice(0, MAX)));
  } catch {
    /* storage unavailable: the notification itself was still sent */
  }
}

export function clearAlerts() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
