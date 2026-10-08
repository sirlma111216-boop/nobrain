import { useEffect, useState } from 'react';

// 서버가 보낸 now 와 기기 시계의 차이. 타이머는 서버의 종료 시각(endsAt)을 기준으로 기기에서 그린다.
let offset = 0;
export function syncClock(serverNow: number) {
  offset = serverNow - Date.now();
}
export function serverNow() {
  return Date.now() + offset;
}

/** 남은 초(올림). active 일 때만 주기적으로 다시 그린다. */
export function useRemaining(endsAt: number | null | undefined, active: boolean): number | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active || !endsAt) return;
    const id = setInterval(() => force((x) => x + 1), 200);
    return () => clearInterval(id);
  }, [active, endsAt]);
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
}
