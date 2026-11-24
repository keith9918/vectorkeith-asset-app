// 趣味特效：金币雨、彩带、烟花、提示卡片、合成音效（Web Audio）、语音播报（浏览器自带的中文语音）
// 各组件调用 fx.*()，由 FxLayer 负责画出来；吉祥物监听 react 事件做动作。
// 偏好"到账特效 / 音效 / 语音播报"可在设置里分别关闭。
import { getPrefs } from './prefs';

export type FxCard =
  | { kind: 'in'; sol: number; total: number; label?: string }
  | { kind: 'out'; sol: number; total: number; label?: string }
  | { kind: 'poison'; text: string }
  | { kind: 'badge'; icon: string; name: string; level?: string; text: string }
  | { kind: 'goal'; target: number; label?: string; total: number };

/** 吉祥物的即时反应 */
export type Reaction = 'catch' | 'party' | 'scared';

export type FxEvent =
  | { type: 'coins'; count: number; big?: boolean }
  | { type: 'confetti' }
  | { type: 'fireworks'; bursts: number }
  | { type: 'flash'; color: 'red' }
  | { type: 'card'; card: FxCard }
  | { type: 'react'; mood: Reaction; sol?: number };

const listeners = new Set<(e: FxEvent) => void>();
export function onFx(cb: (e: FxEvent) => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
const emit = (e: FxEvent) => listeners.forEach((l) => l(e));

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 金额越大金币越多（对数增长）：0.02 SOL ≈ 10 枚，1 SOL ≈ 19 枚，28 SOL ≈ 54 枚，1000 SOL ≈ 100 枚 */
export const coinCount = (sol: number) => Math.round(Math.min(140, 10 + 30 * Math.log10(1 + Math.abs(sol))));

// ─── 音效 ─────────────────────────────────────────────────────
let ctx: AudioContext | null = null;
let speechReady = false;

/** iPhone 要求在用户点击里创建 / 恢复音频、第一次朗读；打开开关时、以及之后每次第一下点击时调用 */
export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}
export function unlockSpeech() {
  if (speechReady || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
    speechReady = true;
  } catch {
    /* 不支持 */
  }
}
document.addEventListener(
  'pointerdown',
  () => {
    const p = getPrefs();
    if (p.sound) unlockAudio();
    if (p.voice) unlockSpeech();
  },
  { passive: true },
);

function tone(freq: number, start: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

type Sound = 'coin' | 'out' | 'badge' | 'alarm' | 'boom';
export function playSound(s: Sound, times = 1) {
  if (!getPrefs().sound) return;
  unlockAudio();
  if (!ctx || ctx.state !== 'running') return;
  if (s === 'coin') {
    // 经典"叮"：B5 → E6，金额大时连响几声
    for (let i = 0; i < Math.min(5, times); i++) {
      tone(988, i * 0.11, 0.09, 'triangle', 0.16);
      tone(1319, i * 0.11 + 0.07, 0.35, 'triangle', 0.16);
    }
  } else if (s === 'out') {
    tone(660, 0, 0.12, 'sine', 0.1);
    tone(494, 0.1, 0.25, 'sine', 0.1);
  } else if (s === 'badge') {
    // 号角：C5 E5 G5 C6
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, i === 3 ? 0.6 : 0.16, 'triangle', 0.15));
  } else if (s === 'boom') {
    // 烟花：上升的哨音 + 低沉的爆炸
    for (let i = 0; i < Math.min(6, times); i++) {
      tone(400, i * 0.45, 0.35, 'sine', 0.05, 1600);
      tone(90, i * 0.45 + 0.35, 0.5, 'sawtooth', 0.08, 40);
    }
  } else {
    tone(220, 0, 0.18, 'sawtooth', 0.06);
    tone(220, 0.26, 0.18, 'sawtooth', 0.06);
  }
}

// ─── 语音播报 ─────────────────────────────────────────────────

function zhVoice() {
  const vs = 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
  return vs.find((v) => /^zh[-_]CN/i.test(v.lang)) ?? vs.find((v) => /^zh/i.test(v.lang));
}

/** 用中文朗读（像支付宝到账播报）；没打开"语音播报"时不出声 */
export function speak(text: string, force = false) {
  if ((!force && !getPrefs().voice) || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    const v = zhVoice();
    if (v) u.voice = v;
    u.rate = 1;
    u.volume = 1;
    speechSynthesis.speak(u);
  } catch {
    /* 不支持 */
  }
}

/** 朗读用的金额：0.0123 → "0.01"，12.3456 → "12.35" */
const sayNum = (v: number) => (Math.abs(v) >= 1 ? v.toFixed(2) : Math.abs(v) >= 0.01 ? v.toFixed(3) : v.toPrecision(2)).replace(/\.?0+$/, '');

// ─── 对外接口 ─────────────────────────────────────────────────

export const fx = {
  /** 公司钱包到账（cny = 折合人民币，用于语音播报） */
  inflow(sol: number, total: number, label?: string, cny?: number) {
    emit({ type: 'react', mood: 'catch', sol });
    speak(`VectorKeith 到账 ${sayNum(sol)} SOL${cny && cny >= 1 ? `，约 ${Math.round(cny)} 元` : ''}`);
    if (!getPrefs().fx) return;
    if (!reduceMotion()) emit({ type: 'coins', count: coinCount(sol), big: sol >= 10 });
    emit({ type: 'card', card: { kind: 'in', sol, total, label } });
    playSound('coin', sol >= 10 ? 4 : sol >= 1 ? 2 : 1);
  },
  outflow(sol: number, total: number, label?: string) {
    if (!getPrefs().fx) return;
    emit({ type: 'card', card: { kind: 'out', sol, total, label } });
    playSound('out');
  },
  /** 只下一阵金币雨（VK 链领到测试币、发行资产成功等） */
  rain(count = 36) {
    if (!getPrefs().fx) return;
    if (!reduceMotion()) emit({ type: 'coins', count });
    playSound('coin');
  },
  poison(text: string) {
    emit({ type: 'react', mood: 'scared' });
    speak('注意，发现地址投毒，转账时不要从交易记录里复制地址');
    if (!getPrefs().fx) return;
    if (!reduceMotion()) emit({ type: 'flash', color: 'red' });
    emit({ type: 'card', card: { kind: 'poison', text } });
    playSound('alarm');
  },
  badge(icon: string, name: string, text: string, level?: string) {
    emit({ type: 'react', mood: 'party' });
    speak(`解锁成就，${name}${level ? `，${level}` : ''}`);
    if (!getPrefs().fx) return;
    if (!reduceMotion()) emit({ type: 'confetti' });
    emit({ type: 'card', card: { kind: 'badge', icon, name, level, text } });
    playSound('badge');
  },
  /** 公司达成目标：烟花 */
  goal(target: number, total: number, label?: string) {
    emit({ type: 'react', mood: 'party' });
    speak(`恭喜，公司达成目标，${label ? `${label}，` : ''}${sayNum(target)} SOL`);
    if (!getPrefs().fx) return;
    if (!reduceMotion()) {
      emit({ type: 'fireworks', bursts: 7 });
      emit({ type: 'confetti' });
    }
    emit({ type: 'card', card: { kind: 'goal', target, label, total } });
    playSound('boom', 5);
  },
  /** 时光机回放经过一笔大额入账时的小金币 */
  sprinkle(sol: number) {
    if (!getPrefs().fx || reduceMotion()) return;
    emit({ type: 'coins', count: Math.max(6, Math.round(coinCount(sol) / 3)) });
    playSound('coin');
  },
};
