import { ExamLevel, ThemeId } from './types';

export const STORAGE_TOKEN_KEY = 'civique.admin';
export const STORAGE_DEVICE_KEY = 'civique.admin.dev';
export const SITE_ORIGIN = 'https://kaocivique.com/';

export const LEVEL_LABELS: Record<ExamLevel, string> = {
  csp: '多年居留卡',
  cr: '十年居留卡',
  nat: '入籍',
};

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  shortLabel: string;
  color: string;
  textClass: string;
  bgTintClass: string;
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'principes',
    label: '共和国的原则与价值',
    shortLabel: '原则与价值',
    color: '#EF5A4B',
    textClass: 'text-[#C93B2D] dark:text-[#FF8578]',
    bgTintClass: 'bg-[#EF5A4B]/10',
  },
  {
    id: 'institutions',
    label: '制度与政治体系',
    shortLabel: '制度与政治',
    color: '#7C5CFA',
    textClass: 'text-[#5E3FD6] dark:text-[#A992FF]',
    bgTintClass: 'bg-[#7C5CFA]/10',
  },
  {
    id: 'droits',
    label: '权利与义务',
    shortLabel: '权利与义务',
    color: '#2F7CF6',
    textClass: 'text-[#1D5EC9] dark:text-[#6CA6FF]',
    bgTintClass: 'bg-[#2F7CF6]/10',
  },
  {
    id: 'histoire',
    label: '历史、地理与文化',
    shortLabel: '历史与文化',
    color: '#E67E22',
    textClass: 'text-[#B85D0B] dark:text-[#FFA654]',
    bgTintClass: 'bg-[#E67E22]/10',
  },
  {
    id: 'societe',
    label: '在法国社会生活',
    shortLabel: '法国社会生活',
    color: '#DF488D',
    textClass: 'text-[#B52B6B] dark:text-[#FF7DB7]',
    bgTintClass: 'bg-[#DF488D]/10',
  },
];

export const THEME_MAP: Record<ThemeId, ThemeMeta> = THEMES.reduce(
  (acc, item) => {
    acc[item.id] = item;
    return acc;
  },
  {} as Record<ThemeId, ThemeMeta>,
);

export function formatErrorMessage(
  code: string | undefined,
  opts?: { hasToken?: boolean; left?: number; context?: 'code' | 'general' },
): string {
  switch (code) {
    case 'forbidden':
      return opts?.hasToken ? '登录已过期，请重新登录。' : '密码不对。';
    case 'otp_required':
      return '请输入谷歌验证器里的 6 位数字。';
    case 'bad_otp':
      return '验证码不对或已过期，等它换下一组再试。';
    case 'locked':
      return '输错次数太多，后台已暂时锁住，15 分钟后再试。';
    case 'expired':
      return '登录已过期，请重新登录。';
    case 'bad_pattern':
      return typeof opts?.left === 'number'
        ? `手势不对，还能试 ${opts.left} 次。`
        : '手势格式不对，请至少连接 4 个点。';
    case 'device_forgotten':
      return '手势连错 5 次，这台设备已被忘掉，请用密码登录。';
    case 'device_expired':
      return '手势已满 30 天，请用密码登录一次再重设。';
    case 'device_unknown':
      return '这台设备的手势已失效，请用密码登录。';
    case 'full_login_needed':
      return '设置手势要在用密码登录后的 15 分钟内做，请退出后用密码重新登录。';
    case 'not_configured':
    case 'no_database':
      return '后台还没设置好，请联系开发者。';
    case 'not_found':
      return '找不到这个用户，可能已被删除。';
    case 'bad_request':
      return opts?.context === 'code' ? '这不是一个有效的解锁码。' : '参数有误，请检查输入。';
    case 'bad_code':
      return '代号只能用英文字母、数字、下划线或短横线。';
    case 'taken':
      return '这个代号已经有人用了，换一个。';
    case 'payment_service':
      return '收款数据暂时读不到，稍后再试。';
    case 'network':
      return '网络不通，稍后再试。';
    case 'server':
    default:
      return '出错了，稍后再试。';
  }
}
