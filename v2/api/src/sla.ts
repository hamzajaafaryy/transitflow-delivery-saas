// Decree 2.26.530 reinstates GMT on 20 September 2026 at 02:00 local.
const legalGmt = Date.parse('2026-09-20T01:00:00Z');
const local = new Intl.DateTimeFormat('en-GB',{
  timeZone:'Africa/Casablanca',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});
export function casablancaZone(time:Date) { return +time>=legalGmt?'UTC':'Africa/Casablanca'; }

function parts(time:number) {
  if (time>=legalGmt) {
    const day=Math.floor(time/86_400_000)*86_400_000;
    return { day,minute:Math.floor((time-day)/60_000) };
  }
  const fields=Object.fromEntries(local.formatToParts(time).map(({type,value})=>[type,Number(value)]));
  return { day:Date.UTC(fields.year,fields.month-1,fields.day),minute:fields.hour*60+fields.minute };
}

function atLocalHour(day:number,hour:number) {
  const target=day+hour*3_600_000;
  const value=parts(target);
  return target-(value.day+value.minute*60_000-target);
}

export function workingMinutes(start:Date,end:Date,holidays:Set<string>) {
  let minutes=0;
  const first=parts(+start).day,last=parts(+end).day;
  for (let day=first;day<=last;day+=86_400_000) {
    const date=new Date(day);
    if (date.getUTCDay()===0 || holidays.has(date.toISOString().slice(0,10))) continue;
    for (const [opening,closing] of [[9,12],[14,18]]) {
      minutes+=Math.max(0,Math.min(+end,atLocalHour(day,closing))-Math.max(+start,atLocalHour(day,opening)))/60_000;
    }
  }
  return minutes;
}
