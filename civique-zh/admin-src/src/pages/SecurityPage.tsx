import React, { useState } from 'react';
import { LogOut, Shield, Smartphone, Trash2 } from 'lucide-react';
import {
  adminRequest,
  ApiError,
  clearLocalDevice,
  getLocalDevice,
  setLocalDevice,
} from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PatternGrid } from '../components/PatternGrid';
import { formatErrorMessage } from '../constants';
import { DeviceItem, LocalDeviceCreds } from '../types';
import { formatParisDateTime, parseUserAgent } from '../utils/format';

interface SecurityPageProps {
  devices: DeviceItem[];
  loading: boolean;
  startSetupOpen?: boolean;
  onConsumeSetupOpen?: () => void;
  onRefreshDevices: () => Promise<void>;
  onLogout: () => void;
  onToast: (msg: string) => void;
}

export const SecurityPage: React.FC<SecurityPageProps> = ({
  devices,
  loading,
  startSetupOpen = false,
  onConsumeSetupOpen,
  onRefreshDevices,
  onLogout,
  onToast,
}) => {
  const [localDev, setLocalDev] = useState<LocalDeviceCreds | null>(() => getLocalDevice());
  const [setupStep, setSetupStep] = useState<'idle' | 'first' | 'second'>(() =>
    startSetupOpen ? 'first' : 'idle',
  );
  const [firstPattern, setFirstPattern] = useState<string>('');
  const [patternError, setPatternError] = useState<string | null>(null);
  const [needsReloginForPattern, setNeedsReloginForPattern] = useState(false);
  const [savingPattern, setSavingPattern] = useState(false);

  const [confirmClearLocal, setConfirmClearLocal] = useState(false);
  const [deletingDevice, setDeletingDevice] = useState<DeviceItem | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  React.useEffect(() => {
    if (startSetupOpen) {
      setSetupStep('first');
      setFirstPattern('');
      setPatternError(null);
      setNeedsReloginForPattern(false);
      onConsumeSetupOpen?.();
    }
  }, [startSetupOpen, onConsumeSetupOpen]);

  const handlePatternStep = async (pattern: string) => {
    setPatternError(null);
    setNeedsReloginForPattern(false);

    if (setupStep === 'first') {
      setFirstPattern(pattern);
      setSetupStep('second');
      return;
    }

    if (setupStep === 'second') {
      if (pattern !== firstPattern) {
        setPatternError('两次画的手势不一样，请重新画第一遍。');
        setFirstPattern('');
        setSetupStep('first');
        return;
      }

      setSavingPattern(true);
      try {
        const resp = await adminRequest<{ ok: true; device: string; secret: string; days: number }>(
          'device-add',
          { pattern },
        );
        const creds: LocalDeviceCreds = { device: resp.device, secret: resp.secret };
        setLocalDevice(creds);
        setLocalDev(creds);
        setSetupStep('idle');
        setFirstPattern('');
        await onRefreshDevices();
        onToast(`已记住本机手势（有效期 ${resp.days} 天）`);
      } catch (err) {
        if (err instanceof ApiError) {
          setPatternError(formatErrorMessage(err.code, { hasToken: true }));
          if (err.code === 'full_login_needed') {
            setNeedsReloginForPattern(true);
          }
        } else {
          setPatternError('设置手势失败，请稍后再试。');
        }
        setSetupStep('first');
        setFirstPattern('');
      } finally {
        setSavingPattern(false);
      }
    }
  };

  const handleClearLocal = () => {
    clearLocalDevice();
    setLocalDev(null);
    setConfirmClearLocal(false);
    onToast('本机已停用手势登录');
  };

  const handleDeleteDevice = async () => {
    if (!deletingDevice) return;
    setDeleteLoading(true);
    try {
      await adminRequest('device-del', { id: deletingDevice.id });
      if (localDev?.device === deletingDevice.id) {
        clearLocalDevice();
        setLocalDev(null);
      }
      await onRefreshDevices();
      onToast('已移除该设备');
      setDeletingDevice(null);
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

  return (
    <div className="space-y-4 animate-view-enter">
      {/* Local Pattern Section */}
      <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0]">
              本机手势解锁
            </h3>
            <p className="mt-1 text-xs text-[#5C6B64] dark:text-[#93A69D]">
              {localDev ? '这台设备已设置手势，下次可直接手势进入。' : '这台设备尚未设置手势。'}
            </p>
          </div>
          <div className="w-9 h-9 rounded-xl bg-[#00A66C]/12 text-[#00A66C] flex items-center justify-center shrink-0">
            <Shield className="w-5 h-5" />
          </div>
        </div>

        {setupStep === 'idle' ? (
          <div className="mt-4 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => {
                setSetupStep('first');
                setFirstPattern('');
                setPatternError(null);
                setNeedsReloginForPattern(false);
              }}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#00A66C] hover:bg-[#00704A] active:scale-[0.99] text-white text-sm font-semibold transition-all"
            >
              {localDev ? '重设本机手势' : '设置本机手势'}
            </button>
            {localDev && (
              <button
                type="button"
                onClick={() => setConfirmClearLocal(true)}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-[#DCE4E0] dark:border-[#26362E] text-sm font-medium text-[#101815] dark:text-[#EDF3F0]"
              >
                本机不再用手势
              </button>
            )}
          </div>
        ) : (
          <div className="mt-4 pt-4 border-t border-[#EEF2F0] dark:border-[#1D2A23] flex flex-col items-center">
            <p className="text-sm font-semibold text-[#101815] dark:text-[#EDF3F0] mb-2">
              {setupStep === 'first' ? '第 1 步：请画一个手势（至少 4 个点）' : '第 2 步：请再画一次确认'}
            </p>
            {patternError && (
              <p className="mt-1 mb-2 text-xs text-center text-[#DC2626] dark:text-[#FCA5A5] max-w-xs">
                {patternError}
              </p>
            )}
            {needsReloginForPattern && (
              <button
                type="button"
                onClick={onLogout}
                className="mb-3 min-h-[40px] px-4 py-1.5 rounded-xl bg-[#DC2626] text-white text-xs font-semibold"
              >
                立即退出并用密码重新登录
              </button>
            )}
            <div className="my-2">
              <PatternGrid
                disabled={savingPattern}
                error={Boolean(patternError)}
                onStart={() => setPatternError(null)}
                onTooShort={() => setPatternError('至少连接 4 个点。')}
                onComplete={handlePatternStep}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setSetupStep('idle');
                setFirstPattern('');
                setPatternError(null);
              }}
              className="mt-2 min-h-[40px] px-4 text-xs font-medium text-[#5C6B64] dark:text-[#93A69D] hover:underline"
            >
              取消设置
            </button>
          </div>
        )}

        <p className="mt-4 pt-3 border-t border-[#EEF2F0] dark:border-[#1D2A23] text-xs text-[#5C6B64] dark:text-[#93A69D] leading-relaxed">
          安全说明：手势 30 天内有效；连续输错 5 次会自动失效；修改管理密码会让所有设备上的手势一起失效。
        </p>
      </section>

      {/* Remembered Devices List */}
      <section className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-2xl p-4 sm:p-5 surface-card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-[#101815] dark:text-[#EDF3F0]">
            已记住手势的设备
          </h3>
          <span className="text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
            {devices.length} 台
          </span>
        </div>

        {loading ? (
          <div className="space-y-2.5">
            {[1, 2].map((n) => (
              <div key={n} className="h-14 rounded-xl bg-[#F1F5F3] dark:bg-[#192620] animate-pulse" />
            ))}
          </div>
        ) : devices.length === 0 ? (
          <p className="py-6 text-center text-sm text-[#5C6B64] dark:text-[#93A69D]">
            暂无已记住的设备
          </p>
        ) : (
          <div className="divide-y divide-[#EEF2F0] dark:divide-[#1D2A23]">
            {devices.map((d) => {
              const isCurrent = localDev?.device === d.id;
              return (
                <div key={d.id} className="py-3 first:pt-1 last:pb-1 flex items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <Smartphone className="w-4 h-4 text-[#5C6B64] dark:text-[#93A69D] mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[#101815] dark:text-[#EDF3F0] truncate">
                          {parseUserAgent(d.label)}
                        </span>
                        {isCurrent && (
                          <span className="text-xs font-semibold text-[#00704A] dark:text-[#4AD29E] shrink-0">
                            这台设备
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-[#5C6B64] dark:text-[#93A69D] tabular-nums">
                        设置于 {formatParisDateTime(d.created)} · 最近使用 {formatParisDateTime(d.last)}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDeletingDevice(d)}
                    className="min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-medium text-[#DC2626] dark:text-[#FCA5A5] hover:bg-[#DC2626]/10 flex items-center gap-1 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>移除</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Logout */}
      <button
        type="button"
        onClick={onLogout}
        className="w-full min-h-[48px] flex items-center justify-center gap-2 rounded-2xl bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] text-sm font-semibold text-[#DC2626] dark:text-[#FCA5A5] hover:bg-[#FAFBFB] dark:hover:bg-[#1A2620] surface-card"
      >
        <LogOut className="w-4 h-4" />
        <span>退出登录</span>
      </button>

      <ConfirmDialog
        open={confirmClearLocal}
        title="本机停用手势"
        description="将清除本机保存的手势钥匙，下次打开需要重新输入管理密码和验证码。确认继续吗？"
        confirmLabel="确认停用"
        danger
        onCancel={() => setConfirmClearLocal(false)}
        onConfirm={handleClearLocal}
      />

      <ConfirmDialog
        open={Boolean(deletingDevice)}
        title="移除已记住的设备"
        description={`确定移除「${parseUserAgent(deletingDevice?.label)}」吗？移除后该设备不能再用原来的手势登录。`}
        confirmLabel="确认移除"
        danger
        loading={deleteLoading}
        onCancel={() => setDeletingDevice(null)}
        onConfirm={handleDeleteDevice}
      />
    </div>
  );
};
