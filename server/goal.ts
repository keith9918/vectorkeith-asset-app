// 公司目标：管理员设一个总资产目标（SOL），首页显示进度；达成时广播（App 放烟花）并推送给所有人
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { GoalView } from '../shared/types';
import { JsonFile } from './store';

interface GoalFile {
  current: Omit<GoalView, 'past'> | null;
  past: GoalView['past'];
}

export class Goal extends EventEmitter {
  private file: JsonFile<GoalFile>;
  private d: GoalFile;

  constructor(dataDir: string) {
    super();
    this.file = new JsonFile(path.join(dataDir, 'goal', 'config.json'), 0);
    const f = this.file.read();
    this.d = { current: f?.current ?? null, past: f?.past ?? [] };
  }

  view(): GoalView | null {
    return this.d.current ? { ...this.d.current, past: this.d.past.slice(-10) } : null;
  }

  /** 设定新目标（target 为 0 / 空 = 清除）；目标必须高于现在的总资产 */
  set(input: any, totalSol: number): GoalView | null {
    const raw = input?.target;
    if (raw === null || raw === undefined || raw === '' || Number(raw) === 0) {
      this.d.current = null;
    } else {
      const target = Number(raw);
      if (!(target > 0 && target <= 1e7)) throw new Error('目标金额无效');
      if (target <= totalSol) throw new Error(`目标要比现在的公司总资产（${totalSol.toFixed(2)} SOL）高`);
      const label = String(input?.label ?? '').trim().slice(0, 16) || undefined;
      // 上一个目标已经达成：存进历史
      if (this.d.current?.reachedAt) this.d.past.push({ target: this.d.current.target, label: this.d.current.label, setAt: this.d.current.setAt, reachedAt: this.d.current.reachedAt });
      this.d.current = { target, label, setAt: Math.floor(Date.now() / 1000), startSol: totalSol };
    }
    this.file.writeNow(this.d);
    this.emit('changed', false);
    return this.view();
  }

  /** 公司总资产变化时检查是否达成（只触发一次，直到设定新目标） */
  check(totalSol: number) {
    const c = this.d.current;
    if (!c || c.reachedAt || !(totalSol >= c.target)) return;
    c.reachedAt = Math.floor(Date.now() / 1000);
    this.file.writeNow(this.d);
    console.log(`[goal] 达成目标 ${c.target} SOL（现在 ${totalSol.toFixed(4)} SOL）`);
    this.emit('changed', true, totalSol);
  }
}
