import React, { useMemo, useState } from 'react';
import { AlertCircle, ChevronRight, RefreshCw } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { RefItem, SaleItem, User } from '../types';
import { ExamStatsCard } from '../components/ExamStatsCard';
import {
  formatEur,
  formatParisDate,
  formatParisDateTime,
  formatRelativeTime,
  getLevelLabel,
  getParisDayRange,
  getParisTodayStr,
  getUserDisplayName,
  isUserPaid,
} from '../utils/format';

interface OverviewPageProps {
  users: User[];
  refs: RefItem[];
  sales: SaleItem[];
  salesLoading: boolean;
  salesError: string | null;
  onRetrySales: () => void;
  onSelectUser: (user: User) => void;
  onNavigate: (tab: 'users' | 'growth') => void;
}

interface PeriodStats {
  key: 'today' | '7d' | 'all';
  label: string;
  newUsers: number;
  paidUsers: number;
  revenueCents: number;
  convRate: string;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
  users,
  refs,
  sales,
  salesLoading,
  salesError,
  onRetrySales,
  onSelectUser,
  onNavigate,
}) => {
  const [activePeriod, setActivePeriod] = useState<'today' | '7d' | 'all'>('all');
  const [chartMetric, setChartMetric] = useState<'users' | 'revenue'>('users');

  const refNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of refs) m.set(r.code, r.name);
    return m;
  }, [refs]);

  const now = useMemo(() => Date.now(), [users.length, sales.length]);

  const periods: PeriodStats[] = useMemo(() => {
    const todayStr = getParisTodayStr(now);
    const last7Set = new Set(getParisDayRange(7, now));

    const calc = (
      key: 'today' | '7d' | 'all',
      label: string,
      inRangeUser: (ms: number) => boolean,
      inRangeSale: (sec: number) => boolean,
    ): PeriodStats => {
      const newCount = users.filter((u) => inRangeUser(u.created)).length;
      const paidCount = users.filter((u) => isUserPaid(u) && u.paid_at && inRangeUser(u.paid_at)).length;
      const rev = sales.filter((s) => inRangeSale(s.t)).reduce((sum, s) => sum + s.amount, 0);
      const denom = key === 'all' ? users.length : newCount;
      const paidForConv = key === 'all' ? users.filter(isUserPaid).length : paidCount;
      const rate = denom > 0 ? `${((paidForConv / denom) * 100).toFixed(1)}%` : '0.0%';
      return {
        key,
        label,
        newUsers: newCount,
        paidUsers: key === 'all' ? users.filter(isUserPaid).length : paidCount,
        revenueCents: rev,
        convRate: rate,
      };
    };

    return [
      calc(
        'today',
        '今天',
        (ms) => formatParisDate(ms) === todayStr,
        (sec) => formatParisDate(sec * 1000) === todayStr,
      ),
      calc(
        '7d',
        '近 7 天',
        (ms) => last7Set.has(formatParisDate(ms)),
        (sec) => last7Set.has(formatParisDate(sec * 1000)),
      ),
      calc(
        'all',
        '全部累计',
        () => true,
        () => true,
      ),
    ];
  }, [users, sales, now]);

  const currentPeriod = useMemo(
    () => periods.find((p) => p.key === activePeriod) || periods[2],
    [periods, activePeriod],
  );

  const funnel = useMemo(() => {
    const total = users.length;
    const steps = [
      { label: '进来过', count: total },
      { label: '答了首页示范题', count: users.filter((u) => (u.sum?.demo ?? 0) > 0 || (u.sum?.seen ?? 0) > 0).length },
      { label: '选了考试类型', count: users.filter((u) => Boolean(u.level)).length },
      { label: '答过题', count: users.filter((u) => (u.sum?.seen ?? 0) > 0).length },
      { label: '答了 10 题以上', count: users.filter((u) => (u.sum?.seen ?? 0) >= 10).length },
      { label: '登录了账号', count: users.filter((u) => !u.id.startsWith('v:')).length },
      { label: '做过模考', count: users.filter((u) => (u.sum?.exams ?? 0) > 0).length },
      { label: '完成付费', count: users.filter(isUserPaid).length },
    ];

    let maxDropIdx = -1;
    let maxDropVal = 0;
    for (let i = 1; i < steps.length; i++) {
      const drop = steps[i - 1].count - steps[i].count;
      if (drop > maxDropVal) {
        maxDropVal = drop;
        maxDropIdx = i;
      }
    }

    return steps.map((s, idx) => ({
      ...s,
      pct: total > 0 ? Math.round((s.count / total) * 100) : 0,
      isBiggestDrop: idx === maxDropIdx && maxDropVal > 0,
      dropCount: idx > 0 ? Math.max(0, steps[idx - 1].count - s.count) : 0,
    }));
  }, [users]);

  const dailySeries = useMemo(() => {
    const days = getParisDayRange(14, now);
    const userMap = new Map<string, number>();
    const revMap = new Map<string, number>();

    for (const u of users) {
      const d = formatParisDate(u.created);
      userMap.set(d, (userMap.get(d) || 0) + 1);
    }
    for (const s of sales) {
      const d = formatParisDate(s.t * 1000);
      revMap.set(d, (revMap.get(d) || 0) + s.amount);
    }

    return days.map((day) => {
      const usersCount = userMap.get(day) || 0;
      const revCents = revMap.get(day) || 0;
      return {
        day,
        label: day.slice(8),
        users: usersCount,
        revenue: revCents,
        revenueEur: Number((revCents / 100).toFixed(2)),
      };
    });
  }, [users, sales, now]);

  const sales7dSeries = useMemo(() => {
    const days = getParisDayRange(7, now);
    const revMap = new Map<string, { cents: number; orders: number }>();
    for (const s of sales) {
      const d = formatParisDate(s.t * 1000);
      const cur = revMap.get(d) || { cents: 0, orders: 0 };
      cur.cents += s.amount;
      cur.orders += 1;
      revMap.set(d, cur);
    }
    return days.map((day) => {
      const item = revMap.get(day) || { cents: 0, orders: 0 };
      return {
        day,
        label: `${day.slice(5, 7)}/${day.slice(8, 10)}`,
        amountEur: Number((item.cents / 100).toFixed(2)),
        cents: item.cents,
        orders: item.orders,
      };
    });
  }, [sales, now]);

  const sales7dTotalCents = useMemo(
    () => sales7dSeries.reduce((sum, d) => sum + d.cents, 0),
    [sales7dSeries],
  );

  const recentOrders = useMemo(() => sales.slice(0, 5), [sales]);
  const recentUsers = useMemo(
    () => [...users].sort((a, b) => b.last_seen - a.last_seen).slice(0, 5),
    [users],
  );

  return (
    <div className="space-y-5 animate-view-enter">
      {salesError && (
        <div className="px-4 py-3 rounded-2xl bg-[#D97706]/10 border border-[#D97706]/25 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs sm:text-sm text-[#92400E] dark:text-[#FCD34D]">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{salesError}</span>
          </div>
          <button
            type="button"
            onClick={onRetrySales}
            className="min-h-[36px] px-3 py-1 rounded-xl bg-white dark:bg-[#1A2620] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] border border-[#DCE4E0] dark:border-[#2A3A32] whitespace-nowrap shrink-0 flex items-center gap-1"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>重试</span>
          </button>
        </div>
      )}

      {/* Hero Business Pulse Card */}
      <section
        aria-labelledby="overview-kpi-heading"
        className="rounded-3xl bg-gradient-to-br from-[#00593B] via-[#00704A] to-[#008A5A] text-white p-5 sm:p-6 shadow-lg shadow-[#00704A]/15"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="overview-kpi-heading" className="text-xs font-medium text-white/80">
              经营概况 · 巴黎时间
            </h2>
            <div className="mt-1.5 flex items-baseline gap-2.5">
              <span className="text-3xl sm:text-4xl font-bold tracking-tight tabular-nums">
                {salesLoading ? '…' : formatEur(currentPeriod.revenueCents)}
              </span>
              <span className="text-xs text-[#FFC933] font-medium">
                {currentPeriod.label}实付总额
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-xl bg-black/20">
            {periods.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setActivePeriod(p.key)}
                className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  activePeriod === p.key
                    ? 'bg-white text-[#00593B] shadow-xs font-semibold'
                    : 'text-white/80 hover:text-white'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 3 primary stats */}
        <div className="mt-5 pt-4 border-t border-white/15 grid grid-cols-3 gap-3 tabular-nums">
          <div>
            <div className="text-[11px] text-white/75">新来人数</div>
            <div className="mt-0.5 text-xl sm:text-2xl font-bold">{currentPeriod.newUsers}</div>
          </div>
          <div>
            <div className="text-[11px] text-white/75">付费人数</div>
            <div className="mt-0.5 text-xl sm:text-2xl font-bold text-[#FFC933]">
              {currentPeriod.paidUsers}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-white/75">转化率</div>
            <div className="mt-0.5 text-xl sm:text-2xl font-bold">{currentPeriod.convRate}</div>
          </div>
        </div>

        {/* Compact all-period comparison strip */}
        <div className="mt-4 pt-3 border-t border-white/10 grid grid-cols-3 gap-2 text-[11px] text-white/80 tabular-nums">
          {periods.map((p) => (
            <div key={p.key} className="truncate">
              <span className="text-white/60">{p.label}</span>{' '}
              <span className="font-semibold text-white">
                {p.newUsers}人 / {salesLoading ? '…' : formatEur(p.revenueCents)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <p className="text-[11px] text-[#5C6B64] dark:text-[#93A69D] px-1">
        注：收入来自 Stripe 实付总额，未扣手续费与退款。
      </p>

      {/* 7-Day Sales Trend (Recharts) */}
      <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <div>
            <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0]">
              过去 7 天销售趋势
            </h3>
            <p className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D]">
              按巴黎时间统计每日实付金额（EUR）
            </p>
          </div>
          <div className="text-right tabular-nums">
            <span className="text-xs text-[#5C6B64] dark:text-[#93A69D]">7 日合计 </span>
            <span className="text-sm font-bold text-[#00704A] dark:text-[#4AD29E]">
              {salesLoading ? '…' : formatEur(sales7dTotalCents)}
            </span>
          </div>
        </div>

        {salesLoading ? (
          <div className="h-[220px] rounded-xl bg-[#F1F5F3] dark:bg-[#192620] animate-pulse" />
        ) : (
          <div className="h-[220px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={sales7dSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="sales7dGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00A66C" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#00A66C" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="currentColor"
                  className="text-[#E6ECE9] dark:text-[#1F2D26]"
                />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 11, fill: '#64746D' }}
                  dy={6}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 11, fill: '#64746D' }}
                  tickFormatter={(v) => `€${v}`}
                  width={56}
                />
                <Tooltip
                  cursor={{ stroke: '#00A66C', strokeWidth: 1, strokeDasharray: '3 3' }}
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const item = payload[0].payload as (typeof sales7dSeries)[number];
                    return (
                      <div className="rounded-xl bg-[#101815] dark:bg-[#1C2A23] text-white px-3 py-2 shadow-lg border border-white/10 text-xs tabular-nums">
                        <div className="font-medium text-white/75">{item.day}</div>
                        <div className="mt-0.5 text-sm font-bold text-[#4AD29E]">
                          {formatEur(item.cents)}
                        </div>
                        <div className="text-white/75">{item.orders} 笔订单</div>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="amountEur"
                  stroke="#00A66C"
                  strokeWidth={2.5}
                  fill="url(#sales7dGradient)"
                  activeDot={{ r: 5, fill: '#00A66C', stroke: '#FFFFFF', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <ExamStatsCard users={users} />

      {/* Funnel + 14-day Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Funnel */}
        <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0]">
              转化漏斗
            </h3>
            <span className="text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
              共 {users.length} 人
            </span>
          </div>

          {users.length === 0 ? (
            <p className="py-8 text-center text-sm text-[#5C6B64] dark:text-[#93A69D]">暂无用户数据</p>
          ) : (
            <div className="space-y-3">
              {funnel.map((step, i) => (
                <div
                  key={step.label}
                  className={
                    step.isBiggestDrop
                      ? 'rounded-xl bg-[#D97706]/8 dark:bg-[#D97706]/12 px-2.5 py-2 -mx-2.5'
                      : ''
                  }
                >
                  <div className="flex items-baseline justify-between gap-2 text-xs mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[11px] text-[#5C6B64] dark:text-[#93A69D]">
                        0{i + 1}
                      </span>
                      <span className="font-medium text-[#101815] dark:text-[#EDF3F0] truncate">
                        {step.label}
                      </span>
                      {step.isBiggestDrop && (
                        <span className="text-[11px] font-semibold text-[#B45309] dark:text-[#FBBF24] whitespace-nowrap shrink-0">
                          · 流失最多 (-{step.dropCount})
                        </span>
                      )}
                    </div>
                    <span className="tabular-nums text-[#5C6B64] dark:text-[#93A69D] whitespace-nowrap shrink-0">
                      <strong className="text-[#101815] dark:text-[#EDF3F0] font-semibold">
                        {step.count}
                      </strong>{' '}
                      · {step.pct}%
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-[#EDF2EF] dark:bg-[#1A2620] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        step.isBiggestDrop
                          ? 'bg-[#D97706]'
                          : 'bg-gradient-to-r from-[#00704A] to-[#00A66C]'
                      }`}
                      style={{ width: `${Math.max(step.pct, step.count > 0 ? 3 : 0)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Daily Trend Bar Chart */}
        <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0]">
                近 14 天趋势
              </h3>
              <p className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D]">
                {chartMetric === 'users' ? '每日新增访问与注册人数' : '每日实付收入（EUR）'}
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-[#F1F5F3] dark:bg-[#192620] rounded-xl shrink-0">
              <button
                type="button"
                onClick={() => setChartMetric('users')}
                className={`min-h-[34px] px-3 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  chartMetric === 'users'
                    ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs'
                    : 'text-[#5C6B64] dark:text-[#93A69D]'
                }`}
              >
                新用户
              </button>
              <button
                type="button"
                onClick={() => setChartMetric('revenue')}
                className={`min-h-[34px] px-3 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  chartMetric === 'revenue'
                    ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs'
                    : 'text-[#5C6B64] dark:text-[#93A69D]'
                }`}
              >
                收入
              </button>
            </div>
          </div>

          <div className="h-[210px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailySeries} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="currentColor"
                  className="text-[#E6ECE9] dark:text-[#1F2D26]"
                />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: '#64746D' }}
                  interval={1}
                  dy={4}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 11, fill: '#64746D' }}
                  allowDecimals={chartMetric === 'revenue'}
                  tickFormatter={(v) => (chartMetric === 'revenue' ? `€${v}` : `${v}`)}
                  width={52}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(0, 166, 108, 0.08)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const item = payload[0].payload as (typeof dailySeries)[number];
                    return (
                      <div className="rounded-xl bg-[#101815] dark:bg-[#1C2A23] text-white px-3 py-2 shadow-lg border border-white/10 text-xs tabular-nums">
                        <div className="font-medium text-white/75">{item.day}</div>
                        <div className="mt-0.5 text-white">
                          新增 <strong className="text-[#4AD29E]">{item.users}</strong> 人
                        </div>
                        <div className="text-white/85">
                          收入 <strong className="text-[#FFC933]">{formatEur(item.revenue)}</strong>
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar
                  dataKey={chartMetric === 'users' ? 'users' : 'revenueEur'}
                  fill="#00A66C"
                  radius={[5, 5, 0, 0]}
                  maxBarSize={22}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      {/* Recent Orders & Recent Active Users */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0]">
              最近订单
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('growth')}
              className="min-h-[36px] text-xs font-medium text-[#00704A] dark:text-[#4AD29E] flex items-center gap-0.5 hover:underline"
            >
              <span>查看全部</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {salesLoading ? (
            <div className="space-y-2.5">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-12 rounded-xl bg-[#F1F5F3] dark:bg-[#192620] animate-pulse" />
              ))}
            </div>
          ) : recentOrders.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#5C6B64] dark:text-[#93A69D]">暂无订单记录</p>
          ) : (
            <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23]">
              {recentOrders.map((s, idx) => {
                const refLabel = s.ref ? refNameMap.get(s.ref) || `代号 ${s.ref}` : '官网直接';
                return (
                  <div key={`${s.t}-${idx}`} className="py-3 first:pt-1 last:pb-1 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#101815] dark:text-[#EDF3F0] truncate">
                        {refLabel}
                      </div>
                      <div className="text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
                        {formatParisDateTime(s.t * 1000)}
                      </div>
                    </div>
                    <div className="text-sm font-bold tabular-nums text-[#00704A] dark:text-[#4AD29E] shrink-0">
                      +{formatEur(s.amount)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0]">
              最近活跃用户
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('users')}
              className="min-h-[36px] text-xs font-medium text-[#00704A] dark:text-[#4AD29E] flex items-center gap-0.5 hover:underline"
            >
              <span>全部用户</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {recentUsers.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#5C6B64] dark:text-[#93A69D]">暂无用户</p>
          ) : (
            <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23]">
              {recentUsers.map((u) => {
                const paid = isUserPaid(u);
                const seen = u.sum?.seen ?? 0;
                const pool = u.sum?.pool ?? 0;
                const name = getUserDisplayName(u);
                const initial = name.slice(0, 1).toUpperCase();
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => onSelectUser(u)}
                    className="w-full min-h-[56px] py-2.5 flex items-center justify-between gap-3 text-left hover:bg-[#FAFBFB] dark:hover:bg-[#18231E] rounded-xl px-1.5 -mx-1.5 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                          paid
                            ? 'bg-[#00A66C]/15 text-[#00704A] dark:text-[#4AD29E]'
                            : !u.id.startsWith('v:')
                              ? 'bg-[#2F7CF6]/12 text-[#1D5EC9] dark:text-[#6CA6FF]'
                              : 'bg-[#EEF2F0] dark:bg-[#1C2822] text-[#5C6B64] dark:text-[#93A69D]'
                        }`}
                      >
                        {initial}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[#101815] dark:text-[#EDF3F0] truncate">
                            {name}
                          </span>
                          <span
                            className={`text-[11px] font-semibold shrink-0 ${
                              paid
                                ? 'text-[#00704A] dark:text-[#4AD29E]'
                                : 'text-[#5C6B64] dark:text-[#93A69D]'
                            }`}
                          >
                            {paid ? '已付费' : u.id.startsWith('v:') ? '访客' : '已登录'}
                          </span>
                        </div>
                        <div className="text-xs text-[#5C6B64] dark:text-[#93A69D] truncate tabular-nums">
                          {u.city || u.country || '未知地区'} · {getLevelLabel(u.level)} · 做题 {seen}
                          {pool ? `/${pool}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-[#5C6B64] dark:text-[#93A69D] shrink-0">
                      <span>{formatRelativeTime(u.last_seen, now)}</span>
                      <ChevronRight className="w-4 h-4 opacity-50" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
