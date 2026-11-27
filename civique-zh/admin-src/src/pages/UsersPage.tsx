import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { RefItem, User } from '../types';
import {
  formatRelativeTime,
  getLevelLabel,
  getUserDisplayName,
  getUserIdentityLabel,
  isUserPaid,
} from '../utils/format';

interface UsersPageProps {
  users: User[];
  refs: RefItem[];
  loading: boolean;
  onSelectUser: (user: User) => void;
}

type FilterType = 'all' | 'paid' | 'unpaid' | 'visitor';
type SortType = 'last_seen' | 'seen' | 'created';

export const UsersPage: React.FC<UsersPageProps> = ({ users, refs, loading, onSelectUser }) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [refFilter, setRefFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortType>('last_seen');
  const [limit, setLimit] = useState(40);

  useEffect(() => {
    setLimit(40);
  }, [query, filter, refFilter, sortBy]);

  const refMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of refs) m.set(r.code, r.name);
    return m;
  }, [refs]);

  const counts = useMemo(() => {
    const paid = users.filter(isUserPaid).length;
    const visitor = users.filter((u) => u.id.startsWith('v:')).length;
    const loggedIn = users.length - paid - visitor;
    return { total: users.length, paid, loggedIn, visitor };
  }, [users]);

  const refOptions = useMemo(() => {
    const known = new Map<string, string>();
    for (const r of refs) known.set(r.code, r.name);
    const seenCodes = new Set<string>();
    for (const u of users) {
      if (u.ref) seenCodes.add(u.ref);
    }
    const items: Array<{ code: string; label: string }> = refs.map((r) => ({
      code: r.code,
      label: `${r.name} (${r.code})`,
    }));
    for (const code of seenCodes) {
      if (!known.has(code)) {
        items.push({ code, label: `${code}（未登记）` });
      }
    }
    return items;
  }, [refs, users]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = users.filter((u) => {
      if (filter === 'paid' && !isUserPaid(u)) return false;
      if (filter === 'unpaid' && isUserPaid(u)) return false;
      if (filter === 'visitor' && !u.id.startsWith('v:')) return false;
      if (refFilter === '__direct__' && u.ref) return false;
      if (refFilter !== 'all' && refFilter !== '__direct__' && (u.ref || '') !== refFilter) {
        return false;
      }

      if (!q) return true;
      const refName = u.ref ? refMap.get(u.ref) || '' : '官网直接';
      return (
        u.id.toLowerCase().includes(q) ||
        (u.login || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.city || '').toLowerCase().includes(q) ||
        (u.ref || '').toLowerCase().includes(q) ||
        refName.toLowerCase().includes(q)
      );
    });

    list = [...list].sort((a, b) => {
      if (sortBy === 'seen') return (b.sum?.seen ?? 0) - (a.sum?.seen ?? 0);
      if (sortBy === 'created') return b.created - a.created;
      return b.last_seen - a.last_seen;
    });

    return list;
  }, [users, query, filter, refFilter, sortBy, refMap]);

  const filterButtons: Array<{ key: FilterType; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'paid', label: '付费' },
    { key: 'unpaid', label: '未付费' },
    { key: 'visitor', label: '匿名访客' },
  ];

  return (
    <div className="space-y-4 animate-view-enter">
      {/* Unboxed Summary Strip */}
      <div className="px-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
        <div>
          总计 <strong className="text-[#101815] dark:text-[#EDF3F0]">{counts.total}</strong> · 付费{' '}
          <strong className="text-[#00704A] dark:text-[#4AD29E]">{counts.paid}</strong> · 已登录{' '}
          <strong className="text-[#101815] dark:text-[#EDF3F0]">{counts.loggedIn}</strong> · 访客{' '}
          <strong className="text-[#101815] dark:text-[#EDF3F0]">{counts.visitor}</strong>
        </div>
        <span>点击任意用户查看学习轨迹</span>
      </div>

      {/* Search & Controls */}
      <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-3.5 sm:p-4 space-y-3 surface-card">
        <div className="relative">
          <Search className="w-4 h-4 text-[#5C6B64] dark:text-[#93A69D] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜手机号、邮箱、城市、推荐人或 ID"
            className="w-full min-h-[44px] pl-10 pr-3.5 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0] focus:outline-none focus:border-[#00A66C] transition-colors"
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="grid grid-cols-4 sm:flex items-center gap-1 p-1 bg-[#F1F5F3] dark:bg-[#192620] rounded-xl">
            {filterButtons.map((btn) => (
              <button
                key={btn.key}
                type="button"
                onClick={() => setFilter(btn.key)}
                className={`min-h-[38px] px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  filter === btn.key
                    ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs font-semibold'
                    : 'text-[#5C6B64] dark:text-[#93A69D]'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
              匹配 {filtered.length} 人
            </span>
            <div className="flex items-center gap-2">
              <select
                value={refFilter}
                onChange={(e) => setRefFilter(e.target.value)}
                aria-label="按推荐来源筛选"
                className="min-h-[40px] max-w-[170px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-xs font-medium text-[#101815] dark:text-[#EDF3F0]"
              >
                <option value="all">全部来源</option>
                <option value="__direct__">官网直接</option>
                {refOptions.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.label}
                  </option>
                ))}
              </select>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortType)}
                aria-label="排序方式"
                className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-xs font-medium text-[#101815] dark:text-[#EDF3F0]"
              >
                <option value="last_seen">最近使用</option>
                <option value="seen">做题最多</option>
                <option value="created">注册时间</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* User Cards List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-28 rounded-2xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl py-12 text-center text-sm text-[#5C6B64] dark:text-[#93A69D] surface-card">
          没有找到符合条件的用户
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {filtered.slice(0, limit).map((u) => {
            const paid = isUserPaid(u);
            const identity = getUserIdentityLabel(u);
            const seen = u.sum?.seen ?? 0;
            const pool = u.sum?.pool ?? 0;
            const ok = u.sum?.ok ?? 0;
            const miss = u.sum?.miss ?? 0;
            const exams = u.sum?.exams ?? 0;
            const best = u.sum?.best ?? 0;
            const bestN = u.sum?.bestN ?? 0;
            const seenPct = pool > 0 ? Math.min(100, Math.round((seen / pool) * 100)) : 0;
            const okPct = pool > 0 ? Math.min(100, Math.round((ok / pool) * 100)) : 0;
            const refKnownName = u.ref ? refMap.get(u.ref) : undefined;
            const sourceText = u.ref
              ? refKnownName
                ? `通过「${refKnownName}」(${u.ref}) 进来`
                : `通过 ${u.ref}（未登记）进来`
              : '官网直接进来';
            const displayName = getUserDisplayName(u);
            const initial = displayName.slice(0, 1).toUpperCase();

            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onSelectUser(u)}
                className="w-full text-left bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] hover:border-[#00A66C]/60 active:scale-[0.99] rounded-2xl p-4 transition-all surface-card"
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
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
                        <span className="text-sm sm:text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0] truncate">
                          {displayName}
                        </span>
                        <span
                          className={`text-xs font-semibold shrink-0 ${
                            paid
                              ? 'text-[#00704A] dark:text-[#4AD29E]'
                              : !u.id.startsWith('v:')
                                ? 'text-[#2F7CF6] dark:text-[#6CA6FF]'
                                : 'text-[#5C6B64] dark:text-[#93A69D]'
                          }`}
                        >
                          {identity}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D] truncate tabular-nums">
                        {[u.city || u.country || '未知地区', getLevelLabel(u.level)].join(' · ')}
                      </p>
                      <p
                        className={`mt-0.5 text-xs truncate font-medium ${
                          u.ref
                            ? refKnownName
                              ? 'text-[#00704A] dark:text-[#4AD29E]'
                              : 'text-[#B45309] dark:text-[#FBBF24]'
                            : 'text-[#5C6B64] dark:text-[#93A69D]'
                        }`}
                      >
                        {sourceText}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 text-xs text-[#5C6B64] dark:text-[#93A69D] shrink-0 pt-0.5">
                    <span>{formatRelativeTime(u.last_seen)}</span>
                    <ChevronRight className="w-4 h-4 opacity-50" />
                  </div>
                </div>

                {/* Dual-layer Progress Bar & Metrics */}
                <div className="mt-3.5 pt-3 border-t border-[#EEF2F0] dark:border-[#1D2A23]">
                  <div className="flex items-center justify-between gap-2 text-xs tabular-nums mb-1.5">
                    <span className="text-[#101815] dark:text-[#EDF3F0] font-medium">
                      做过 {seen}
                      {pool > 0 ? ` / ${pool}` : ''} · 掌握 {ok}
                    </span>
                    <span className="text-[#5C6B64] dark:text-[#93A69D]">
                      错题 {miss}
                      {exams > 0 ? ` · 模考最高 ${best}/${bestN}` : ''}
                    </span>
                  </div>
                  <div className="relative h-2 rounded-full bg-[#EEF2F0] dark:bg-[#1B2721] overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-[#00A66C]/28"
                      style={{ width: `${seenPct}%` }}
                    />
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-[#00A66C]"
                      style={{ width: `${okPct}%` }}
                    />
                  </div>
                </div>
              </button>
            );
          })}
          </div>

          {filtered.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + 40)}
              className="w-full min-h-[44px] py-2.5 rounded-xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] text-sm font-medium text-[#00704A] dark:text-[#4AD29E] hover:bg-[#FAFBFB] dark:hover:bg-[#1A2620] surface-card"
            >
              加载更多（还有 {filtered.length - limit} 人）
            </button>
          )}
        </div>
      )}
    </div>
  );
};
