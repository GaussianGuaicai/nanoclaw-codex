function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function formatOffset(minutesWestOfUtc: number): string {
  const totalMinutes = -minutesWestOfUtc;
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(totalMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

export function formatLocalIsoTimestamp(
  input: Date | string | number = new Date(),
): string {
  const date = input instanceof Date ? input : new Date(input);

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
    formatOffset(date.getTimezoneOffset()),
  ].join('');
}

export function formatLocalDate(input: Date | string | number = new Date()): string {
  return formatLocalIsoTimestamp(input).split('T')[0];
}
