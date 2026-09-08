const BOSTON_ZONE = "America/New_York";

export function bostonHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BOSTON_ZONE,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  return Number(parts.find(({ type }) => type === "hour")?.value ?? 0);
}

export function getBostonState(date = new Date()) {
  const hour = bostonHour(date);
  if (hour >= 7 && hour < 18) return "day";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

export function formatBostonTime(date = new Date()) {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: BOSTON_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).replace(" ", "").toLowerCase();
  return `${time} in Boston, Massachusetts`;
}

function updateBostonFooter(date = new Date()) {
  const time = document.querySelector("#boston-time");
  const cat = document.querySelector(".cat");
  if (time) time.textContent = formatBostonTime(date);
  if (cat) cat.dataset.state = getBostonState(date);
}

if (typeof document !== "undefined") {
  updateBostonFooter();
  window.setInterval(updateBostonFooter, 30_000);
}
