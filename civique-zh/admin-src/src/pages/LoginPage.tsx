import React, { useRef, useState } from 'react';
import { ArrowRight, KeyRound, ShieldCheck } from 'lucide-react';
import {
  adminRequest,
  ApiError,
  getLocalDevice,
  isDemoMode,
  setDemoMode,
  setSessionToken,
} from '../api/client';
import { PatternGrid } from '../components/PatternGrid';
import { formatErrorMessage } from '../constants';
import { LocalDeviceCreds } from '../types';

interface LoginPageProps {
  initialNotice?: string | null;
  onLoginSuccess: (info: { method: 'password' | 'pattern'; hasLocalDevice: boolean }) => void;
  onDemoModeChange: (demo: boolean) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  initialNotice,
  onLoginSuccess,
  onDemoModeChange,
}) => {
  const [localDev, setLocalDev] = useState<LocalDeviceCreds | null>(() => getLocalDevice());
  const [mode, setMode] = useState<'pattern' | 'password'>(() => (getLocalDevice() ? 'pattern' : 'password'));
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(initialNotice || null);
  const [patternError, setPatternError] = useState(false);
  const [demo, setDemo] = useState(() => isDemoMode());

  const otpInputRef = useRef<HTMLInputElement | null>(null);

  const toggleDemo = (next: boolean) => {
    setDemoMode(next);
    setDemo(next);
    onDemoModeChange(next);
    setErrorMsg(null);
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setErrorMsg('请输入管理密码。');
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const resp = await adminRequest<{ ok: true; token: string; exp: number }>('login', {
        key: password,
        otp: otp.trim(),
      });
      setSessionToken(resp.token);
      setPassword('');
      setOtp('');
      onLoginSuccess({ method: 'password', hasLocalDevice: Boolean(getLocalDevice()) });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMsg(formatErrorMessage(err.code, { hasToken: false, left: err.left }));
        if (err.code === 'otp_required' || err.code === 'bad_otp') {
          setTimeout(() => otpInputRef.current?.focus(), 50);
        }
      } else {
        setErrorMsg('出错了，稍后再试。');
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePatternComplete = async (pattern: string) => {
    const dev = getLocalDevice();
    if (!dev) {
      setLocalDev(null);
      setMode('password');
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    setPatternError(false);
    try {
      const resp = await adminRequest<{ ok: true; token: string; exp: number }>('login', {
        device: dev.device,
        secret: dev.secret,
        pattern,
      });
      setSessionToken(resp.token);
      onLoginSuccess({ method: 'pattern', hasLocalDevice: true });
    } catch (err) {
      setPatternError(true);
      if (err instanceof ApiError) {
        const msg = formatErrorMessage(err.code, { hasToken: false, left: err.left });
        setErrorMsg(msg);
        if (
          err.code === 'device_forgotten' ||
          err.code === 'device_expired' ||
          err.code === 'device_unknown'
        ) {
          setLocalDev(null);
          setMode('password');
        }
      } else {
        setErrorMsg('出错了，稍后再试。');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleQuickDemoEnter = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const resp = await adminRequest<{ ok: true; token: string; exp: number }>('login', {
        key: 'demo',
        otp: '123456',
      });
      setSessionToken(resp.token);
      onLoginSuccess({ method: 'password', hasLocalDevice: Boolean(getLocalDevice()) });
    } catch {
      setErrorMsg('进入演示模式失败。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col justify-between bg-[#F4F7F5] dark:bg-[#090F0C] text-[#101815] dark:text-[#EDF3F0] px-4 py-5">
      {demo ? (
        <div className="max-w-sm w-full mx-auto flex items-center justify-between px-3.5 py-2 rounded-xl bg-[#FFC933]/20 border border-[#FFC933]/50 text-xs text-[#6B4400] dark:text-[#FFE082]">
          <span className="font-medium">演示数据模式</span>
          <button
            type="button"
            onClick={() => toggleDemo(false)}
            className="underline font-semibold ml-2 whitespace-nowrap"
          >
            切到真实接口
          </button>
        </div>
      ) : (
        <div />
      )}

      <div className="w-full max-w-sm mx-auto my-auto py-6 animate-view-enter">
        <div className="mb-6 text-center">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#00A66C] to-[#00704A] text-white flex items-center justify-center mx-auto mb-3.5 shadow-md shadow-[#00A66C]/20">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#101815] dark:text-[#EDF3F0]">
            kaocivique
          </h1>
          <p className="mt-1 text-sm text-[#5C6B64] dark:text-[#93A69D]">
            {mode === 'pattern' ? '请绘制手势密码解锁后台' : '管理后台 · 密码与验证码登录'}
          </p>
        </div>

        <div className="bg-white dark:bg-[#121B17] border border-[#E2E8E5] dark:border-[#1F2D26] rounded-3xl p-5 sm:p-6 surface-card">
          {errorMsg && (
            <div
              role="alert"
              className="mb-4 px-3.5 py-2.5 rounded-xl bg-[#DC2626]/10 border border-[#DC2626]/25 text-xs sm:text-sm text-[#B91C1C] dark:text-[#FCA5A5] leading-relaxed"
            >
              {errorMsg}
            </div>
          )}

          {mode === 'pattern' && localDev ? (
            <div className="flex flex-col items-center">
              <PatternGrid
                disabled={loading}
                error={patternError}
                onStart={() => {
                  setPatternError(false);
                  setErrorMsg(null);
                }}
                onTooShort={() => {
                  setPatternError(true);
                  setErrorMsg('手势至少连接 4 个点。');
                }}
                onComplete={handlePatternComplete}
              />
              {loading && (
                <p className="mt-3 text-xs text-[#5C6B64] dark:text-[#93A69D]">正在验证手势…</p>
              )}
              <button
                type="button"
                onClick={() => {
                  setMode('password');
                  setErrorMsg(null);
                  setPatternError(false);
                }}
                className="mt-5 min-h-[44px] px-4 text-sm font-medium text-[#00704A] dark:text-[#4AD29E] hover:underline"
              >
                改用密码登录
              </button>
            </div>
          ) : (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="admin-key"
                  className="block text-xs font-medium text-[#5C6B64] dark:text-[#93A69D] mb-1.5"
                >
                  管理密码
                </label>
                <input
                  id="admin-key"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入管理密码"
                  className="w-full min-h-[48px] px-3.5 py-2.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-base text-[#101815] dark:text-[#EDF3F0] focus:outline-none focus:border-[#00A66C] transition-colors"
                />
              </div>

              <div>
                <label
                  htmlFor="admin-otp"
                  className="block text-xs font-medium text-[#5C6B64] dark:text-[#93A69D] mb-1.5"
                >
                  谷歌验证码（6 位数字）
                </label>
                <input
                  ref={otpInputRef}
                  id="admin-otp"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full min-h-[48px] px-3.5 py-2.5 rounded-xl bg-[#F6F8F7] dark:bg-[#0B110E] border border-[#DCE4E0] dark:border-[#26362E] text-lg tracking-[0.3em] font-mono tabular-nums text-[#101815] dark:text-[#EDF3F0] focus:outline-none focus:border-[#00A66C] transition-colors"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full min-h-[48px] flex items-center justify-center gap-2 rounded-xl bg-[#00A66C] hover:bg-[#00704A] active:scale-[0.99] text-white text-sm font-semibold transition-all disabled:opacity-60"
              >
                <KeyRound className="w-4 h-4" />
                <span>{loading ? '正在验证…' : '进入后台'}</span>
              </button>

              {localDev && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('pattern');
                    setErrorMsg(null);
                  }}
                  className="w-full min-h-[44px] text-sm font-medium text-[#00704A] dark:text-[#4AD29E] hover:underline"
                >
                  返回手势解锁
                </button>
              )}
            </form>
          )}

          {demo && (
            <div className="mt-5 pt-4 border-t border-[#EEF2F0] dark:border-[#1D2A23]">
              <button
                type="button"
                disabled={loading}
                onClick={handleQuickDemoEnter}
                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-[#F1F5F3] dark:bg-[#192620] hover:bg-[#E4ECE8] dark:hover:bg-[#22332B] text-sm font-medium text-[#101815] dark:text-[#EDF3F0] transition-colors flex items-center justify-center gap-1.5"
              >
                <span>一键进入演示后台</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <p className="mt-2 text-[11px] text-center text-[#5C6B64] dark:text-[#93A69D]">
                演示模式也可用任意密码 + 6 位数字测试登录流程
              </p>
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-[#5C6B64] dark:text-[#93A69D]">
        通行证仅保留在当前会话 · 12 小时自动退出
      </p>
    </div>
  );
};
