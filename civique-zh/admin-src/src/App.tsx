import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  Shield,
  Ticket,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  adminRequest,
  ApiError,
  clearMemoryBankCache,
  clearSessionToken,
  fetchQuestionBankCount,
  getSessionToken,
  isDemoMode,
  loadQuestionBank,
  onAuthExpired,
  salesRequest,
  setDemoMode,
} from './api/client';
import { PosterModal } from './components/PosterModal';
import { Toast } from './components/Toast';
import { UserDetailSheet } from './components/UserDetailSheet';
import { formatErrorMessage } from './constants';
import { CodesPage } from './pages/CodesPage';
import { GrowthPage } from './pages/GrowthPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { QuestionsPage } from './pages/QuestionsPage';
import { SecurityPage } from './pages/SecurityPage';
import { UsersPage } from './pages/UsersPage';
import {
  CodeItem,
  DeviceItem,
  NavTab,
  Question,
  QuestionPatch,
  RefItem,
  SaleItem,
  User,
} from './types';

const NAV_ITEMS: Array<{ key: NavTab; label: string; shortLabel: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: '概览', shortLabel: '概览', icon: LayoutDashboard },
  { key: 'users', label: '用户', shortLabel: '用户', icon: Users },
  { key: 'growth', label: '推广与收入', shortLabel: '推广', icon: TrendingUp },
  { key: 'codes', label: '解锁码', shortLabel: '解锁码', icon: Ticket },
  { key: 'questions', label: '题库', shortLabel: '题库', icon: BookOpen },
  { key: 'security', label: '安全与设备', shortLabel: '安全', icon: Shield },
];

