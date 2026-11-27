import React, { useMemo } from 'react';
import { User } from '../types';
import { getParisTodayStr, isUserPaid } from '../utils/format';

// What people are preparing for: the exam type each one chose, how many of them pay, how far they are,
// and when the ones who gave a date sit the exam.
const LEVELS: Array<{ id: string; label: string; sub: string; color: string }> = [
  { id: 'csp', label: '多年居留卡', sub: 'carte pluriannuelle', color: '#00A66C' },
  { id: 'cr', label: '十年居留卡', sub: 'carte de résident', color: '#2F7CF6' },
  { id: 'nat', label: '入籍', sub: 'naturalisation', color: '#E67E22' },
];
const DAY = 86400000;

function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY);
}

export const ExamStatsCard: React.FC<{ users: User[] }> = ({ users }) => {
  const stats = useMemo(() => {
    const week = Date.now() - 7 * DAY;
    const today = getParisTodayStr();
    const chosen = users.filter((u) => LEVELS.some((l) => l.id === u.level));
    const rows = LEVELS.map((l) => {
      const list = users.filter((u) => u.level === l.id);
      const paid = list.filter(isUserPaid).length;
      const seen = list.reduce((a, u) => a + (u.sum?.seen || 0), 0);
      return {
        ...l,
        n: list.length,
        share: chosen.length ? Math.round((100 * list.length) / chosen.length) : 0,
        paid,
        paidPct: list.length ? Math.round((100 * paid) / list.length) : 0,
        avgSeen: list.length ? Math.round(seen / list.length) : 0,
        live: list.filter((u) => u.last_seen > week).length,
      };
    });
    const dated = users.filter((u) => /^\d{4}-\d\d-\d\d$/.test(u.exam_date || ''));
    const buckets = [
      { label: '30 天内要考', test: (d: number) => d >= 0 && d <= 30, hot: true },
      { label: '1 到 3 个月', test: (d: number) => d > 30 && d <= 92, hot: false },
      { label: '3 个月以后', test: (d: number) => d > 92, hot: false },
      { label: '日期已过', test: (d: number) => d < 0, hot: false },
    ].map((b) => {
      const list = dated.filter((u) => b.test(daysUntil(u.exam_date, today)));
      return { ...b, n: list.length, unpaid: list.filter((u) => !isUserPaid(u)).length };
    });
    const undecided = users.filter((u) => !/^\d{4}-\d\d-\d\d$/.test(u.exam_date || '') && (u.sum as { nodate?: number } | null)?.nodate).length;
    return { rows, chosen: chosen.length, none: users.length - chosen.length, dated: dated.length, undecided, buckets };
  }, [users]);

  const max = Math.max(...stats.rows.map((r) => r.n));
  const leaders = stats.rows.filter((r) => r.n === max);
  const lead = stats.chosen === 0 ? '还没有人选考试类型。'
    : leaders.length === 1 ? `最多的是「${leaders[0].label}」，占 ${leaders[0].share}%。`
    : `${leaders.map((r) => '「' + r.label + '」').join('和')}一样多，各占 ${leaders[0].share}%。`;

  return (
    <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card" aria-label="大家在准备考什么">
      <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0] mb-1">大家在准备考什么</h3>
      <p className="text-xs text-[#5C6B64] dark:text-[#93A69D] mb-4 tabular-nums">
        选了类型 {stats.chosen} 人，没选 {stats.none} 人。{lead}
      </p>

      {stats.chosen > 0 && (
        <div className="h-3 rounded-full overflow-hidden flex mb-4 bg-[#EDF2EF] dark:bg-[#1A2620]" role="img" aria-label={stats.rows.map((r) => `${r.label} ${r.share}%`).join('，')}>
          {stats.rows.filter((r) => r.n > 0).map((r) => (
            <div key={r.id} style={{ width: `${r.share}%`, background: r.color }} />
          ))}
        </div>
      )}

      <div className="space-y-2.5">
        {stats.rows.map((r) => (
          <div key={r.id} className="rounded-xl border border-[#E8EEEB] dark:border-[#1F2D26] px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color }} />
                <span className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0] truncate">{r.label}</span>
                <span className="text-[11px] text-[#5C6B64] dark:text-[#93A69D] truncate hidden sm:inline">{r.sub}</span>
              </div>
              <span className="text-sm tabular-nums whitespace-nowrap">
                <strong className="text-[#101815] dark:text-[#EDF3F0]">{r.n}</strong>
                <span className="text-[#5C6B64] dark:text-[#93A69D]"> 人 · {r.share}%</span>
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
              <span className="whitespace-nowrap">付费 <b className="text-[#101815] dark:text-[#EDF3F0]">{r.paid}</b> · {r.paidPct}%</span>
              <span className="whitespace-nowrap">平均做题 <b className="text-[#101815] dark:text-[#EDF3F0]">{r.avgSeen}</b></span>
              <span className="whitespace-nowrap">近 7 天在用 <b className="text-[#101815] dark:text-[#EDF3F0]">{r.live}</b></span>
            </div>
          </div>
        ))}
      </div>

      <h4 className="mt-5 mb-2 text-[13px] font-semibold text-[#101815] dark:text-[#EDF3F0]">
        什么时候考 <span className="font-normal text-xs text-[#5C6B64] dark:text-[#93A69D]">（填了日期的 {stats.dated} 人，说还没定的 {stats.undecided} 人）</span>
      </h4>
      <div className="grid grid-cols-2 gap-2">
        {stats.buckets.map((b) => (
          <div key={b.label} className={`rounded-xl px-3 py-2 ${b.hot && b.n > 0 ? 'bg-[#D97706]/10 border border-[#D97706]/30' : 'bg-[#F4F7F5] dark:bg-[#18231E]'}`}>
            <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">{b.label}</div>
            <div className="text-lg font-bold tabular-nums text-[#101815] dark:text-[#EDF3F0]">{b.n}</div>
            {b.hot && b.n > 0 && <div className="text-[11px] text-[#B45309] dark:text-[#FBBF24]">其中 {b.unpaid} 人还没付费</div>}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-[#5C6B64] dark:text-[#93A69D]">考试类型和日期是用户自己在网站上选的、填的。</p>
    </section>
  );
};
