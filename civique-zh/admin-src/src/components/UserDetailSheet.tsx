import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Copy, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { adminRequest, ApiError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatErrorMessage, THEMES } from '../constants';
import { ExamLevel, Question, QuestionPatch, RefItem, User, UserDetailResponse } from '../types';
import {
  copyText,
  formatDuration,
  formatParisDateTime,
  formatRelativeTime,
  getExamCountdown,
  getLevelLabel,
  getUserDisplayName,
  getUserIdentityLabel,
  isUserPaid,
  parseUserAgent,
} from '../utils/format';

interface UserDetailSheetProps {
  user: User;
  refs: RefItem[];
  questions: Question[];
  patches: QuestionPatch[];
  questionsLoading: boolean;
  onEnsureQuestions: () => void;
  onClose: () => void;
  onUserDeleted: (userId: string) => void;
  onToast: (msg: string) => void;
}

export const UserDetailSheet: React.FC<UserDetailSheetProps> = ({
  user,
  refs,
  questions,
  patches,
  questionsLoading,
  onEnsureQuestions,
  onClose,
  onUserDeleted,
  onToast,
}) => {
  const [detail, setDetail] = useState<UserDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'reset-devices' | 'delete-user' | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [expandedQid, setExpandedQid] = useState<string | null>(null);

  const fetchDetail = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await adminRequest<UserDetailResponse>('user', { id: user.id });
      setDetail(resp);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(formatErrorMessage(err.code, { hasToken: true }));
      } else {
        setError('读取用户详情失败。');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetail();
    onEnsureQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmAction && !actionLoading) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmAction, actionLoading, onClose]);

  const activeUser = detail?.user || user;
  const paid = isUserPaid(activeUser);
  const identity = getUserIdentityLabel(activeUser);
  const refName = useMemo(() => {
    if (!activeUser.ref) return '官网直接';
    const found = refs.find((r) => r.code === activeUser.ref);
    return found ? `${found.name} (${found.code})` : `${activeUser.ref}（未登记）`;
  }, [activeUser.ref, refs]);

  const patchedQuestionMap = useMemo(() => {
    const patchMap = new Map<string, QuestionPatch>();
    for (const p of patches) patchMap.set(p.qid, p);
    const map = new Map<string, Question>();
    for (const q of questions) {
      const p = patchMap.get(q.id);
      map.set(q.id, p ? { ...q, ...p.data } : q);
    }
    return map;
  }, [questions, patches]);

  const themeProgress = useMemo(() => {
    const stats = detail?.user.state?.stats || {};
    const lvl = activeUser.level as ExamLevel | '';
    return THEMES.map((theme) => {
      const applicable = questions.filter(
        (q) => q.t === theme.id && (!lvl || q.l.includes(lvl)),
      );
      let okCount = 0;
      for (const q of applicable) {
        if (stats[q.id]?.[2] === 1) okCount++;
      }
      const total = applicable.length;
      const pct = total > 0 ? Math.round((okCount / total) * 100) : 0;
      return {
        theme,
        ok: okCount,
        total,
        pct,
      };
    });
  }, [detail, questions, activeUser.level]);

  const weakQuestions = useMemo(() => {
    const stats = detail?.user.state?.stats;
    if (!stats) return [];
    const list: Array<{
      qid: string;
      wrongCount: number;
      attempts: number;
      inMistakeBook: boolean;
      q?: Question;
    }> = [];

    for (const [qid, arr] of Object.entries(stats)) {
      const [attempts, correct, , remaining] = arr;
      const wrongCount = attempts - correct;
      if (wrongCount > 0) {
        list.push({
          qid,
          wrongCount,
          attempts,
          inMistakeBook: remaining > 0,
          q: patchedQuestionMap.get(qid),
        });
      }
    }

    list.sort((a, b) => {
      if (a.inMistakeBook !== b.inMistakeBook) return a.inMistakeBook ? -1 : 1;
      return b.wrongCount - a.wrongCount;
    });

    return list.slice(0, 40);
  }, [detail, patchedQuestionMap]);

  const dailyStudyRows = useMemo(() => {
    const daysObj = detail?.user.state?.days || {};
    return Object.entries(daysObj).sort((a, b) => b[0].localeCompare(a[0]));
  }, [detail]);

  const handleConfirm = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    try {
      if (confirmAction === 'reset-devices') {
        const code = activeUser.id.slice(2);
        await adminRequest('code-reset', { code });
        onToast('已清空该解锁码绑定的设备');
        setConfirmAction(null);
        await fetchDetail();
      } else if (confirmAction === 'delete-user') {
        await adminRequest('user-del', { id: activeUser.id });
        onToast('用户记录已删除');
        setConfirmAction(null);
        onUserDeleted(activeUser.id);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        onToast(formatErrorMessage(err.code, { hasToken: true, context: 'code' }));
      } else {
        onToast('操作失败，请稍后再试');
      }
    } finally {
      setActionLoading(false);
    }
  };

  const countdown = getExamCountdown(activeUser.exam_date);
  const seen = activeUser.sum?.seen ?? 0;
  const ok = activeUser.sum?.ok ?? 0;
  const pool = activeUser.sum?.pool ?? 0;
  const masteryPct = pool > 0 ? Math.min(100, Math.round((ok / pool) * 100)) : 0;
  const ringRadius = 26;
  const ringCirc = 2 * Math.PI * ringRadius;
  const ringOffset = ringCirc * (1 - masteryPct / 100);

  return (
    <div
      className="fixed inset-0 z-40 bg-[#F4F7F5] dark:bg-[#090F0C] lg:bg-black/45 lg:backdrop-blur-xs flex justify-end"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full lg:max-w-2xl h-full bg-[#F4F7F5] dark:bg-[#090F0C] lg:border-l border-[#E2E8E5] dark:border-[#1F2D26] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 bg-white dark:bg-[#121B17] border-b border-[#E2E8E5] dark:border-[#1F2D26] px-4 py-3 flex items-center justify-between gap-3 pt-safe">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center rounded-xl text-[#101815] dark:text-[#EDF3F0] hover:bg-[#F1F5F3] dark:hover:bg-[#1A2620]"
              aria-label="返回"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0] truncate">
                {getUserDisplayName(activeUser)}
              </h2>
              <p className="text-xs text-[#5C6B64] dark:text-[#93A69D] truncate tabular-nums">
                {identity} · {activeUser.id}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={fetchDetail}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[#5C6B64] hover:bg-[#F1F5F3] dark:hover:bg-[#1A2620]"
            aria-label="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 pb-12">
          {error && (
            <div className="p-4 rounded-2xl bg-[#DC2626]/10 border border-[#DC2626]/25 text-sm text-[#B91C1C] dark:text-[#FCA5A5]">
              {error}
            </div>
          )}

          {/* Hero Progress Ring + Quick Metrics */}
          <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
            <div className="flex items-center gap-4">
              <div className="relative w-16 h-16 shrink-0">
                <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
                  <circle
                    cx="32"
                    cy="32"
                    r={ringRadius}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="6"
                    className="text-[#EEF2F0] dark:text-[#1D2B24]"
                  />
                  <circle
                    cx="32"
                    cy="32"
                    r={ringRadius}
                    fill="none"
                    stroke="#00A66C"
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeDasharray={ringCirc}
                    strokeDashoffset={ringOffset}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center text-xs font-bold tabular-nums text-[#101815] dark:text-[#EDF3F0]">
                  {masteryPct}%
                </div>
              </div>

              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0] tabular-nums">
                  已掌握 {ok} / {pool || '—'} 题
                </div>
                <div className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
                  {getLevelLabel(activeUser.level)}
                  {activeUser.exam_date ? ` · 考期 ${activeUser.exam_date}` : ''}
                  {countdown ? ` · ${countdown}` : ''}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3.5 border-t border-[#EEF2F0] dark:border-[#1D2A23] grid grid-cols-3 gap-2 text-center tabular-nums">
              <div>
                <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">累计做过</div>
                <div className="mt-0.5 text-base font-bold text-[#101815] dark:text-[#EDF3F0]">
                  {seen} 题
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">错题本</div>
                <div className="mt-0.5 text-base font-bold text-[#DC2626] dark:text-[#FCA5A5]">
                  {activeUser.sum?.miss ?? 0} 题
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">模考最好</div>
                <div className="mt-0.5 text-base font-bold text-[#00704A] dark:text-[#4AD29E]">
                  {activeUser.sum?.exams ? `${activeUser.sum.best}/${activeUser.sum.bestN}` : '—'}
                </div>
              </div>
            </div>
          </section>

          {/* Basic Info */}
          <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
            <h3 className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0] mb-3">
              基本资料
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:text-sm">
              <div>
                <dt className="text-[#5C6B64] dark:text-[#93A69D]">身份</dt>
                <dd className={`mt-0.5 font-medium ${paid ? 'text-[#00704A] dark:text-[#4AD29E]' : 'text-[#101815] dark:text-[#EDF3F0]'}`}>
                  {identity}
                </dd>
              </div>
              <div>
                <dt className="text-[#5C6B64] dark:text-[#93A69D]">推荐来源</dt>
                <dd
                  className={`mt-0.5 font-medium truncate ${
                    activeUser.ref
                      ? 'text-[#00704A] dark:text-[#4AD29E]'
                      : 'text-[#101815] dark:text-[#EDF3F0]'
                  }`}
                >
                  {refName}
                </dd>
              </div>
              {activeUser.login && (
                <div>
                  <dt className="text-[#5C6B64] dark:text-[#93A69D]">填报账号</dt>
                  <dd className="mt-0.5 font-medium text-[#101815] dark:text-[#EDF3F0] truncate">
                    {activeUser.login}
                  </dd>
                </div>
              )}
              {activeUser.email && (
                <div>
                  <dt className="text-[#5C6B64] dark:text-[#93A69D]">付款邮箱</dt>
                  <dd className="mt-0.5 font-medium text-[#101815] dark:text-[#EDF3F0] truncate">
                    {activeUser.email}
                  </dd>
                </div>
              )}
              {paid && (
                <div>
                  <dt className="text-[#5C6B64] dark:text-[#93A69D]">付款时间</dt>
                  <dd className="mt-0.5 font-medium tabular-nums text-[#101815] dark:text-[#EDF3F0]">
                    {formatParisDateTime(activeUser.paid_at)}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[#5C6B64] dark:text-[#93A69D]">地点</dt>
                <dd className="mt-0.5 font-medium text-[#101815] dark:text-[#EDF3F0]">
                  {[activeUser.city, activeUser.country].filter(Boolean).join(', ') || '未知'}
                </dd>
              </div>
              <div>
                <dt className="text-[#5C6B64] dark:text-[#93A69D]">设备环境</dt>
                <dd className="mt-0.5 font-medium text-[#101815] dark:text-[#EDF3F0]">
                  {parseUserAgent(activeUser.ua)}
                </dd>
              </div>
              <div>
                <dt className="text-[#5C6B64] dark:text-[#93A69D]">使用天数</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-[#101815] dark:text-[#EDF3F0]">
                  {activeUser.days} 天
                </dd>
              </div>
              <div>
                <dt className="text-[#5C6B64] dark:text-[#93A69D]">首次来访</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-[#101815] dark:text-[#EDF3F0]">
                  {formatParisDateTime(activeUser.created)}
                </dd>
              </div>
              <div>
                <dt className="text-[#5C6B64] dark:text-[#93A69D]">最近使用</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-[#101815] dark:text-[#EDF3F0]">
                  {formatRelativeTime(activeUser.last_seen)}
                </dd>
              </div>
            </dl>

            {/* Paid Device Limit & Reset */}
            {activeUser.id.startsWith('b:') && detail && (
              <div className="mt-4 pt-3.5 border-t border-[#EEF2F0] dark:border-[#1D2A23] flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex items-center gap-2 text-xs sm:text-sm">
                  <Smartphone className="w-4 h-4 text-[#5C6B64] dark:text-[#93A69D]" />
                  <span className="text-[#101815] dark:text-[#EDF3F0] tabular-nums">
                    已解锁设备：<strong>{detail.devices}</strong> / {detail.limit} 台
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const rawCode = activeUser.id.slice(2);
                      const formatted = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
                      const copied = await copyText(formatted);
                      onToast(copied ? `已复制解锁码 ${formatted}` : '复制失败');
                    }}
                    className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1 whitespace-nowrap"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>复制解锁码</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAction('reset-devices')}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-[#DCE4E0] dark:border-[#26362E] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] hover:bg-[#F1F5F3] dark:hover:bg-[#1A2620] whitespace-nowrap"
                  >
                    清空设备
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* 5 Themes Mastery */}
          <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
            <div className="flex items-center justify-between mb-3.5">
              <h3 className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                五大主题掌握情况
              </h3>
              <span className="text-xs text-[#5C6B64] dark:text-[#93A69D]">
                {activeUser.level ? `适用 ${getLevelLabel(activeUser.level)}` : '全部题库'}
              </span>
            </div>

            {questionsLoading ? (
              <p className="text-xs text-[#5C6B64] dark:text-[#93A69D] py-3">正在加载题库以计算掌握度…</p>
            ) : (
              <div className="space-y-3">
                {themeProgress.map(({ theme, ok: themeOk, total, pct }) => (
                  <div key={theme.id}>
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="font-medium text-[#101815] dark:text-[#EDF3F0]">{theme.label}</span>
                      <span className="tabular-nums text-[#5C6B64] dark:text-[#93A69D]">
                        {themeOk} / {total}（{pct}%）
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[#EEF2F0] dark:bg-[#1B2721] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{ width: `${pct}%`, backgroundColor: theme.color }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Weak Questions */}
          <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0]">
                没学明白的题
              </h3>
              <span className="text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
                最多显示 40 道
              </span>
            </div>

            {loading ? (
              <div className="h-16 rounded-xl bg-[#F1F5F3] dark:bg-[#192620] animate-pulse" />
            ) : weakQuestions.length === 0 ? (
              <p className="text-sm text-[#5C6B64] dark:text-[#93A69D] py-4 text-center">
                暂无答错记录
              </p>
            ) : (
              <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23]">
                {weakQuestions.map((item) => {
                  const isExpanded = expandedQid === item.qid;
                  return (
                    <div key={item.qid} className="py-3 first:pt-0 last:pb-0">
                      <button
                        type="button"
                        onClick={() => setExpandedQid(isExpanded ? null : item.qid)}
                        className="w-full text-left"
                      >
                        <div className="flex items-center justify-between gap-2 text-xs mb-1">
                          <span className="font-mono font-semibold text-[#101815] dark:text-[#EDF3F0]">
                            {item.qid}
                          </span>
                          <span className="tabular-nums text-[#B91C1C] dark:text-[#FCA5A5]">
                            错 {item.wrongCount} 次 · 共做 {item.attempts} 次
                            {item.inMistakeBook ? ' · 仍在错题本' : ''}
                          </span>
                        </div>
                        {item.q ? (
                          <>
                            <p className="text-sm text-[#101815] dark:text-[#EDF3F0] leading-snug">
                              {item.q.qz}
                            </p>
                            <p className="mt-1 text-xs text-[#5C6B64] dark:text-[#93A69D] leading-snug">
                              {item.q.q}
                            </p>
                          </>
                        ) : (
                          <p className="text-xs text-[#5C6B64] dark:text-[#93A69D]">
                            （未在当前已加载题库中找到题干文字）
                          </p>
                        )}
                      </button>

                      {isExpanded && item.q && (
                        <div className="mt-2.5 p-3 rounded-xl bg-[#F6F8F7] dark:bg-[#0D1511] border border-[#E2E8E5] dark:border-[#1F2D26] space-y-1.5 text-xs">
                          <div className="font-semibold text-[#00704A] dark:text-[#4AD29E]">
                            正确答案：{item.q.o[0]}（{item.q.oz[0]}）
                          </div>
                          <p className="text-[#5C6B64] dark:text-[#93A69D] leading-relaxed">
                            {item.q.e}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Mock Exam Records */}
          <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
            <h3 className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0] mb-3">
              模考记录
            </h3>
            {loading ? (
              <div className="h-14 rounded-xl bg-[#F1F5F3] dark:bg-[#192620] animate-pulse" />
            ) : !detail?.user.state?.exams?.length ? (
              <p className="text-sm text-[#5C6B64] dark:text-[#93A69D] py-4 text-center">
                暂无模考记录
              </p>
            ) : (
              <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23]">
                {detail.user.state.exams.map((ex, i) => {
                  const passed = ex.score >= ex.passAt;
                  return (
                    <div key={`${ex.ts}-${i}`} className="py-2.5 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-[#101815] dark:text-[#EDF3F0]">
                          {ex.mini ? '10题试考' : '40题模考'} · {getLevelLabel(ex.target)}
                        </div>
                        <div className="text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
                          {formatParisDateTime(ex.ts)} · 用时 {formatDuration(ex.secs)}
                        </div>
                      </div>
                      <div className="text-right tabular-nums shrink-0">
                        <div
                          className={`text-sm font-bold ${
                            passed ? 'text-[#00704A] dark:text-[#4AD29E]' : 'text-[#DC2626] dark:text-[#FCA5A5]'
                          }`}
                        >
                          {ex.score} / {ex.n}
                        </div>
                        <div className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">
                          {passed ? '通过' : `未及格 (及格线 ${ex.passAt})`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Daily Practice Count */}
          <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
            <h3 className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0] mb-3">
              每日做题记录
            </h3>
            {dailyStudyRows.length === 0 ? (
              <p className="text-sm text-[#5C6B64] dark:text-[#93A69D] py-3 text-center">
                暂无每日做题数据
              </p>
            ) : (
              <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23]">
                {dailyStudyRows.map(([day, [done, mastered]]) => (
                  <div key={day} className="py-2 flex items-center justify-between text-xs sm:text-sm tabular-nums">
                    <span className="font-medium text-[#101815] dark:text-[#EDF3F0]">{day}</span>
                    <span className="text-[#5C6B64] dark:text-[#93A69D]">
                      做题 {done} 道 · 新掌握 {mastered} 道
                    </span>
                  </div>
                ))}
              </div>
            )}

            {detail && detail.days.length > 0 && (
              <div className="mt-4 pt-3 border-t border-[#EEF2F0] dark:border-[#1D2A23]">
                <p className="text-xs text-[#5C6B64] dark:text-[#93A69D] mb-2">
                  活跃日期（数字为当日向服务器报告次数，非做题数）：
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-[#5C6B64] dark:text-[#93A69D]">
                  {detail.days.slice(0, 14).map((d) => (
                    <span key={d.day}>
                      {d.day} ({d.n}次)
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Danger Zone */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setConfirmAction('delete-user')}
              className="w-full min-h-[48px] flex items-center justify-center gap-2 rounded-2xl border border-[#DC2626]/35 text-[#DC2626] dark:text-[#FCA5A5] bg-[#DC2626]/5 hover:bg-[#DC2626]/10 text-sm font-semibold transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              <span>删除这个人的记录</span>
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmAction === 'reset-devices'}
        title="清空已绑定设备"
        description="清空后，该付费用户可以在新手机上重新激活此解锁码。确认继续吗？"
        confirmLabel="确认清空"
        loading={actionLoading}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleConfirm}
      />

      <ConfirmDialog
        open={confirmAction === 'delete-user'}
        title="删除用户记录"
        description={`确定要删除「${getUserDisplayName(activeUser)}」的学习和访问记录吗？此操作不可撤销；如果对方继续使用网站，将会重新生成一条访客记录。`}
        confirmLabel="确认删除"
        danger
        loading={actionLoading}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleConfirm}
      />
    </div>
  );
};
