/**
 * 快照中心：内存态 + seq + 订阅者广播（docs/10 §2.1 Snapshot / Broadcast）。
 *
 * · 读请求只读内存，不查库、不阻塞轮询
 * · 单轮只推一次**完整**榜单（40 行 ≈ 6KB），不做 delta —— 全量语义最不容易出状态同步 bug
 * · 背压：订阅者若积压超过阈值，丢弃中间消息只保留最新（榜单是全量语义，丢中间态无害）
 */
import { log } from './log.mjs'

const MAX_SUB_BUFFER = 512 * 1024

export class SnapshotHub {
  constructor() {
    this.seq = 0
    this.current = null
    /** @type {Set<{id:number, send:Function, close:Function, buffered:number}>} */
    this.subs = new Set()
    this.nextId = 1
    this.pushes = 0
    this.dropped = 0
  }

  /** 用新一轮结果更新内存态，并广播出去 */
  publish(snapshot) {
    snapshot.seq = ++this.seq
    this.current = snapshot
    const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`
    for (const sub of this.subs) {
      if (sub.buffered > MAX_SUB_BUFFER) {
        this.dropped++
        continue // 背压：丢中间态，下一轮会带来最新全量
      }
      try {
        sub.send(payload)
        this.pushes++
      } catch (e) {
        log.warn(`推送失败，移除订阅者 #${sub.id}：${e instanceof Error ? e.message : e}`)
        this.remove(sub.id)
      }
    }
  }

  /** 发一条非榜单事件（hello / heartbeat / baseDateChange / sourceHealth） */
  emit(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    for (const sub of this.subs) {
      try {
        sub.send(payload)
      } catch {
        this.remove(sub.id)
      }
    }
  }

  subscribe(send, close) {
    const sub = { id: this.nextId++, send, close, buffered: 0 }
    this.subs.add(sub)
    return sub
  }

  remove(id) {
    for (const s of this.subs) if (s.id === id) this.subs.delete(s)
  }

  get subscriberCount() {
    return this.subs.size
  }
}
