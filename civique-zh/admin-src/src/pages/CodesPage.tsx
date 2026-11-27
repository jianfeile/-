import React, { useEffect, useMemo, useState } from 'react';
import { Ban, Copy, Plus, RotateCcw, Search } from 'lucide-react';
import { adminRequest, ApiError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatErrorMessage } from '../constants';
import { CodeItem } from '../types';
import { copyText, formatParisDateTime } from '../utils/format';

interface CodesPageProps {
  codes: CodeItem[];
  loading: boolean;
  onRefreshCodes: () => Promise<void>;
  onToast: (msg: string) => void;
}

export const CodesPage: React.FC<CodesPageProps> = ({
  codes,
  loading,
  onRefreshCodes,
  onToast,
}) => {
  const [count, setCount] = useState('1');
  const [note, setNote] = useState('');
  const [generating, setGenerating] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[]>([]);

  const [manualRevokeCode, setManualRevokeCode] = useState('');
  const [filter, setFilter] = useState<'all' | 'unused' | 'used' | 'revoked'>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(40);

  useEffect(() => {
    setLimit(40);
  }, [filter, query]);

  const [confirmState, setConfirmState] = useState<{
    type: 'reset' | 'revoke';
    code: string;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      onToast('生成数量请填 1 到 50 的整数');
      return;
    }
    setGenerating(true);
    try {
      const resp = await adminRequest<{ ok: true; codes: string[] }>('code-new', {
        n,
        note: note.trim() || undefined,
      });
      setFreshCodes(resp.codes);
      setNote('');
      await onRefreshCodes();
      onToast(`已生成 ${resp.codes.length} 个解锁码`);
    } catch (err) {
      if (err instanceof ApiError) {
        onToast(formatErrorMessage(err.code, { hasToken: true, context: 'code' }));
      } else {
        onToast('生成失败，请稍后再试');
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyAllFresh = async () => {
    const ok = await copyText(freshCodes.join('\n'));
    onToast(ok ? '全部新解锁码已复制' : '复制失败，请手动复制');
  };

  const handleCopyOne = async (c: string) => {
    const ok = await copyText(c);
    onToast(ok ? `已复制 ${c}` : '复制失败');
  };

  const handleConfirmAction = async () => {
    if (!confirmState) return;
    setActionLoading(true);
    try {
      if (confirmState.type === 'reset') {
        await adminRequest('code-reset', { code: confirmState.code });
        onToast('已清空该解锁码绑定的设备');
      } else {
        await adminRequest('code-del', { code: confirmState.code });
        onToast('解锁码已作废');
        setManualRevokeCode('');
        await onRefreshCodes();
      }
      setConfirmState(null);
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

  const filteredCodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return codes.filter((c) => {
      if (filter === 'unused' && (c.revoked || Boolean(c.used_by))) return false;
      if (filter === 'used' && (c.revoked || !c.used_by)) return false;
      if (filter === 'revoked' && !c.revoked) return false;
      if (!q) return true;
      return (
        c.code.toLowerCase().includes(q) ||
        (c.note || '').toLowerCase().includes(q)
      );
    });
  }, [codes, filter, query]);

  return (
    <div className="space-y-4 animate-view-enter">
      {/* Device limit notice */}
      <div className="px-4 py-3 rounded-xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] text-xs text-[#5C6B64] dark:text-[#93A69D] surface-card">
        说明：后台生成的解锁码仅限 <strong className="text-[#101815] dark:text-[#EDF3F0]">1 台设备</strong> 使用；用户付款后自动发放的解锁码最多支持{' '}
        <strong className="text-[#101815] dark:text-[#EDF3F0]">5 台设备</strong>。
      </div>

      {/* Generate + Direct Revoke */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
          <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0] mb-3">
            生成解锁码
          </h3>
          <form onSubmit={handleGenerate} className="space-y-3">
            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-xs text-[#5C6B64] dark:text-[#93A69D] mb-1">
                  个数 (1–50)
                </label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm tabular-nums text-[#101815] dark:text-[#EDF3F0]"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-[#5C6B64] dark:text-[#93A69D] mb-1">
                  备注（可选，最多 80 字）
                </label>
                <input
                  type="text"
                  maxLength={80}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="例如：小红书活动 / 送给老王"
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0]"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={generating}
              className="w-full min-h-[44px] px-4 py-2 rounded-xl bg-[#00A66C] hover:bg-[#00704A] active:scale-[0.99] text-white text-sm font-semibold flex items-center justify-center gap-1.5 transition-all disabled:opacity-60"
            >
              <Plus className="w-4 h-4" />
              <span>{generating ? '生成中…' : '立即生成'}</span>
            </button>
          </form>

          {freshCodes.length > 0 && (
            <div className="mt-4 p-3.5 rounded-xl bg-[#00A66C]/10 border border-[#00A66C]/30 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#00704A] dark:text-[#4AD29E]">
                  新生成的解锁码（{freshCodes.length} 个）
                </span>
                <button
                  type="button"
                  onClick={handleCopyAllFresh}
                  className="min-h-[36px] px-3 py-1 rounded-lg bg-[#00A66C] text-white text-xs font-medium flex items-center gap-1"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>一键复制全部</span>
                </button>
              </div>
              <div className="space-y-1 font-mono tracking-wider text-sm text-[#101815] dark:text-[#EDF3F0] select-all">
                {freshCodes.map((c) => (
                  <div key={c}>{c}</div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 flex flex-col justify-between surface-card">
          <div>
            <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0] mb-1.5">
              作废任意解锁码
            </h3>
            <p className="text-xs text-[#5C6B64] dark:text-[#93A69D] mb-4 leading-relaxed">
              用于付款码被公开传播或退款后的强制回收。使用该码的设备下次打开网站将被锁回试用版。
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={manualRevokeCode}
              onChange={(e) => setManualRevokeCode(e.target.value)}
              placeholder="输入解锁码（如 ABCD-2345-EFGH）"
              className="flex-1 min-h-[44px] px-3 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm font-mono uppercase tracking-wider text-[#101815] dark:text-[#EDF3F0]"
            />
            <button
              type="button"
              disabled={!manualRevokeCode.trim()}
              onClick={() => setConfirmState({ type: 'revoke', code: manualRevokeCode.trim().toUpperCase() })}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#DC2626] hover:bg-[#B91C1C] text-white text-sm font-semibold whitespace-nowrap disabled:opacity-40"
            >
              作废该码
            </button>
          </div>
        </section>
      </div>

      {/* Code List */}
      <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
        <div className="flex flex-col gap-3 mb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <h3 className="text-[15px] font-semibold text-[#101815] dark:text-[#EDF3F0]">
              解锁码记录 ({filteredCodes.length})
            </h3>
            <div className="grid grid-cols-4 sm:flex items-center gap-1 p-1 bg-[#F1F5F3] dark:bg-[#192620] rounded-xl">
              {(
                [
                  ['all', '全部'],
                  ['unused', '未使用'],
                  ['used', '已使用'],
                  ['revoked', '已作废'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(k)}
                  className={`min-h-[36px] px-2.5 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                    filter === k
                      ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs font-semibold'
                      : 'text-[#5C6B64] dark:text-[#93A69D]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-[#5C6B64] dark:text-[#93A69D] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜解锁码或备注关键词"
              className="w-full min-h-[42px] pl-10 pr-3.5 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-sm text-[#101815] dark:text-[#EDF3F0] focus:outline-none focus:border-[#00A66C]"
            />
          </div>
        </div>

        {loading ? (
          <div className="space-y-2.5">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-16 rounded-xl bg-[#F1F5F3] dark:bg-[#192620] animate-pulse" />
            ))}
          </div>
        ) : filteredCodes.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#5C6B64] dark:text-[#93A69D]">暂无符合条件的解锁码</p>
        ) : (
          <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23]">
            {filteredCodes.slice(0, limit).map((item) => {
              const statusText = item.revoked
                ? '已作废'
                : item.used_by
                  ? `已使用 · ${formatParisDateTime(item.used_at)}`
                  : '未使用';
              const statusColor = item.revoked
                ? 'text-[#DC2626] dark:text-[#FCA5A5]'
                : item.used_by
                  ? 'text-[#5C6B64] dark:text-[#93A69D]'
                  : 'text-[#00704A] dark:text-[#4AD29E]';

              return (
                <div
                  key={item.code}
                  className="py-3.5 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                      <span
                        className={`font-mono tracking-wider text-sm font-bold ${
                          item.revoked
                            ? 'line-through text-[#5C6B64] dark:text-[#93A69D]'
                            : 'text-[#101815] dark:text-[#EDF3F0]'
                        }`}
                      >
                        {item.code}
                      </span>
                      <span className={`text-xs font-semibold ${statusColor}`}>{statusText}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
                      {item.note ? `${item.note} · ` : ''}
                      生成于 {formatParisDateTime(item.created)}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleCopyOne(item.code)}
                      className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>复制</span>
                    </button>
                    {!item.revoked && item.used_by && (
                      <button
                        type="button"
                        onClick={() => setConfirmState({ type: 'reset', code: item.code })}
                        className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] text-xs font-medium text-[#101815] dark:text-[#EDF3F0] flex items-center gap-1"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>换设备</span>
                      </button>
                    )}
                    {!item.revoked && (
                      <button
                        type="button"
                        onClick={() => setConfirmState({ type: 'revoke', code: item.code })}
                        className="min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-medium text-[#DC2626] dark:text-[#FCA5A5] hover:bg-[#DC2626]/10 flex items-center gap-1"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>作废</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {filteredCodes.length > limit && (
              <div className="pt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => setLimit((prev) => prev + 40)}
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-[#F6F8F7] dark:bg-[#192620] border border-[#DCE4E0] dark:border-[#26362E] text-xs font-semibold text-[#101815] dark:text-[#EDF3F0]"
                >
                  显示更多（还有 {filteredCodes.length - limit} 条）
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmState?.type === 'reset'}
        title="换设备（清空已绑定设备）"
        description={`确定清空解锁码「${confirmState?.code || ''}」已绑定的设备吗？清空后客人可以在新手机上重新激活。`}
        confirmLabel="确认清空"
        loading={actionLoading}
        onCancel={() => setConfirmState(null)}
        onConfirm={handleConfirmAction}
      />

      <ConfirmDialog
        open={confirmState?.type === 'revoke'}
        title="作废解锁码"
        description={`确定作废解锁码「${confirmState?.code || ''}」吗？正在使用该码的设备下次打开网站时会被锁回试用版。`}
        confirmLabel="确认作废"
        danger
        loading={actionLoading}
        onCancel={() => setConfirmState(null)}
        onConfirm={handleConfirmAction}
      />
    </div>
  );
};
