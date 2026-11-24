// 简单可靠的 JSON 持久化（先写临时文件再原子替换）
import fs from 'node:fs';
import path from 'node:path';

export class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private file: string,
    private debounceMs = 2_000,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  read(): T | null {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  writeNow(data: T) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }

  writeSoon(get: () => T) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.writeNow(get());
      } catch (e) {
        console.error('[store] 写入失败', this.file, (e as Error).message);
      }
    }, this.debounceMs);
  }
}
