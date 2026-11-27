export type ExamLevel = 'csp' | 'cr' | 'nat';
export type ThemeId = 'principes' | 'institutions' | 'droits' | 'histoire' | 'societe';

export interface UserSum {
  demo?: number;
  seen?: number;
  ok?: number;
  miss?: number;
  ans?: number;
  pool?: number;
  exams?: number;
  best?: number;
  bestN?: number;
}

export interface User {
  id: string;
  login: string;
  email: string | null;
  ref: string;
  created: number;
  paid_at: number | null;
  last_seen: number;
  country: string;
  city: string;
  ua: string;
  level: string;
  exam_date: string;
  unlocked: 0 | 1;
  days: number;
  sum: UserSum | null;
}

export interface UserExam {
  ts: number;
  target: string;
  mini: boolean;
  score: number;
  n: number;
  passAt: number;
  secs: number;
}

export interface UserState {
  // [attempts, correct, lastCorrect(1/0), remainingStreakToClear, lastAnsweredMs]
  stats: Record<string, [number, number, number, number, number]>;
  // YYYY-MM-DD -> [questionsDone, newlyMastered]
  days: Record<string, [number, number]>;
  exams: UserExam[];
}

export interface UserDetailResponse {
  ok: true;
  user: User & { state?: UserState };
  days: Array<{ day: string; n: number }>;
  devices: number;
  limit: number;
}

export interface RefItem {
  code: string;
  name: string;
  pct: number;
  created: number;
}

export interface SaleItem {
  t: number; // seconds
  amount: number; // cents
  currency: string;
  ref: string;
}

export interface CodeItem {
  code: string;
  note?: string;
  created: number;
  used_at: number | null;
  used_by: string | null;
  revoked: boolean;
}

export interface Question {
  id: string;
  t: ThemeId;
  l: ExamLevel[];
  k: 'c' | 's';
  q: string;
  qz: string;
  o: [string, string, string, string];
  oz: [string, string, string, string];
  e: string;
  v?: Array<[string, string]>;
  s?: unknown;
}

export interface PatchData {
  q?: string;
  qz?: string;
  e?: string;
  o?: [string, string, string, string];
  oz?: [string, string, string, string];
}

export interface QuestionPatch {
  qid: string;
  free: boolean;
  data: PatchData;
  t: number;
}

export interface DeviceItem {
  id: string;
  label: string;
  created: number;
  last: number;
}

export interface LocalDeviceCreds {
  device: string;
  secret: string;
}

export interface ApiErrorResponse {
  error: string;
  left?: number;
}

export type NavTab = 'overview' | 'users' | 'growth' | 'codes' | 'questions' | 'security';
