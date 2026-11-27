import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react';
import { adminRequest, ApiError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatErrorMessage } from '../constants';
import { RefItem, SaleItem, User } from '../types';
import {
  copyText,
  downloadCsv,
  formatEur,
  formatParisDateTime,
  formatParisMonth,
  formatRelativeTime,
  getLevelLabel,
  getRefLink,
  getUserDisplayName,
  getUserIdentityLabel,
  isUserPaid,
} from '../utils/format';

interface GrowthPageProps {
  users: User[];
  refs: RefItem[];
  sales: SaleItem[];
  salesMore: boolean;
  salesLoading: boolean;
  salesError: string | null;
  onRetrySales: () => void;
  onRefreshRefs: () => Promise<void>;
  onSelectUser: (user: User) => void;
  onOpenPoster: (code: string, name: string) => void;
  onToast: (msg: string) => void;
}

export const GrowthPage: React.FC<GrowthPageProps> = ({
  users,
  refs,
  sales,
  salesMore,
  salesLoading,
  salesError,
  onRetrySales,
  onRefreshRefs,
  onSelectUser,
  onOpenPoster,
  onToast,
}) => {
  const [subTab, setSubTab] = useState<'refs' | 'sales'>('refs');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [refSort, setRefSort] = useState<'default' | 'revenue' | 'users' | 'commission'>('default');
  const [salesLimit, setSalesLimit] = useState(50);

  // Expanded referrer users drawer
  const [expandedRefCode, setExpandedRefCode] = useState<string | null>(null);
  const [expandedPaidOnly, setExpandedPaidOnly] = useState(false);
  const [expandedLimit, setExpandedLimit] = useState(20);

  useEffect(() => {
    setSalesLimit(50);
  }, [monthFilter, subTab]);

  const toggleExpandedRef = (code: string) => {
    setExpandedPaidOnly(false);
    setExpandedLimit(20);
    setExpandedRefCode((prev) => (prev === code ? null : code));
  };

  // Add / Edit Referrer form state
  const [formOpen, setFormOpen] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formPct, setFormPct] = useState('30');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSaving, setFormSaving] = useState(false);

  // Newly created referrer banner
  const [createdRef, setCreatedRef] = useState<{ code: string; name: string } | null>(null);

  // Confirm Delete Referrer
  const [deletingRef, setDeletingRef] = useState<RefItem | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    for (const s of sales) {
      const m = formatParisMonth(s.t * 1000);
      if (m) set.add(m);
    }
    for (const u of users) {
      const m = formatParisMonth(u.created);
      if (m) set.add(m);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [sales, users]);

  const filteredSales = useMemo(() => {
    if (monthFilter === 'all') return sales;
    return sales.filter((s) => formatParisMonth(s.t * 1000) === monthFilter);
  }, [sales, monthFilter]);

  const refNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of refs) m.set(r.code, r.name);
    return m;
  }, [refs]);

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86400_000;

  const computeChannelStats = (code: string) => {
    const chUsers = users.filter((u) => (u.ref || '') === code);
    const paidUsers = chUsers.filter(isUserPaid).length;
    const active7d = chUsers.filter((u) => u.last_seen >= sevenDaysAgo).length;
    const chSales = filteredSales.filter((s) => (s.ref || '') === code);
    const revenueCents = chSales.reduce((acc, s) => acc + s.amount, 0);
    return {
      totalUsers: chUsers.length,
      paidUsers,
      active7d,
      orders: chSales.length,
      revenueCents,
    };
  };

  const registeredRows = useMemo(() => {
    const rows = refs.map((r) => {
      const stats = computeChannelStats(r.code);
      const commissionCents = Math.round((stats.revenueCents * r.pct) / 100);
      return { ref: r, ...stats, commissionCents };
    });
    if (refSort === 'revenue') {
      rows.sort((a, b) => b.revenueCents - a.revenueCents);
    } else if (refSort === 'users') {
      rows.sort((a, b) => b.totalUsers - a.totalUsers);
    } else if (refSort === 'commission') {
      rows.sort((a, b) => b.commissionCents - a.commissionCents);
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, users, filteredSales, refSort]);

  const totalCommissionCents = useMemo(
    () => registeredRows.reduce((sum, r) => sum + r.commissionCents, 0),
    [registeredRows],
  );

  const totalFilteredRevenueCents = useMemo(
    () => filteredSales.reduce((sum, s) => sum + s.amount, 0),
    [filteredSales],
  );

  const directRow = useMemo(() => computeChannelStats(''), [users, filteredSales]);

  const unregisteredCodes = useMemo(() => {
    const registeredSet = new Set(refs.map((r) => r.code));
    const unknownSet = new Set<string>();
    for (const u of users) {
      if (u.ref && !registeredSet.has(u.ref)) unknownSet.add(u.ref);
    }
    for (const s of sales) {
      if (s.ref && !registeredSet.has(s.ref)) unknownSet.add(s.ref);
    }
    return Array.from(unknownSet).map((code) => ({
      code,
      ...computeChannelStats(code),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, users, sales, filteredSales]);

  const monthlySummaries = useMemo(() => {
    const map = new Map<string, { month: string; count: number; cents: number }>();
    for (const s of sales) {
      const m = formatParisMonth(s.t * 1000) || '未知';
      const cur = map.get(m) || { month: m, count: 0, cents: 0 };
      cur.count += 1;
      cur.cents += s.amount;
      map.set(m, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.month.localeCompare(a.month));
  }, [sales]);

  const openAddForm = (prefillCode = '') => {
    setEditingCode(null);
    setFormName('');
    setFormCode(prefillCode);
    setFormPct('30');
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (r: RefItem) => {
    setEditingCode(r.code);
    setFormName(r.name);
    setFormCode(r.code);
    setFormPct(String(r.pct));
    setFormError(null);
    setFormOpen(true);
  };

  const handleSaveRef = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = formName.trim();
    const code = formCode.trim();
    const pctNum = Number(formPct);
    if (!name || name.length > 60) {
      setFormError('请填写推荐人名字（最多 60 字）。');
      return;
    }
    if (!Number.isInteger(pctNum) || pctNum < 0 || pctNum > 100) {
      setFormError('佣金比例请填 0 到 100 的整数。');
      return;
    }
    if (!editingCode && code && !/^[a-zA-Z0-9_-]{1,40}$/.test(code)) {
      setFormError('代号只能用英文字母、数字、下划线或短横线（最多 40 位）。');
      return;
    }

    setFormSaving(true);
    setFormError(null);
    try {
      const payload: Record<string, unknown> = {
        name,
        pct: pctNum,
      };
      if (editingCode) {
        payload.code = editingCode;
        payload.fresh = false;
      } else {
        if (code) payload.code = code;
        payload.fresh = true;
      }

      const resp = await adminRequest<{ ok: true; code: string }>('ref-set', payload);
      await onRefreshRefs();
      setFormOpen(false);
      if (!editingCode) {
        setCreatedRef({ code: resp.code, name });
        onToast('已添加推荐人');
      } else {
        onToast('已更新推荐人');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(formatErrorMessage(err.code, { hasToken: true }));
      } else {
        setFormError('保存失败，请稍后再试。');
      }
    } finally {
      setFormSaving(false);
    }
  };

  const handleDeleteRef = async () => {
    if (!deletingRef) return;
    setDeleteLoading(true);
    try {
      await adminRequest('ref-del', { code: deletingRef.code });
      await onRefreshRefs();
      onToast(`已移除「${deletingRef.name}」`);
      setDeletingRef(null);
    } catch (err) {
      if (err instanceof ApiError) {
        onToast(formatErrorMessage(err.code, { hasToken: true }));
      } else {
        onToast('移除失败，请稍后再试');
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleCopy = async (code: string) => {
    const ok = await copyText(getRefLink(code));
    onToast(ok ? '推荐链接已复制' : '复制失败，请手动复制');
  };

  const handleExportRefsCsv = () => {
    const headers = ['类型', '名称', '代号', '佣金比例(%)', '带来人数', '其中付费', '近7天活跃', '订单数', '收入(EUR)', '应付佣金(EUR)'];
    const rows: Array<Array<string | number>> = [];
    for (const row of registeredRows) {
      rows.push([
        '已登记',
        row.ref.name,
        row.ref.code,
        row.ref.pct,
        row.totalUsers,
        row.paidUsers,
        row.active7d,
        row.orders,
        (row.revenueCents / 100).toFixed(2),
        (row.commissionCents / 100).toFixed(2),
      ]);
    }
    rows.push([
      '官网直接',
      '官网直接来的',
      '',
      0,
      directRow.totalUsers,
      directRow.paidUsers,
      directRow.active7d,
      directRow.orders,
      (directRow.revenueCents / 100).toFixed(2),
      '0.00',
    ]);
    for (const u of unregisteredCodes) {
      rows.push([
        '未登记',
        '未登记代号',
        u.code,
        0,
        u.totalUsers,
        u.paidUsers,
        u.active7d,
        u.orders,
        (u.revenueCents / 100).toFixed(2),
        '0.00',
      ]);
    }
    downloadCsv(`kaocivique-referrers-${monthFilter}.csv`, headers, rows);
    onToast('已导出推荐人统计 CSV');
  };

  const handleExportSalesCsv = () => {
    const headers = ['时间(巴黎)', '金额(EUR)', '币种', '推荐人代号', '推荐人名称'];
    const rows = filteredSales.map((s) => [
      formatParisDateTime(s.t * 1000),
      (s.amount / 100).toFixed(2),
      s.currency.toUpperCase(),
      s.ref || '',
      s.ref ? refNameMap.get(s.ref) || '未登记' : '官网直接',
    ]);
    downloadCsv(`kaocivique-sales-${monthFilter}.csv`, headers, rows);
    onToast('已导出销售明细 CSV');
  };

  return (
    <div className="space-y-4 animate-view-enter">
      {/* Sub-navigation & Month Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="grid grid-cols-2 sm:flex items-center gap-1 p-1 bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-xl surface-card">
          <button
            type="button"
            onClick={() => setSubTab('refs')}
            className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
              subTab === 'refs'
                ? 'bg-[#00A66C] text-white font-semibold'
                : 'text-[#5C6B64] dark:text-[#93A69D] hover:text-[#101815] dark:hover:text-[#EDF3F0]'
            }`}
          >
            推荐人与佣金
          </button>
          <button
            type="button"
            onClick={() => setSubTab('sales')}
            className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
              subTab === 'sales'
                ? 'bg-[#00A66C] text-white font-semibold'
                : 'text-[#5C6B64] dark:text-[#93A69D] hover:text-[#101815] dark:hover:text-[#EDF3F0]'
            }`}
          >
            销售明细
          </button>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            aria-label="按月份筛选"
            className="min-h-[44px] flex-1 sm:flex-initial px-3 py-2 rounded-xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] text-xs sm:text-sm font-medium text-[#101815] dark:text-[#EDF3F0] surface-card"
          >
            <option value="all">全部月份</option>
            {availableMonths.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={subTab === 'refs' ? handleExportRefsCsv : handleExportSalesCsv}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] text-xs sm:text-sm font-medium text-[#101815] dark:text-[#EDF3F0] hover:bg-[#F3F6F4] dark:hover:bg-[#1A2620] flex items-center gap-1.5 whitespace-nowrap surface-card"
          >
            <Download className="w-4 h-4" />
            <span>导出 CSV</span>
          </button>
        </div>
      </div>

      {/* Summary Strip */}
      <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 grid grid-cols-3 gap-3 tabular-nums surface-card">
        <div>
          <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">
            {monthFilter === 'all' ? '累计订单' : `${monthFilter} 订单`}
          </div>
          <div className="mt-0.5 text-lg sm:text-xl font-bold text-[#101815] dark:text-[#EDF3F0]">
            {salesLoading ? '…' : `${filteredSales.length} 笔`}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">实付收入</div>
          <div className="mt-0.5 text-lg sm:text-xl font-bold text-[#00704A] dark:text-[#4AD29E]">
            {salesLoading ? '…' : formatEur(totalFilteredRevenueCents)}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">应付佣金合计</div>
          <div className="mt-0.5 text-lg sm:text-xl font-bold text-[#101815] dark:text-[#EDF3F0]">
            {salesLoading ? '…' : formatEur(totalCommissionCents)}
          </div>
        </div>
      </div>

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

      {subTab === 'refs' ? (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <p className="text-xs text-[#5C6B64] dark:text-[#93A69D]">
              {monthFilter === 'all' ? '订单与佣金按全部时间统计' : `订单与佣金仅统计 ${monthFilter}`}
            </p>
            <div className="flex items-center gap-2">
              <select
                value={refSort}
                onChange={(e) => setRefSort(e.target.value as 'default' | 'revenue' | 'users' | 'commission')}
                aria-label="推荐人排序方式"
                className="min-h-[44px] px-3 py-2 rounded-xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] surface-card"
              >
                <option value="default">默认排序</option>
                <option value="revenue">按收入高→低</option>
                <option value="commission">按佣金高→低</option>
                <option value="users">按带来人数</option>
              </select>
              <button
                type="button"
                onClick={() => openAddForm()}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#00A66C] hover:bg-[#00704A] active:scale-[0.99] text-white text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all"
              >
                <Plus className="w-4 h-4" />
                <span>新增推荐人</span>
              </button>
            </div>
          </div>

          {createdRef && (
            <div className="bg-[#00A66C]/10 border border-[#00A66C]/30 rounded-2xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="text-sm font-semibold text-[#00704A] dark:text-[#4AD29E]">
                    推荐人「{createdRef.name}」已创建
                  </h4>
                  <p className="mt-1 text-xs font-mono text-[#101815] dark:text-[#EDF3F0] break-all">
                    {getRefLink(createdRef.code)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCreatedRef(null)}
                  className="text-xs text-[#5C6B64] dark:text-[#93A69D] hover:underline shrink-0"
                >
                  收起
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleCopy(createdRef.code)}
                  className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-white dark:bg-[#121B17] border border-[#00A66C]/30 text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>复制链接</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenPoster(createdRef.code, createdRef.name)}
                  className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#00A66C] text-white text-xs font-medium flex items-center gap-1.5"
                >
                  <QrCode className="w-3.5 h-3.5" />
                  <span>生成海报与二维码</span>
                </button>
              </div>
            </div>
          )}

          {(() => {
            const renderExpandedUsers = (code: string, label: string) => {
              const allForRef = users
                .filter((u) => (u.ref || '') === code)
                .sort((a, b) => b.last_seen - a.last_seen);
              const paidCount = allForRef.filter(isUserPaid).length;
              const visibleAll = expandedPaidOnly ? allForRef.filter(isUserPaid) : allForRef;
              const visible = visibleAll.slice(0, expandedLimit);

              return (
                <div
                  className="pt-3.5 mt-1 border-t border-[#EEF2F0] dark:border-[#1D2A23] space-y-2.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-[#101815] dark:text-[#EDF3F0]">
                      通过「{label}」进来的用户（{allForRef.length} 人
                      {paidCount > 0 ? ` · 付费 ${paidCount} 人` : ''}）
                    </div>
                    {allForRef.length > 0 && (
                      <div className="flex items-center gap-1 p-0.5 bg-[#F1F5F3] dark:bg-[#192620] rounded-lg">
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedPaidOnly(false);
                            setExpandedLimit(20);
                          }}
                          className={`min-h-[30px] px-2.5 text-[11px] font-medium rounded-md transition-colors ${
                            !expandedPaidOnly
                              ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs'
                              : 'text-[#5C6B64] dark:text-[#93A69D]'
                          }`}
                        >
                          全部 ({allForRef.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedPaidOnly(true);
                            setExpandedLimit(20);
                          }}
                          className={`min-h-[30px] px-2.5 text-[11px] font-medium rounded-md transition-colors ${
                            expandedPaidOnly
                              ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs'
                              : 'text-[#5C6B64] dark:text-[#93A69D]'
                          }`}
                        >
                          仅付费 ({paidCount})
                        </button>
                      </div>
                    )}
                  </div>

                  {visible.length === 0 ? (
                    <p className="py-5 text-center text-xs text-[#5C6B64] dark:text-[#93A69D] bg-[#F6F8F7] dark:bg-[#0D1511] rounded-xl">
                      {expandedPaidOnly ? '暂无通过该渠道付费的用户' : '暂无通过该渠道进来的用户'}
                    </p>
                  ) : (
                    <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23] rounded-xl bg-[#F6F8F7] dark:bg-[#0D1511] px-3">
                      {visible.map((u) => {
                        const paid = isUserPaid(u);
                        const seen = u.sum?.seen ?? 0;
                        const ok = u.sum?.ok ?? 0;
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => onSelectUser(u)}
                            className="w-full py-2.5 flex items-center justify-between gap-3 text-left hover:opacity-85 transition-opacity"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs sm:text-sm font-semibold text-[#101815] dark:text-[#EDF3F0] truncate">
                                  {getUserDisplayName(u)}
                                </span>
                                <span
                                  className={`text-[11px] font-semibold shrink-0 ${
                                    paid
                                      ? 'text-[#00704A] dark:text-[#4AD29E]'
                                      : !u.id.startsWith('v:')
                                        ? 'text-[#2F7CF6] dark:text-[#6CA6FF]'
                                        : 'text-[#5C6B64] dark:text-[#93A69D]'
                                  }`}
                                >
                                  {getUserIdentityLabel(u)}
                                </span>
                              </div>
                              <div className="mt-0.5 text-[11px] text-[#5C6B64] dark:text-[#93A69D] truncate tabular-nums">
                                {[
                                  u.city || u.country || '未知地区',
                                  getLevelLabel(u.level),
                                  `做过 ${seen} · 掌握 ${ok}`,
                                ].join(' · ')}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 text-[11px] text-[#5C6B64] dark:text-[#93A69D] shrink-0 tabular-nums">
                              <span>{formatRelativeTime(u.last_seen)}</span>
                              <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {visibleAll.length > expandedLimit && (
                    <div className="flex justify-center pt-1">
                      <button
                        type="button"
                        onClick={() => setExpandedLimit((prev) => prev + 20)}
                        className="min-h-[38px] px-4 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] border border-[#DCE4E0] dark:border-[#26362E] text-xs font-medium text-[#101815] dark:text-[#EDF3F0]"
                      >
                        显示更多（还有 {visibleAll.length - expandedLimit} 人）
                      </button>
                    </div>
                  )}
                </div>
              );
            };

            return (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {registeredRows.map(({ ref: r, totalUsers, paidUsers, active7d, orders, revenueCents, commissionCents }) => {
                  const isExpanded = expandedRefCode === r.code;
                  return (
                    <div
                      key={r.code}
                      onClick={() => toggleExpandedRef(r.code)}
                      className={`bg-white dark:bg-[#121B17] border rounded-2xl p-4 space-y-3 surface-card cursor-pointer transition-colors ${
                        isExpanded
                          ? 'lg:col-span-2 border-[#00A66C]/70'
                          : 'border-[#E2E8E5] dark:border-[#1F2D26] hover:border-[#00A66C]/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0] truncate">
                              {r.name}
                            </h3>
                            <span className="text-xs font-mono text-[#5C6B64] dark:text-[#93A69D] shrink-0">
                              {r.code} · {r.pct}%
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D] truncate">
                            {getRefLink(r.code)}
                          </p>
                        </div>
                        <div className="text-right shrink-0 tabular-nums">
                          <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">应付佣金</div>
                          <div className="text-base font-bold text-[#00704A] dark:text-[#4AD29E]">
                            {salesLoading ? '…' : formatEur(commissionCents)}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-2 pt-2.5 border-t border-[#EEF2F0] dark:border-[#1D2A23] text-xs tabular-nums">
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">带来</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {totalUsers}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">付费</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {paidUsers}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">7日活</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {active7d}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">订单/收入</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {salesLoading ? '…' : `${orders} / ${formatEur(revenueCents)}`}
                          </div>
                        </div>
                      </div>

                      <div
                        className="flex flex-wrap items-center gap-2 pt-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => toggleExpandedRef(r.code)}
                          className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1 transition-colors ${
                            isExpanded
                              ? 'bg-[#00A66C] text-white'
                              : 'bg-[#00A66C]/10 text-[#00704A] dark:text-[#4AD29E] hover:bg-[#00A66C]/18'
                          }`}
                        >
                          <Users className="w-3.5 h-3.5" />
                          <span>{isExpanded ? '收起用户' : `查看用户 (${totalUsers})`}</span>
                          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopy(r.code)}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] hover:bg-[#EAEFED] dark:hover:bg-[#22332B] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1 transition-colors"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          <span>复制</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenPoster(r.code, r.name)}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] hover:bg-[#EAEFED] dark:hover:bg-[#22332B] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1 transition-colors"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                          <span>海报</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditForm(r)}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] hover:bg-[#EAEFED] dark:hover:bg-[#22332B] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1 transition-colors"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>编辑</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingRef(r)}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-medium text-[#DC2626] dark:text-[#FCA5A5] hover:bg-[#DC2626]/10 flex items-center gap-1 ml-auto transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>移除</span>
                        </button>
                      </div>

                      {isExpanded && renderExpandedUsers(r.code, r.name)}
                    </div>
                  );
                })}

                {/* Direct from homepage */}
                {(() => {
                  const isExpanded = expandedRefCode === '';
                  return (
                    <div
                      onClick={() => toggleExpandedRef('')}
                      className={`bg-white dark:bg-[#121B17] border rounded-2xl p-4 space-y-3 surface-card cursor-pointer transition-colors ${
                        isExpanded
                          ? 'lg:col-span-2 border-[#00A66C]/70'
                          : 'border-[#E2E8E5] dark:border-[#1F2D26] hover:border-[#00A66C]/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            官网直接来的
                          </h3>
                          <p className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D]">
                            https://kaocivique.com/（无推荐码）
                          </p>
                        </div>
                        <div className="text-right shrink-0 tabular-nums">
                          <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">收入</div>
                          <div className="text-base font-bold text-[#00704A] dark:text-[#4AD29E]">
                            {salesLoading ? '…' : formatEur(directRow.revenueCents)}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 pt-2.5 border-t border-[#EEF2F0] dark:border-[#1D2A23] text-xs tabular-nums">
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">带来</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {directRow.totalUsers}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">付费</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {directRow.paidUsers}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">7日活</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {directRow.active7d}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">订单</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {salesLoading ? '…' : directRow.orders}
                          </div>
                        </div>
                      </div>
                      <div
                        className="flex flex-wrap items-center gap-2 pt-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => toggleExpandedRef('')}
                          className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1 transition-colors ${
                            isExpanded
                              ? 'bg-[#00A66C] text-white'
                              : 'bg-[#00A66C]/10 text-[#00704A] dark:text-[#4AD29E] hover:bg-[#00A66C]/18'
                          }`}
                        >
                          <Users className="w-3.5 h-3.5" />
                          <span>{isExpanded ? '收起用户' : `查看用户 (${directRow.totalUsers})`}</span>
                          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopy('')}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          <span>复制官网链接</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenPoster('', 'kaocivique 官网')}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                          <span>官网海报与二维码</span>
                        </button>
                      </div>

                      {isExpanded && renderExpandedUsers('', '官网直接')}
                    </div>
                  );
                })()}

                {/* Unregistered ref codes */}
                {unregisteredCodes.map((u) => {
                  const isExpanded = expandedRefCode === u.code;
                  return (
                    <div
                      key={u.code}
                      onClick={() => toggleExpandedRef(u.code)}
                      className={`bg-white dark:bg-[#121B17] border rounded-2xl p-4 space-y-3 surface-card cursor-pointer transition-colors ${
                        isExpanded
                          ? 'lg:col-span-2 border-[#00A66C]/70'
                          : 'border-[#E2E8E5] dark:border-[#1F2D26] hover:border-[#00A66C]/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-base font-semibold font-mono text-[#101815] dark:text-[#EDF3F0]">
                              {u.code}
                            </h3>
                            <span className="text-xs font-semibold text-[#D97706] dark:text-[#FBBF24]">
                              未登记
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D]">
                            不在推荐人名单中，但有访问或成交记录
                          </p>
                        </div>
                        <div className="text-right shrink-0 tabular-nums">
                          <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">收入</div>
                          <div className="text-base font-bold text-[#00704A] dark:text-[#4AD29E]">
                            {salesLoading ? '…' : formatEur(u.revenueCents)}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 pt-2.5 border-t border-[#EEF2F0] dark:border-[#1D2A23] text-xs tabular-nums">
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">带来</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {u.totalUsers}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">付费</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {u.paidUsers}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">7日活</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {u.active7d}
                          </div>
                        </div>
                        <div>
                          <div className="text-[#5C6B64] dark:text-[#93A69D]">订单</div>
                          <div className="mt-0.5 text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {salesLoading ? '…' : u.orders}
                          </div>
                        </div>
                      </div>
                      <div
                        className="flex flex-wrap items-center gap-2 pt-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => toggleExpandedRef(u.code)}
                          className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1 transition-colors ${
                            isExpanded
                              ? 'bg-[#00A66C] text-white'
                              : 'bg-[#00A66C]/10 text-[#00704A] dark:text-[#4AD29E] hover:bg-[#00A66C]/18'
                          }`}
                        >
                          <Users className="w-3.5 h-3.5" />
                          <span>{isExpanded ? '收起用户' : `查看用户 (${u.totalUsers})`}</span>
                          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => openAddForm(u.code)}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] text-xs font-medium text-[#101815] dark:text-[#EDF3F0]"
                        >
                          补录进推荐人名单
                        </button>
                      </div>

                      {isExpanded && renderExpandedUsers(u.code, u.code)}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      ) : (
        /* Sales tab */
        <div className="space-y-4">
          <div className="px-4 py-3 rounded-xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] text-xs text-[#5C6B64] dark:text-[#93A69D] surface-card">
            金额为顾客实付总额，未扣除 Stripe 手续费和退款；退款请在 Stripe 后台核对。
            {salesMore && '（当前仅列出最近 3000 笔订单，更早记录未显示。）'}
          </div>

          <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 surface-card">
            <h3 className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0] mb-3">
              按月汇总
            </h3>
            {salesLoading ? (
              <div className="h-14 rounded-xl bg-[#F1F5F3] dark:bg-[#192620] animate-pulse" />
            ) : monthlySummaries.length === 0 ? (
              <p className="text-sm text-[#5C6B64] dark:text-[#93A69D] py-4 text-center">暂无付款记录</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {monthlySummaries.map((m) => (
                  <div
                    key={m.month}
                    className="p-3.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0D1511] border border-[#EEF2F0] dark:border-[#1D2A23] flex items-center justify-between tabular-nums"
                  >
                    <div>
                      <div className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">{m.month}</div>
                      <div className="text-xs text-[#5C6B64] dark:text-[#93A69D]">{m.count} 笔订单</div>
                    </div>
                    <div className="text-base font-bold text-[#00704A] dark:text-[#4AD29E]">
                      {formatEur(m.cents)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 surface-card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                订单明细
              </h3>
              <span className="text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
                {filteredSales.length} 笔
              </span>
            </div>

            {salesLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="h-12 rounded-xl bg-[#F1F5F3] dark:bg-[#192620] animate-pulse" />
                ))}
              </div>
            ) : filteredSales.length === 0 ? (
              <p className="text-sm text-[#5C6B64] dark:text-[#93A69D] py-6 text-center">
                所选月份暂无订单
              </p>
            ) : (
              <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23]">
                {filteredSales.slice(0, salesLimit).map((s, idx) => {
                  const refLabel = s.ref
                    ? refNameMap.get(s.ref)
                      ? `${refNameMap.get(s.ref)} (${s.ref})`
                      : `${s.ref}（未登记）`
                    : '官网直接';
                  return (
                    <div key={`${s.t}-${idx}`} className="py-3 flex items-center justify-between gap-3">
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
                {filteredSales.length > salesLimit && (
                  <div className="pt-3 flex justify-center">
                    <button
                      type="button"
                      onClick={() => setSalesLimit((prev) => prev + 50)}
                      className="min-h-[44px] px-5 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] border border-[#DCE4E0] dark:border-[#26362E] text-xs font-semibold text-[#101815] dark:text-[#EDF3F0] hover:bg-[#EAEFED] dark:hover:bg-[#22332B]"
                    >
                      显示更多（还有 {filteredSales.length - salesLimit} 笔）
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Add / Edit Referrer Modal */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full sm:max-w-md bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-t-3xl sm:rounded-2xl p-5 pb-8 sm:pb-5 shadow-xl">
            <h3 className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0]">
              {editingCode ? `编辑推荐人 (${editingCode})` : '新增推荐人'}
            </h3>
            <form onSubmit={handleSaveRef} className="mt-4 space-y-3.5">
              {formError && (
                <div className="px-3 py-2 rounded-xl bg-[#DC2626]/10 text-xs text-[#B91C1C] dark:text-[#FCA5A5]">
                  {formError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-[#5C6B64] dark:text-[#93A69D] mb-1">
                  名字（必填）
                </label>
                <input
                  type="text"
                  maxLength={60}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="例如：小丽（朋友圈）"
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0]"
                />
              </div>

              {!editingCode && (
                <div>
                  <label className="block text-xs font-medium text-[#5C6B64] dark:text-[#93A69D] mb-1">
                    代号（可选，留空自动生成 5 位短码）
                  </label>
                  <input
                    type="text"
                    maxLength={40}
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value)}
                    placeholder="仅限字母、数字、下划线或短横线"
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm font-mono text-[#101815] dark:text-[#EDF3F0]"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-[#5C6B64] dark:text-[#93A69D] mb-1">
                  佣金比例（0–100%）
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={formPct}
                  onChange={(e) => setFormPct(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm tabular-nums text-[#101815] dark:text-[#EDF3F0]"
                />
              </div>

              <div className="pt-2 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button
                  type="button"
                  disabled={formSaving}
                  onClick={() => setFormOpen(false)}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-[#DCE4E0] dark:border-[#26362E] text-sm font-medium text-[#101815] dark:text-[#EDF3F0]"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={formSaving}
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-[#00A66C] hover:bg-[#00704A] text-white text-sm font-semibold disabled:opacity-60"
                >
                  {formSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deletingRef)}
        title="移除推荐人"
        description={`确定把「${deletingRef?.name || ''} (${deletingRef?.code || ''})」从名单移除吗？链接仍会生效，历史订单与用户也会继续保留并显示为“未登记”。`}
        confirmLabel="确认移除"
        danger
        loading={deleteLoading}
        onCancel={() => setDeletingRef(null)}
        onConfirm={handleDeleteRef}
      />
    </div>
  );
};
