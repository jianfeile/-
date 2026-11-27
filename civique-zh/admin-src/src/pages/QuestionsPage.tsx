import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Eye, Pencil, RefreshCw, RotateCcw, Search, X } from 'lucide-react';
import { adminRequest, ApiError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatErrorMessage, LEVEL_LABELS, THEME_MAP, THEMES } from '../constants';
import { ExamLevel, PatchData, Question, QuestionPatch, ThemeId } from '../types';

interface QuestionsPageProps {
  questions: Question[];
  freeIds: Set<string>;
  patches: QuestionPatch[];
  loading: boolean;
  error: string | null;
  onReloadBank: () => void;
  onRefreshPatches: () => Promise<void>;
  onToast: (msg: string) => void;
}

export const QuestionsPage: React.FC<QuestionsPageProps> = ({
  questions,
  freeIds,
  patches,
  loading,
  error,
  onReloadBank,
  onRefreshPatches,
  onToast,
}) => {
  const [query, setQuery] = useState('');
  const [themeFilter, setThemeFilter] = useState<ThemeId | 'all'>('all');
  const [levelFilter, setLevelFilter] = useState<ExamLevel | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<'all' | 'c' | 's'>('all');
  const [onlyPatched, setOnlyPatched] = useState(false);
  const [limit, setLimit] = useState(40);

  // Edit Drawer State
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mobileMode, setMobileMode] = useState<'edit' | 'preview'>('edit');
  const [draftQ, setDraftQ] = useState('');
  const [draftQz, setDraftQz] = useState('');
  const [draftO, setDraftO] = useState<[string, string, string, string]>(['', '', '', '']);
  const [draftOz, setDraftOz] = useState<[string, string, string, string]>(['', '', '', '']);
  const [draftE, setDraftE] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const patchMap = useMemo(() => {
    const m = new Map<string, QuestionPatch>();
    for (const p of patches) m.set(p.qid, p);
    return m;
  }, [patches]);

  const mergedQuestions = useMemo(() => {
    return questions.map((orig) => {
      const p = patchMap.get(orig.id);
      return {
        orig,
        merged: p ? ({ ...orig, ...p.data } as Question) : orig,
        patch: p || null,
        isFree: freeIds.has(orig.id),
      };
    });
  }, [questions, patchMap, freeIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mergedQuestions.filter(({ merged, patch }) => {
      if (onlyPatched && !patch) return false;
      if (themeFilter !== 'all' && merged.t !== themeFilter) return false;
      if (levelFilter !== 'all' && !merged.l.includes(levelFilter)) return false;
      if (kindFilter !== 'all' && merged.k !== kindFilter) return false;
      if (!q) return true;
      return (
        merged.id.toLowerCase() === q ||
        merged.id.toLowerCase().includes(q) ||
        merged.q.toLowerCase().includes(q) ||
        merged.qz.toLowerCase().includes(q)
      );
    });
  }, [mergedQuestions, query, themeFilter, levelFilter, kindFilter, onlyPatched]);

  useEffect(() => {
    setLimit(40);
  }, [query, themeFilter, levelFilter, kindFilter, onlyPatched]);

  const editingItem = useMemo(() => {
    if (!editingId) return null;
    return mergedQuestions.find((item) => item.orig.id === editingId) || null;
  }, [editingId, mergedQuestions]);

  useEffect(() => {
    if (!editingId || confirmRestore || saving) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditingId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingId, confirmRestore, saving]);

  const openEditor = (id: string) => {
    const item = mergedQuestions.find((x) => x.orig.id === id);
    if (!item) return;
    setEditingId(id);
    setMobileMode('edit');
    setDraftQ(item.merged.q);
    setDraftQz(item.merged.qz);
    setDraftO([...item.merged.o] as [string, string, string, string]);
    setDraftOz([...item.merged.oz] as [string, string, string, string]);
    setDraftE(item.merged.e);
    setEditError(null);
  };

  const frenchChanged = useMemo(() => {
    if (!editingItem) return false;
    if (draftQ.trim() !== editingItem.orig.q.trim()) return true;
    for (let i = 0; i < 4; i++) {
      if (draftO[i].trim() !== editingItem.orig.o[i].trim()) return true;
    }
    return false;
  }, [editingItem, draftQ, draftO]);

  const handleSavePatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;

    const q = draftQ.trim();
    const qz = draftQz.trim();
    const eText = draftE.trim();
    const o = draftO.map((x) => x.trim()) as [string, string, string, string];
    const oz = draftOz.map((x) => x.trim()) as [string, string, string, string];

    if (!q || !qz || !eText || o.some((x) => !x) || oz.some((x) => !x)) {
      setEditError('所有题干、选项和讲解文字均不能为空。');
      return;
    }
    if (q.length > 4000 || qz.length > 4000 || eText.length > 4000) {
      setEditError('题干或讲解不能超过 4000 字。');
      return;
    }
    if (o.some((x) => x.length > 600) || oz.some((x) => x.length > 600)) {
      setEditError('每个选项不能超过 600 字。');
      return;
    }

    const orig = editingItem.orig;
    const diff: PatchData = {};
    if (q !== orig.q) diff.q = q;
    if (qz !== orig.qz) diff.qz = qz;
    if (eText !== orig.e) diff.e = eText;
    if (o.some((val, idx) => val !== orig.o[idx])) diff.o = o;
    if (oz.some((val, idx) => val !== orig.oz[idx])) diff.oz = oz;

    if (Object.keys(diff).length === 0) {
      setEditError('当前内容与原题完全一致。如需撤回修改，请点击“恢复成原来的”。');
      return;
    }

    setSaving(true);
    setEditError(null);
    try {
      await adminRequest('patch-set', {
        qid: orig.id,
        free: editingItem.isFree,
        data: diff,
      });
      await onRefreshPatches();
      setEditingId(null);
      onToast('已保存修改，用户最多 1 分钟后看到新内容');
    } catch (err) {
      if (err instanceof ApiError) {
        setEditError(formatErrorMessage(err.code, { hasToken: true }));
      } else {
        setEditError('保存失败，请稍后再试。');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async () => {
    if (!editingItem) return;
    setSaving(true);
    try {
      await adminRequest('patch-del', { qid: editingItem.orig.id });
      await onRefreshPatches();
      setConfirmRestore(false);
      setEditingId(null);
      onToast('已恢复成原题内容');
    } catch (err) {
      if (err instanceof ApiError) {
        onToast(formatErrorMessage(err.code, { hasToken: true }));
      } else {
        onToast('恢复失败，请稍后再试');
      }
    } finally {
      setSaving(false);
    }
  };

  const optionLabels = ['A', 'B', 'C', 'D'];

  return (
    <div className="space-y-4 animate-view-enter">
      {/* Search & Filters */}
      <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-3.5 sm:p-4 space-y-3 surface-card">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-[#5C6B64] dark:text-[#93A69D] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜题号（如 P009）或中法文题干关键词"
              className="w-full min-h-[44px] pl-10 pr-3.5 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0] focus:outline-none focus:border-[#00A66C]"
            />
          </div>
          <button
            type="button"
            onClick={onReloadBank}
            disabled={loading}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-[#DCE4E0] dark:border-[#26362E] text-[#5C6B64] dark:text-[#93A69D] hover:bg-[#F1F5F3] dark:hover:bg-[#1A2620]"
            aria-label="重新加载题库"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <select
            value={themeFilter}
            onChange={(e) => setThemeFilter(e.target.value as ThemeId | 'all')}
            aria-label="按主题筛选"
            className="min-h-[40px] px-2.5 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-xs font-medium text-[#101815] dark:text-[#EDF3F0]"
          >
            <option value="all">全部主题</option>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>

          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as ExamLevel | 'all')}
            aria-label="按考试类型筛选"
            className="min-h-[40px] px-2.5 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-xs font-medium text-[#101815] dark:text-[#EDF3F0]"
          >
            <option value="all">全部考试类型</option>
            {(Object.keys(LEVEL_LABELS) as ExamLevel[]).map((lvl) => (
              <option key={lvl} value={lvl}>
                {LEVEL_LABELS[lvl]}
              </option>
            ))}
          </select>

          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as 'all' | 'c' | 's')}
            aria-label="按题型筛选"
            className="min-h-[40px] px-2.5 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-xs font-medium text-[#101815] dark:text-[#EDF3F0]"
          >
            <option value="all">知识题 + 情景题</option>
            <option value="c">知识题</option>
            <option value="s">情景题</option>
          </select>

          <button
            type="button"
            onClick={() => setOnlyPatched((v) => !v)}
            className={`min-h-[40px] px-3 py-1.5 rounded-xl border text-xs font-medium transition-colors whitespace-nowrap ${
              onlyPatched
                ? 'bg-[#00A66C] border-[#00A66C] text-white'
                : 'bg-[#F6F8F7] dark:bg-[#0B110E] border-[#DCE4E0] dark:border-[#26362E] text-[#101815] dark:text-[#EDF3F0]'
            }`}
          >
            只看改过的 ({patches.length})
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
          <span>
            匹配 {filtered.length} 道 · 共 {questions.length} 道
          </span>
          <span>已修改 {patches.length} 道</span>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-2xl bg-[#DC2626]/10 border border-[#DC2626]/25 flex items-center justify-between gap-3 text-sm text-[#B91C1C] dark:text-[#FCA5A5]">
          <span>{error}</span>
          <button
            type="button"
            onClick={onReloadBank}
            className="min-h-[38px] px-3 py-1 rounded-lg bg-white dark:bg-[#121B17] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] border border-[#DCE4E0] dark:border-[#26362E] whitespace-nowrap"
          >
            重试解密
          </button>
        </div>
      )}

      {/* Question Cards */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-28 rounded-2xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl py-12 text-center text-sm text-[#5C6B64] dark:text-[#93A69D] surface-card">
          没有匹配的题目
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {filtered.slice(0, limit).map(({ merged, patch, isFree }) => {
              const theme = THEME_MAP[merged.t];
              return (
                <button
                  key={merged.id}
                  type="button"
                  onClick={() => openEditor(merged.id)}
                  className="w-full text-left bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] hover:border-[#00A66C]/60 active:scale-[0.99] rounded-2xl p-4 transition-all surface-card"
                >
                  <div className="flex items-center justify-between gap-2 text-xs mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono font-bold text-[#101815] dark:text-[#EDF3F0]">
                        {merged.id}
                      </span>
                      <span className={`font-medium truncate ${theme?.textClass || ''}`}>
                        {theme?.shortLabel || merged.t}
                      </span>
                      <span className="text-[#5C6B64] dark:text-[#93A69D] shrink-0">
                        · {isFree ? '免费' : '付费'} · {merged.k === 's' ? '情景' : '知识'}
                      </span>
                    </div>
                    {patch && (
                      <span className="font-semibold text-[#D97706] dark:text-[#FBBF24] shrink-0">
                        已修改
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-[#101815] dark:text-[#EDF3F0] leading-snug line-clamp-2">
                    {merged.qz}
                  </p>
                  <p className="mt-1.5 text-xs text-[#5C6B64] dark:text-[#93A69D] leading-snug line-clamp-2">
                    {merged.q}
                  </p>
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
              加载更多（还有 {filtered.length - limit} 道）
            </button>
          )}
        </div>
      )}

      {/* Edit & Preview Drawer */}
      {editingItem && (
        <div
          className="fixed inset-0 z-40 bg-[#F4F7F5] dark:bg-[#090F0C] flex flex-col overflow-hidden"
          role="dialog"
          aria-modal="true"
        >
          {/* Top Bar */}
          <div className="shrink-0 bg-white dark:bg-[#121B17] border-b border-[#E2E8E5] dark:border-[#1F2D26] px-4 py-3 flex items-center justify-between gap-3 pt-safe">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center rounded-xl text-[#101815] dark:text-[#EDF3F0] hover:bg-[#F1F5F3] dark:hover:bg-[#1A2620]"
                aria-label="关闭编辑"
              >
                <X className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0] truncate">
                  编辑题目 {editingItem.orig.id}
                </h2>
                <p className="text-xs text-[#5C6B64] dark:text-[#93A69D] truncate">
                  {THEME_MAP[editingItem.orig.t]?.label} · {editingItem.isFree ? '免费题' : '付费题'}
                </p>
              </div>
            </div>

            <div className="flex lg:hidden items-center gap-1 p-1 bg-[#F1F5F3] dark:bg-[#192620] rounded-xl">
              <button
                type="button"
                onClick={() => setMobileMode('edit')}
                className={`min-h-[36px] px-3 py-1 text-xs font-medium rounded-lg flex items-center gap-1 ${
                  mobileMode === 'edit'
                    ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs'
                    : 'text-[#5C6B64] dark:text-[#93A69D]'
                }`}
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>编辑</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileMode('preview')}
                className={`min-h-[36px] px-3 py-1 text-xs font-medium rounded-lg flex items-center gap-1 ${
                  mobileMode === 'preview'
                    ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs'
                    : 'text-[#5C6B64] dark:text-[#93A69D]'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>预览</span>
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="max-w-6xl mx-auto p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-2 gap-5 pb-28">
              <form
                id="question-edit-form"
                onSubmit={handleSavePatch}
                className={`space-y-4 ${mobileMode === 'preview' ? 'hidden lg:block' : ''}`}
              >
                {editError && (
                  <div className="p-3 rounded-xl bg-[#DC2626]/10 border border-[#DC2626]/25 text-xs sm:text-sm text-[#B91C1C] dark:text-[#FCA5A5]">
                    {editError}
                  </div>
                )}

                {frenchChanged && (
                  <div className="p-3 rounded-xl bg-[#FFC933]/20 border border-[#FFC933]/45 flex items-start gap-2 text-xs text-[#734A00] dark:text-[#FFE082]">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      修改法语题干或法语选项后，原法语录音将对不上，网站会自动改用设备自带朗读。
                    </span>
                  </div>
                )}

                <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 space-y-3 surface-card">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="block text-xs font-medium text-[#5C6B64] dark:text-[#93A69D]">
                        中文题干
                      </label>
                      {draftQz.trim() !== editingItem.orig.qz.trim() && (
                        <button
                          type="button"
                          onClick={() => setDraftQz(editingItem.orig.qz)}
                          className="text-[11px] font-medium text-[#00704A] dark:text-[#4AD29E] hover:underline"
                        >
                          还原此项
                        </button>
                      )}
                    </div>
                    <textarea
                      rows={2}
                      maxLength={4000}
                      value={draftQz}
                      onChange={(e) => setDraftQz(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0]"
                    />
                    {draftQz.trim() !== editingItem.orig.qz.trim() && (
                      <p className="mt-1 text-[11px] text-[#5C6B64] dark:text-[#93A69D] leading-relaxed">
                        原题：{editingItem.orig.qz}
                      </p>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="block text-xs font-medium text-[#5C6B64] dark:text-[#93A69D]">
                        法语题干
                      </label>
                      {draftQ.trim() !== editingItem.orig.q.trim() && (
                        <button
                          type="button"
                          onClick={() => setDraftQ(editingItem.orig.q)}
                          className="text-[11px] font-medium text-[#00704A] dark:text-[#4AD29E] hover:underline"
                        >
                          还原此项
                        </button>
                      )}
                    </div>
                    <textarea
                      rows={3}
                      maxLength={4000}
                      value={draftQ}
                      onChange={(e) => setDraftQ(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0]"
                    />
                    {draftQ.trim() !== editingItem.orig.q.trim() && (
                      <p className="mt-1 text-[11px] text-[#5C6B64] dark:text-[#93A69D] leading-relaxed">
                        原题：{editingItem.orig.q}
                      </p>
                    )}
                  </div>
                </div>

                <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 space-y-4 surface-card">
                  <div className="text-xs font-semibold text-[#00704A] dark:text-[#4AD29E]">
                    选项 A 永远是正确答案，请勿通过调换选项顺序来改答案
                  </div>
                  {[0, 1, 2, 3].map((idx) => {
                    const frDiff = draftO[idx].trim() !== editingItem.orig.o[idx].trim();
                    const zhDiff = draftOz[idx].trim() !== editingItem.orig.oz[idx].trim();
                    return (
                      <div
                        key={idx}
                        className="space-y-2 pb-3 border-b border-[#EEF2F0] dark:border-[#1D2A23] last:border-b-0 last:pb-0"
                      >
                        <div className="flex items-center justify-between text-xs font-semibold">
                          <span className={idx === 0 ? 'text-[#00704A] dark:text-[#4AD29E]' : 'text-[#101815] dark:text-[#EDF3F0]'}>
                            选项 {optionLabels[idx]}
                            {idx === 0 ? '（正确答案）' : ''}
                          </span>
                          {(frDiff || zhDiff) && (
                            <button
                              type="button"
                              onClick={() => {
                                const nextO = [...draftO] as [string, string, string, string];
                                const nextOz = [...draftOz] as [string, string, string, string];
                                nextO[idx] = editingItem.orig.o[idx];
                                nextOz[idx] = editingItem.orig.oz[idx];
                                setDraftO(nextO);
                                setDraftOz(nextOz);
                              }}
                              className="text-[11px] font-medium text-[#00704A] dark:text-[#4AD29E] hover:underline"
                            >
                              还原此选项
                            </button>
                          )}
                        </div>
                        <input
                          type="text"
                          maxLength={600}
                          value={draftO[idx]}
                          onChange={(e) => {
                            const next = [...draftO] as [string, string, string, string];
                            next[idx] = e.target.value;
                            setDraftO(next);
                          }}
                          placeholder={`法语选项 ${optionLabels[idx]}`}
                          className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0]"
                        />
                        {frDiff && (
                          <p className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">
                            原法语：{editingItem.orig.o[idx]}
                          </p>
                        )}
                        <input
                          type="text"
                          maxLength={600}
                          value={draftOz[idx]}
                          onChange={(e) => {
                            const next = [...draftOz] as [string, string, string, string];
                            next[idx] = e.target.value;
                            setDraftOz(next);
                          }}
                          placeholder={`中文选项 ${optionLabels[idx]}`}
                          className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0]"
                        />
                        {zhDiff && (
                          <p className="text-[11px] text-[#5C6B64] dark:text-[#93A69D]">
                            原中文：{editingItem.orig.oz[idx]}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 surface-card">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="block text-xs font-medium text-[#5C6B64] dark:text-[#93A69D]">
                      中文讲解
                    </label>
                    {draftE.trim() !== editingItem.orig.e.trim() && (
                      <button
                        type="button"
                        onClick={() => setDraftE(editingItem.orig.e)}
                        className="text-[11px] font-medium text-[#00704A] dark:text-[#4AD29E] hover:underline"
                      >
                        还原此项
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={4}
                    maxLength={4000}
                    value={draftE}
                    onChange={(e) => setDraftE(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0]"
                  />
                  {draftE.trim() !== editingItem.orig.e.trim() && (
                    <p className="mt-1.5 text-[11px] text-[#5C6B64] dark:text-[#93A69D] leading-relaxed whitespace-pre-wrap">
                      原讲解：{editingItem.orig.e}
                    </p>
                  )}
                </div>
              </form>

              <div className={`${mobileMode === 'edit' ? 'hidden lg:block' : ''}`}>
                <div className="lg:sticky lg:top-4 bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-5 space-y-4 surface-card">
                  <div className="flex items-center justify-between text-xs text-[#5C6B64] dark:text-[#93A69D]">
                    <span className="font-semibold text-[#101815] dark:text-[#EDF3F0]">
                      用户看到的样子（实时预览）
                    </span>
                    <span className="font-mono">{editingItem.orig.id}</span>
                  </div>

                  <div className="space-y-2">
                    <p className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0] leading-relaxed">
                      {draftQ || '（法语题干）'}
                    </p>
                    <p className="text-sm text-[#5C6B64] dark:text-[#93A69D] leading-relaxed">
                      {draftQz || '（中文题干）'}
                    </p>
                  </div>

                  <div className="space-y-2">
                    {[0, 1, 2, 3].map((idx) => (
                      <div
                        key={idx}
                        className={`p-3 rounded-xl border text-sm ${
                          idx === 0
                            ? 'bg-[#00A66C]/10 border-[#00A66C]/45'
                            : 'bg-[#F6F8F7] dark:bg-[#0B110E] border-[#DCE4E0] dark:border-[#26362E]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-[#101815] dark:text-[#EDF3F0]">
                            {optionLabels[idx]}. {draftO[idx] || '—'}
                          </span>
                          {idx === 0 && (
                            <span className="text-[11px] font-semibold text-[#00704A] dark:text-[#4AD29E] shrink-0">
                              正确答案
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D]">
                          {draftOz[idx] || '—'}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="p-3.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#EEF2F0] dark:border-[#1D2A23]">
                    <div className="text-xs font-semibold text-[#101815] dark:text-[#EDF3F0] mb-1">
                      解析
                    </div>
                    <p className="text-xs sm:text-sm text-[#5C6B64] dark:text-[#93A69D] leading-relaxed whitespace-pre-wrap">
                      {draftE || '（暂无讲解）'}
                    </p>
                  </div>

                  {editingItem.orig.v && editingItem.orig.v.length > 0 && (
                    <div className="pt-2 border-t border-[#EEF2F0] dark:border-[#1D2A23]">
                      <div className="text-xs font-semibold text-[#5C6B64] dark:text-[#93A69D] mb-1.5">
                        生词（只读）
                      </div>
                      <div className="space-y-1 text-xs text-[#5C6B64] dark:text-[#93A69D]">
                        {editingItem.orig.v.map(([fr, zh], i) => (
                          <div key={i}>
                            <span className="font-medium text-[#101815] dark:text-[#EDF3F0]">{fr}</span>：{zh}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="shrink-0 bg-white dark:bg-[#121B17] border-t border-[#E2E8E5] dark:border-[#1F2D26] px-4 py-3 pb-safe">
            <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
              {editingItem.patch ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setConfirmRestore(true)}
                  className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#DCE4E0] dark:border-[#26362E] text-xs sm:text-sm font-medium text-[#101815] dark:text-[#EDF3F0] hover:bg-[#F1F5F3] dark:hover:bg-[#1A2620] flex items-center gap-1.5 whitespace-nowrap"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>恢复成原来的</span>
                </button>
              ) : (
                <span className="text-xs text-[#5C6B64] dark:text-[#93A69D]">
                  仅保存改动过的字段
                </span>
              )}

              <button
                type="submit"
                form="question-edit-form"
                disabled={saving}
                className="min-h-[44px] px-6 py-2 rounded-xl bg-[#00A66C] hover:bg-[#00704A] text-white text-sm font-semibold whitespace-nowrap disabled:opacity-60"
              >
                {saving ? '保存中…' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRestore}
        title="恢复成原题"
        description={`确定把题目 ${editingItem?.orig.id || ''} 恢复成修改前的样子吗？之前的修改内容将被清除。`}
        confirmLabel="确认恢复"
        danger
        loading={saving}
        onCancel={() => setConfirmRestore(false)}
        onConfirm={handleRestore}
      />
    </div>
  );
};
