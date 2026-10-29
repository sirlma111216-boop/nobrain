import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** 참가자 입장 주소. QR 로 들어오면 행사 코드가 미리 채워진다. */
export const joinUrlFor = (ev: string) => `${location.origin}/?e=${ev}`;

/** 글자 → QR 이미지(data: URL). 전광판·진행자 화면이 같이 쓴다. */
export function useQr(text: string) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: 720, errorCorrectionLevel: 'M' }).then(setSrc).catch(() => setSrc(''));
  }, [text]);
  return src;
}
