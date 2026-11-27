import React from 'react';

interface ToastProps {
  message: string | null;
}

export const Toast: React.FC<ToastProps> = ({ message }) => {
  if (!message) return null;

  return (
    <div className="fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none px-4 max-w-[92vw]">
      <div className="px-4 py-2.5 rounded-xl bg-[#101815] dark:bg-[#EDF3F0] text-white dark:text-[#101815] text-sm font-medium shadow-lg text-center">
        {message}
      </div>
    </div>
  );
};
