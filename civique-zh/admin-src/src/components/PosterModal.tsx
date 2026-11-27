import React, { useEffect, useRef, useState } from 'react';
import { Copy, Download, X } from 'lucide-react';
import { isDemoMode } from '../api/client';
import { copyText, getRefLink } from '../utils/format';
import { downloadCanvasPng, generatePosterCanvas, getPosterFilename, PosterKind } from '../utils/poster';

interface PosterModalProps {
  open: boolean;
  refCode: string; // '' for homepage
  refName: string;
  totalQuestions: number;
  onClose: () => void;
  onToast: (msg: string) => void;
}

const TABS: Array<{ key: PosterKind; label: string }> = [
  { key: 'poster', label: '推广海报' },
  { key: 'guide', label: '桌面教程海报' },
  { key: 'qr', label: '纯二维码' },
];

export const PosterModal: React.FC<PosterModalProps> = ({
  open,
  refCode,
  refName,
  totalQuestions,
  onClose,
  onToast,
}) => {
  const [kind, setKind] = useState<PosterKind>('poster');
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [isFallback, setIsFallback] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const link = getRefLink(refCode);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPreviewUrl('');

    generatePosterCanvas(kind, { link, total: totalQuestions || 617 }, isDemoMode())
      .then(({ canvas, isFallback: fb }) => {
        if (cancelled) return;
        canvasRef.current = canvas;
        setIsFallback(fb);
        setPreviewUrl(canvas.toDataURL('image/png'));
      })
      .catch(() => {
        if (!cancelled) onToast('海报生成失败，请稍后再试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, kind, link, totalQuestions, onToast]);

  if (!open) return null;

  const filename = getPosterFilename(refCode, kind);

  const handleCopyLink = async () => {
    const ok = await copyText(link);
    onToast(ok ? '推广链接已复制' : '复制失败，请手动复制');
  };

  const handleDownload = () => {
    if (!canvasRef.current) return;
    downloadCanvasPng(canvasRef.current, filename);
    onToast('已开始下载 PNG');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full sm:max-w-lg max-h-[92dvh] flex flex-col bg-white dark:bg-[#131C18] border border-[#E4EAE7] dark:border-[#223029] rounded-t-3xl sm:rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E4EAE7] dark:border-[#223029]">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0] truncate">
              {refName || '官网直接推广'}
            </h3>
            <p className="text-xs text-[#5C6B64] dark:text-[#93A69D] truncate">{link}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[#5C6B64] hover:bg-[#F3F6F4] dark:hover:bg-[#1A2620]"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-3">
          <div className="grid grid-cols-3 gap-1 p-1 bg-[#F1F5F3] dark:bg-[#1A2620] rounded-xl">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setKind(tab.key)}
                className={`min-h-[40px] px-2 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  kind === tab.key
                    ? 'bg-white dark:bg-[#24342C] text-[#101815] dark:text-[#EDF3F0] shadow-xs'
                    : 'text-[#5C6B64] dark:text-[#93A69D] hover:text-[#101815] dark:hover:text-[#EDF3F0]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col items-center">
          {loading ? (
            <div className="w-full max-w-[280px] aspect-3/4 rounded-xl bg-[#F1F5F3] dark:bg-[#1A2620] animate-pulse flex items-center justify-center text-sm text-[#5C6B64] dark:text-[#93A69D]">
              正在生成图片…
            </div>
          ) : previewUrl ? (
            <>
              <img
                src={previewUrl}
                alt={filename}
                style={{ WebkitTouchCallout: 'default' }}
                className={`rounded-xl border border-[#E4EAE7] dark:border-[#223029] shadow-xs ${
                  kind === 'qr' ? 'w-56 h-56' : 'w-full max-w-[290px] h-auto'
                }`}
              />
              <p className="mt-3 text-xs text-center text-[#5C6B64] dark:text-[#93A69D]">
                手机上可长按上方图片直接保存
                {isFallback ? ' · 当前为演示模式占位图' : ''}
              </p>
            </>
          ) : null}
        </div>

        <div className="px-5 py-3.5 pb-6 sm:pb-3.5 border-t border-[#E4EAE7] dark:border-[#223029] flex items-center gap-2.5 bg-[#FAFBFB] dark:bg-[#0F1713]">
          <button
            type="button"
            onClick={handleCopyLink}
            className="min-h-[44px] flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-[#DCE4E0] dark:border-[#2A3A32] text-sm font-medium text-[#101815] dark:text-[#EDF3F0] hover:bg-[#F1F5F3] dark:hover:bg-[#1A2620] whitespace-nowrap"
          >
            <Copy className="w-4 h-4" />
            <span>复制链接</span>
          </button>
          <button
            type="button"
            disabled={loading || !previewUrl}
            onClick={handleDownload}
            className="min-h-[44px] flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-[#00A66C] hover:bg-[#00704A] text-white text-sm font-semibold transition-colors whitespace-nowrap disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            <span>下载 PNG</span>
          </button>
        </div>
      </div>
    </div>
  );
};