export default function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getSessionToken()));
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [suggestPatternPrompt, setSuggestPatternPrompt] = useState(false);
  const [startSecuritySetup, setStartSecuritySetup] = useState(false);

  const [demo, setDemo] = useState<boolean>(() => isDemoMode());
  const [tab, setTab] = useState<NavTab>('overview');

  // Core data states
  const [users, setUsers] = useState<User[]>([]);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [codes, setCodes] = useState<CodeItem[]>([]);
  const [patches, setPatches] = useState<QuestionPatch[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [coreLoading, setCoreLoading] = useState(false);

  // Sales (independent because Stripe takes 1-3s)
  const [sales, setSales] = useState<SaleItem[]>([]);
  const [salesMore, setSalesMore] = useState(false);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState<string | null>(null);

  // Question bank (decrypted in memory only)
  const [questions, setQuestions] = useState<Question[]>([]);
  const [freeIds, setFreeIds] = useState<Set<string>>(() => new Set());
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  const [bankTotalCount, setBankTotalCount] = useState<number>(617);

  // Selected user detail
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  // Poster modal
  const [posterTarget, setPosterTarget] = useState<{ code: string; name: string } | null>(null);

  // Toast
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((cur) => (cur === msg ? null : cur));
    }, 2600);
  }, []);

  // Follow system color scheme
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (dark: boolean) => {
      document.documentElement.classList.toggle('dark', dark);
    };
    apply(mq.matches);
    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Auth expiration listener (from API 401/expired/forbidden)
  useEffect(() => {
    return onAuthExpired(() => {
      setAuthed(false);
      setSelectedUser(null);
      setQuestions([]);
      setFreeIds(new Set());
      setLoginNotice('登录已过期，请重新登录。');
    });
  }, []);

  // 12-hour token expiry guard while tab remains open
  useEffect(() => {
    if (!authed) return;
    const token = getSessionToken();
    if (!token) return;
    // a pass reads <expiry in ms>.<kind>.<signature>: the first part is when it ends, not when it was issued
    const expiresAt = Number(token.split('.')[0]);
    if (!Number.isFinite(expiresAt) || expiresAt < 1e12) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      clearSessionToken();
      clearMemoryBankCache();
      setAuthed(false);
      setLoginNotice('登录已过期，请重新登录。');
      return;
    }
    const timer = setTimeout(() => {
      clearSessionToken();
      clearMemoryBankCache();
      setAuthed(false);
      setLoginNotice('登录已过期，请重新登录。');
    }, Math.min(remaining, 2147483647));
    return () => clearTimeout(timer);
  }, [authed]);

  const fetchSales = useCallback(async () => {
    setSalesLoading(true);
    setSalesError(null);
    try {
      const resp = await salesRequest();
      setSales(resp.sales || []);
      setSalesMore(Boolean(resp.more));
    } catch (err) {
      if (err instanceof ApiError) {
        setSalesError(formatErrorMessage(err.code, { hasToken: true }));
      } else {
        setSalesError('收款数据暂时读不到，稍后再试。');
      }
    } finally {
      setSalesLoading(false);
    }
  }, []);

  const fetchCore = useCallback(async () => {
    setCoreLoading(true);
    try {
      const [uRes, rRes, cRes, pRes, dRes] = await Promise.all([
        adminRequest<{ ok: true; users: User[] }>('users'),
        adminRequest<{ ok: true; refs: RefItem[] }>('refs'),
        adminRequest<{ ok: true; codes: CodeItem[] }>('codes'),
        adminRequest<{ ok: true; patches: QuestionPatch[] }>('patches'),
        adminRequest<{ ok: true; devices: DeviceItem[] }>('devices'),
      ]);
      setUsers(uRes.users || []);
      setRefs(rRes.refs || []);
      setCodes(cRes.codes || []);
      setPatches(pRes.patches || []);
      setDevices(dRes.devices || []);
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'expired' && err.code !== 'forbidden') {
        showToast(formatErrorMessage(err.code, { hasToken: true }));
      }
    } finally {
      setCoreLoading(false);
    }
  }, [showToast]);

  const ensureQuestionBank = useCallback(
    async (force = false) => {
      if (!force && questions.length > 0) return;
      setQuestionsLoading(true);
      setQuestionsError(null);
      try {
        const res = await loadQuestionBank(force);
        setQuestions(res.qs);
        setFreeIds(res.freeIds);
      } catch (err) {
        if (err instanceof ApiError) {
          setQuestionsError(formatErrorMessage(err.code, { hasToken: true }));
        } else {
          setQuestionsError('题库加载或解密失败，请稍后重试。');
        }
      } finally {
        setQuestionsLoading(false);
      }
    },
    [questions.length],
  );

  useEffect(() => {
    if (!authed) return;
    fetchCore();
    fetchSales();
    fetchQuestionBankCount().then((n) => {
      if (n) setBankTotalCount(n);
    });
  }, [authed, fetchCore, fetchSales]);

  useEffect(() => {
    if (authed && tab === 'questions') {
      ensureQuestionBank(false);
    }
  }, [authed, tab, ensureQuestionBank]);

  const handleLogout = () => {
    clearSessionToken();
    clearMemoryBankCache();
    setAuthed(false);
    setSelectedUser(null);
    setQuestions([]);
    setFreeIds(new Set());
    setSuggestPatternPrompt(false);
    setLoginNotice(null);
  };

  const handleSwitchDemo = (nextDemo: boolean) => {
    setDemoMode(nextDemo);
    setDemo(nextDemo);
    clearSessionToken();
    clearMemoryBankCache();
    setAuthed(false);
    setSelectedUser(null);
    setQuestions([]);
    setFreeIds(new Set());
    setLoginNotice(null);
  };

  if (!authed) {
    return (
      <>
        <LoginPage
          initialNotice={loginNotice}
          onDemoModeChange={(next) => setDemo(next)}
          onLoginSuccess={({ method, hasLocalDevice }) => {
            setLoginNotice(null);
            setAuthed(true);
            setSuggestPatternPrompt(method === 'password' && !hasLocalDevice);
          }}
        />
        <Toast message={toastMsg} />
      </>
    );
  }

  const currentTitle = NAV_ITEMS.find((n) => n.key === tab)?.label || '管理后台';
  const mobileBottomTabs = NAV_ITEMS.slice(0, 5);

  return (
    <div className="min-h-dvh bg-[#F4F7F5] dark:bg-[#090F0C] text-[#101815] dark:text-[#EDF3F0] flex flex-col lg:flex-row">
      {/* Desktop Left Sidebar */}
      <aside className="hidden lg:flex lg:w-60 lg:shrink-0 lg:flex-col lg:sticky lg:top-0 lg:h-dvh bg-white dark:bg-[#121B17] border-r border-[#E2E8E5] dark:border-[#1F2D26] p-4 justify-between">
        <div>
          <div className="px-2.5 py-2 mb-5 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#00A66C] to-[#00704A] flex items-center justify-center text-white text-xs font-bold">
              K
            </div>
            <span className="text-base font-bold tracking-tight text-[#101815] dark:text-[#EDF3F0]">
              kaocivique
            </span>
          </div>

          <nav className="space-y-1" aria-label="主导航">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = tab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  className={`w-full min-h-[44px] px-3 py-2 rounded-xl flex items-center gap-3 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-[#00A66C]/12 text-[#00704A] dark:text-[#4AD29E] font-semibold'
                      : 'text-[#5C6B64] dark:text-[#93A69D] hover:bg-[#F3F6F4] dark:hover:bg-[#192620] hover:text-[#101815] dark:hover:text-[#EDF3F0]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="space-y-1.5 pt-4 border-t border-[#EEF2F0] dark:border-[#1D2A23]">
          <button
            type="button"
            onClick={() => {
              fetchCore();
              fetchSales();
              if (tab === 'questions') ensureQuestionBank(true);
            }}
            className="w-full min-h-[42px] px-3 py-2 rounded-xl text-xs font-medium text-[#5C6B64] dark:text-[#93A69D] hover:bg-[#F3F6F4] dark:hover:bg-[#192620] flex items-center gap-2.5"
          >
            <RefreshCw className={`w-4 h-4 ${coreLoading || salesLoading ? 'animate-spin' : ''}`} />
            <span>刷新全部数据</span>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full min-h-[42px] px-3 py-2 rounded-xl text-xs font-medium text-[#DC2626] dark:text-[#FCA5A5] hover:bg-[#DC2626]/10 flex items-center gap-2.5"
          >
            <LogOut className="w-4 h-4" />
            <span>退出登录</span>
          </button>
        </div>
      </aside>

      {/* Mobile Compact Sticky Header */}
      <header className="lg:hidden sticky top-0 z-30 h-12 px-4 bg-white/90 dark:bg-[#121B17]/90 backdrop-blur-xl border-b border-[#E2E8E5] dark:border-[#1F2D26] flex items-center justify-between pt-safe">
        <span className="text-[17px] font-bold tracking-tight text-[#101815] dark:text-[#EDF3F0] whitespace-nowrap">
          {currentTitle}
        </span>

        <div className="flex items-center gap-1 -mr-2">
          <button
            type="button"
            onClick={() => {
              fetchCore();
              fetchSales();
              if (tab === 'questions') ensureQuestionBank(true);
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[#5C6B64] dark:text-[#93A69D]"
            aria-label="刷新数据"
          >
            <RefreshCw className={`w-4 h-4 ${coreLoading || salesLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => setTab('security')}
            className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl ${
              tab === 'security'
                ? 'text-[#00704A] dark:text-[#4AD29E]'
                : 'text-[#5C6B64] dark:text-[#93A69D]'
            }`}
            aria-label="安全与设备"
          >
            <Shield className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 min-w-0 pb-24 lg:pb-10">
        <div className="max-w-6xl mx-auto px-3.5 sm:px-6 pt-3.5 sm:pt-6 space-y-4">
          {demo && (
            <div className="px-3.5 py-2 rounded-xl bg-[#FFC933]/20 border border-[#FFC933]/45 flex items-center justify-between gap-2 text-xs text-[#6B4400] dark:text-[#FFE082]">
              <span className="font-semibold">
                演示数据模式（所有修改仅在当前内存生效）
              </span>
              <button
                type="button"
                onClick={() => handleSwitchDemo(false)}
                className="underline font-semibold whitespace-nowrap shrink-0"
              >
                切到真实接口
              </button>
            </div>
          )}

          {suggestPatternPrompt && tab !== 'security' && (
            <div className="px-4 py-3 rounded-xl bg-[#00A66C]/10 border border-[#00A66C]/30 flex items-center justify-between gap-3">
              <span className="text-xs sm:text-sm font-medium text-[#00704A] dark:text-[#4AD29E]">
                设个手势，下次不用输密码
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setSuggestPatternPrompt(false)}
                  className="min-h-[36px] px-2.5 text-xs text-[#5C6B64] dark:text-[#93A69D]"
                >
                  以后再说
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSuggestPatternPrompt(false);
                    setStartSecuritySetup(true);
                    setTab('security');
                  }}
                  className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-[#00A66C] text-white text-xs font-semibold whitespace-nowrap"
                >
                  去设置
                </button>
              </div>
            </div>
          )}

          {/* Desktop Section Header */}
          <div className="hidden lg:flex items-center justify-between">
            <h1 className="text-xl font-bold tracking-tight text-[#101815] dark:text-[#EDF3F0]">
              {currentTitle}
            </h1>
          </div>

          {tab === 'overview' && (
            <OverviewPage
              users={users}
              refs={refs}
              sales={sales}
              salesLoading={salesLoading}
              salesError={salesError}
              onRetrySales={fetchSales}
              onSelectUser={(u) => setSelectedUser(u)}
              onNavigate={(target) => setTab(target)}
            />
          )}

          {tab === 'users' && (
            <UsersPage
              users={users}
              refs={refs}
              loading={coreLoading && users.length === 0}
              onSelectUser={(u) => setSelectedUser(u)}
            />
          )}

          {tab === 'growth' && (
            <GrowthPage
              users={users}
              refs={refs}
              sales={sales}
              salesMore={salesMore}
              salesLoading={salesLoading}
              salesError={salesError}
              onRetrySales={fetchSales}
              onRefreshRefs={async () => {
                const res = await adminRequest<{ ok: true; refs: RefItem[] }>('refs');
                setRefs(res.refs || []);
              }}
              onSelectUser={(u) => setSelectedUser(u)}
              onOpenPoster={(code, name) => setPosterTarget({ code, name })}
              onToast={showToast}
            />
          )}

          {tab === 'codes' && (
            <CodesPage
              codes={codes}
              loading={coreLoading && codes.length === 0}
              onRefreshCodes={async () => {
                const res = await adminRequest<{ ok: true; codes: CodeItem[] }>('codes');
                setCodes(res.codes || []);
              }}
              onToast={showToast}
            />
          )}

          {tab === 'questions' && (
            <QuestionsPage
              questions={questions}
              freeIds={freeIds}
              patches={patches}
              loading={questionsLoading}
              error={questionsError}
              onReloadBank={() => ensureQuestionBank(true)}
              onRefreshPatches={async () => {
                const res = await adminRequest<{ ok: true; patches: QuestionPatch[] }>('patches');
                setPatches(res.patches || []);
              }}
              onToast={showToast}
            />
          )}

          {tab === 'security' && (
            <SecurityPage
              devices={devices}
              loading={coreLoading && devices.length === 0}
              startSetupOpen={startSecuritySetup}
              onConsumeSetupOpen={() => setStartSecuritySetup(false)}
              onRefreshDevices={async () => {
                const res = await adminRequest<{ ok: true; devices: DeviceItem[] }>('devices');
                setDevices(res.devices || []);
              }}
              onLogout={handleLogout}
              onToast={showToast}
            />
          )}
        </div>
      </main>

      {/* Mobile Fixed Bottom Navigation */}
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-[#121B17]/95 backdrop-blur-xl border-t border-[#E2E8E5] dark:border-[#1F2D26] pb-safe"
        aria-label="底部导航"
      >
        <div className="grid grid-cols-5 h-[58px] items-center">
          {mobileBottomTabs.map((item) => {
            const Icon = item.icon;
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={`relative min-h-[48px] flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  active
                    ? 'text-[#00704A] dark:text-[#4AD29E]'
                    : 'text-[#5C6B64] dark:text-[#93A69D]'
                }`}
              >
                {active && (
                  <span className="absolute top-0 w-6 h-[2.5px] rounded-full bg-[#00A66C]" />
                )}
                <Icon className="w-5 h-5" />
                <span className={`text-[11px] leading-none ${active ? 'font-semibold' : 'font-medium'}`}>
                  {item.shortLabel}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* User Detail Sheet */}
      {selectedUser && (
        <UserDetailSheet
          user={selectedUser}
          refs={refs}
          questions={questions}
          patches={patches}
          questionsLoading={questionsLoading}
          onEnsureQuestions={() => ensureQuestionBank(false)}
          onClose={() => setSelectedUser(null)}
          onUserDeleted={(deletedId) => {
            setUsers((prev) => prev.filter((u) => u.id !== deletedId));
            setSelectedUser(null);
          }}
          onToast={showToast}
        />
      )}

      {/* Poster & QR Modal */}
      <PosterModal
        open={Boolean(posterTarget)}
        refCode={posterTarget?.code || ''}
        refName={posterTarget?.name || ''}
        totalQuestions={questions.length || bankTotalCount}
        onClose={() => setPosterTarget(null)}
        onToast={showToast}
      />

      <Toast message={toastMsg} />
    </div>
  );
}
