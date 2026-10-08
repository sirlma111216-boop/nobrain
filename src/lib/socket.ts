// 진행 상태 수신용 WebSocket. 끊기면 지수 백오프 + 무작위 지연(full jitter)으로 다시 붙는다.
// 500명이 동시에 끊겼다가 같은 순간에 몰려 재접속하지 않도록 첫 재시도부터 무작위로 흩는다.

export type SocketStatus = 'connecting' | 'open' | 'retrying' | 'stopped';

const STOP_CODES = new Set([4001, 4401, 4404]);

export class LiveSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private path: string,
    private onMessage: (m: any) => void,
    private onStatus: (s: SocketStatus, info?: { code?: number; delayMs?: number }) => void,
  ) {}

  start() {
    this.connect();
    window.addEventListener('online', this.kick);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.clearTimers();
    this.ws?.close(1000);
    this.ws = null;
  }

  /** 서버의 최신 스냅샷을 다시 요청 */
  sync() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('{"t":"sync"}');
    else this.kick();
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.retryTimer = this.pingTimer = this.pongTimer = null;
  }

  private connect() {
    if (this.stopped) return;
    this.clearTimers();
    this.onStatus('connecting');
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + this.path;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus('open');
      // 앱 수준 ping: 서버 런타임이 Object 를 깨우지 않고 바로 'pong' 으로 응답한다
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send('ping');
        if (!this.pongTimer) this.pongTimer = setTimeout(() => ws.close(4000, 'pong-timeout'), 10_000);
      }, 25_000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      try {
        this.onMessage(JSON.parse(e.data));
      } catch {
        /* 무시 */
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (STOP_CODES.has(e.code)) {
        this.stopped = true;
        this.onStatus('stopped', { code: e.code });
        return;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (this.stopped) return;
    const cap = Math.min(15_000, 500 * 2 ** this.attempt);
    const delayMs = 250 + Math.random() * cap;
    this.attempt = Math.min(this.attempt + 1, 10);
    this.onStatus('retrying', { delayMs });
    this.retryTimer = setTimeout(() => this.connect(), delayMs);
  }

  /** 네트워크 복구·화면 복귀 때 대기 중인 재시도를 앞당긴다(그래도 0~1.5초 무작위로 흩음) */
  private kick = () => {
    if (this.stopped || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), Math.random() * 1500);
  };

  private onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('{"t":"sync"}');
    else this.kick();
  };
}
