import { LEVEL_LABELS } from '../constants';
import { ExamLevel, User } from '../types';

const parisDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const parisDateTimeFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatParisDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return parisDateFmt.format(new Date(ms));
}

export function formatParisMonth(ms: number | null | undefined): string {
  if (!ms) return '';
  return parisDateFmt.format(new Date(ms)).slice(0, 7);
}

export function formatParisDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return parisDateTimeFmt.format(new Date(ms)).replace('T', ' ');
}

export function getParisTodayStr(now = Date.now()): string {
  return parisDateFmt.format(new Date(now));
}

export function getParisDayRange(daysCount: number, now = Date.now()): string[] {
  const result: string[] = [];
  for (let i = daysCount - 1; i >= 0; i--) {
    result.push(parisDateFmt.format(new Date(now - i * 86400_000)));
  }
  return result;
}

export function formatRelativeTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatParisDate(ms);
}

export function formatDuration(secs: number): string {
  if (!secs || secs < 0) return '0 分';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m === 0) return `${s} 秒`;
  return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

export function getExamCountdown(examDate: string, now = Date.now()): string | null {
  if (!examDate) return null;
  const todayStr = getParisTodayStr(now);
  const todayMs = Date.parse(todayStr + 'T00:00:00Z');
  const targetMs = Date.parse(examDate + 'T00:00:00Z');
  if (Number.isNaN(targetMs)) return null;
  const diffDays = Math.round((targetMs - todayMs) / 86400_000);
  if (diffDays === 0) return '今天考试';
  if (diffDays > 0) return `距离考试还有 ${diffDays} 天`;
  return `已过考试日 ${Math.abs(diffDays)} 天`;
}

export function isUserPaid(user: Pick<User, 'id' | 'unlocked'>): boolean {
  return user.id.startsWith('b:') || user.unlocked === 1;
}

export function getUserIdentityLabel(user: Pick<User, 'id' | 'unlocked'>): '付费' | '已登录' | '访客' {
  if (isUserPaid(user)) return '付费';
  if (!user.id.startsWith('v:')) return '已登录';
  return '访客';
}

export function getUserDisplayName(user: Pick<User, 'id' | 'login' | 'email' | 'unlocked'>): string {
  if (isUserPaid(user)) {
    if (user.email) return user.email;
    if (user.login) return user.login;
    const raw = user.id.startsWith('b:') ? user.id.slice(2) : user.id;
    return `付费用户 ${raw.slice(0, 4)}`;
  }
  if (!user.id.startsWith('v:')) {
    return user.login || user.id.slice(2);
  }
  return `访客 ${user.id.slice(2, 8)}`;
}

export function getLevelLabel(level: string): string {
  if (!level) return '未选';
  return LEVEL_LABELS[level as ExamLevel] || level;
}

export function parseUserAgent(ua: string | undefined | null): string {
  if (!ua) return '未知设备';
  let os = '未知设备';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = '安卓';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'Mac';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';

  const extras: string[] = [];
  if (/MicroMessenger/i.test(ua)) extras.push('微信');
  else if (/Safari/i.test(ua) && !/Chrome|CriOS/i.test(ua)) extras.push('Safari');
  else if (/Chrome|CriOS/i.test(ua)) extras.push('Chrome');

  return extras.length > 0 ? `${os} · ${extras.join(' ')}` : os;
}

export function formatEur(cents: number): string {
  const eur = cents / 100;
  return `€${eur.toFixed(2)}`;
}

export function getRefLink(code: string): string {
  if (!code) return 'https://kaocivique.com/';
  return `https://kaocivique.com/?r=${encodeURIComponent(code)}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below for iOS Safari / WeChat WebView
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number>>): void {
  const escapeCell = (val: string | number) => {
    const s = String(val ?? '');
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))];
  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
