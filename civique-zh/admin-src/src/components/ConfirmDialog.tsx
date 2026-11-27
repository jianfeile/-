import React from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className="w-full sm:max-w-md bg-white dark:bg-[#131C18] border border-[#E4EAE7] dark:border-[#223029] rounded-t-3xl sm:rounded-2xl p-6 pb-8 sm:pb-6 shadow-xl">
        <div className="w-10 h-1 bg-[#D2DDD7] dark:bg-[#2F4037] rounded-full mx-auto mb-4 sm:hidden" />
        <h3 id="confirm-dialog-title" className="text-lg font-semibold text-[#101815] dark:text-[#EDF3F0]">
          {title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-[#5C6B64] dark:text-[#93A69D]">
          {description}
        </p>
        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="min-h-[44px] px-4 py-2.5 rounded-xl border border-[#DCE4E0] dark:border-[#2A3A32] text-sm font-medium text-[#101815] dark:text-[#EDF3F0] hover:bg-[#F3F6F4] dark:hover:bg-[#1A2620] transition-colors whitespace-nowrap"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className={`min-h-[44px] px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors whitespace-nowrap disabled:opacity-60 ${
              danger
                ? 'bg-[#DC2626] hover:bg-[#B91C1C]'
                : 'bg-[#00A66C] hover:bg-[#00704A]'
            }`}
          >
            {loading ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
