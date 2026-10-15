// tools/make-set1.mjs 가 만든 파일입니다. 고치려면 그 스크립트를 고친 뒤 다시 실행하세요.
// 문제세트 1 — 리허설용 20문항(그림 직접 제작). 서버 전용: src/ 에서 import 하지 않는다.
import type { QuestionSet } from '../bank';

export const SET1: QuestionSet = {
  id: 'set1',
  title: '문제세트 1 (리허설 20문항)',
  questions: [
    {
      "id": "s1-q01",
      "prompt": "별은 몇 개일까요?",
      "image": "/media/s1/07219a47.svg",
      "imageAlt": "별 그림",
      "timeLimitSec": 20,
      "answerDisplay": "5개",
      "accepted": [
        "5",
        "5개",
        "다섯",
        "다섯개",
        "다섯 개"
      ],
      "explanation": "위에 3개, 아래에 2개 — 모두 5개예요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "4개",
        "6개"
      ]
    },
    {
      "id": "s1-q02",
      "prompt": "하트는 몇 개일까요?",
      "image": "/media/s1/50038660.svg",
      "imageAlt": "하트 그림",
      "timeLimitSec": 20,
      "answerDisplay": "7개",
      "accepted": [
        "7",
        "7개",
        "일곱",
        "일곱개",
        "일곱 개"
      ],
      "explanation": "위에 4개, 아래에 3개 — 모두 7개예요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "6개",
        "8개"
      ]
    },
    {
      "id": "s1-q03",
      "prompt": "몇 시일까요?",
      "image": "/media/s1/c5600ec0.svg",
      "imageAlt": "시계",
      "timeLimitSec": 20,
      "answerDisplay": "9시",
      "accepted": [
        "9시",
        "아홉시",
        "아홉 시",
        "9:00"
      ],
      "explanation": "짧은 바늘이 9, 긴 바늘이 12 — 정각 9시예요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "3시",
        "12시 45분"
      ]
    },
    {
      "id": "s1-q04",
      "prompt": "몇 시 몇 분일까요?",
      "image": "/media/s1/725e1919.svg",
      "imageAlt": "시계",
      "timeLimitSec": 20,
      "answerDisplay": "6시 30분",
      "accepted": [
        "6시 30분",
        "6시 반",
        "여섯시 반",
        "여섯 시 반",
        "6:30",
        "여섯시 삼십분",
        "여섯 시 삼십 분"
      ],
      "explanation": "긴 바늘이 6을 가리키면 30분. 짧은 바늘은 6과 7 사이 — 6시 30분(6시 반)이에요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "7시 30분",
        "6시"
      ]
    },
    {
      "id": "s1-q05",
      "prompt": "이 도형의 이름은?",
      "image": "/media/s1/183b11fd.svg",
      "imageAlt": "꼭짓점이 있는 도형",
      "timeLimitSec": 20,
      "answerDisplay": "오각형",
      "accepted": [
        "오각형",
        "5각형"
      ],
      "explanation": "변과 꼭짓점이 5개 — 오각형이에요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "육각형",
        "별"
      ]
    },
    {
      "id": "s1-q06",
      "prompt": "이 도형의 이름은?",
      "image": "/media/s1/d7dd1124.svg",
      "imageAlt": "꼭짓점이 있는 도형",
      "timeLimitSec": 20,
      "answerDisplay": "육각형",
      "accepted": [
        "육각형",
        "6각형"
      ],
      "explanation": "변과 꼭짓점이 6개 — 육각형이에요. 벌집 모양!",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "오각형",
        "팔각형"
      ]
    },
    {
      "id": "s1-q07",
      "prompt": "무슨 색일까요?",
      "image": "/media/s1/362377b8.svg",
      "imageAlt": "색칠한 원",
      "timeLimitSec": 20,
      "answerDisplay": "빨강",
      "accepted": [
        "빨강",
        "빨간색",
        "빨강색",
        "빨간",
        "적색"
      ],
      "explanation": "빨강(빨간색)이에요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "주황",
        "분홍"
      ]
    },
    {
      "id": "s1-q08",
      "prompt": "무슨 색일까요?",
      "image": "/media/s1/779c523d.svg",
      "imageAlt": "색칠한 원",
      "timeLimitSec": 20,
      "answerDisplay": "파랑",
      "accepted": [
        "파랑",
        "파란색",
        "파랑색",
        "파란",
        "청색"
      ],
      "explanation": "파랑(파란색)이에요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "남색",
        "보라"
      ]
    },
    {
      "id": "s1-q09",
      "prompt": "무슨 색일까요?",
      "image": "/media/s1/dd3c28ac.svg",
      "imageAlt": "색칠한 원",
      "timeLimitSec": 20,
      "answerDisplay": "초록",
      "accepted": [
        "초록",
        "초록색",
        "녹색"
      ],
      "explanation": "초록(녹색)이에요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "연두",
        "파랑"
      ]
    },
    {
      "id": "s1-q10",
      "prompt": "모두 몇 개일까요?",
      "image": "/media/s1/8e013b45.svg",
      "imageAlt": "사과 덧셈 그림",
      "timeLimitSec": 20,
      "answerDisplay": "5개",
      "accepted": [
        "5",
        "5개",
        "다섯",
        "다섯개",
        "다섯 개"
      ],
      "explanation": "2개 + 3개 = 5개예요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "6개",
        "4개"
      ]
    },
    {
      "id": "s1-q11",
      "prompt": "? 에 들어갈 수는?",
      "image": "/media/s1/d2505a8e.svg",
      "imageAlt": "수 배열",
      "timeLimitSec": 20,
      "answerDisplay": "8",
      "accepted": [
        "8",
        "팔",
        "여덟"
      ],
      "explanation": "2씩 커져요: 2 → 4 → 6 → 8",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "10",
        "7"
      ]
    },
    {
      "id": "s1-q12",
      "prompt": "? 에 들어갈 수는?",
      "image": "/media/s1/0b41f31e.svg",
      "imageAlt": "수 배열",
      "timeLimitSec": 20,
      "answerDisplay": "7",
      "accepted": [
        "7",
        "칠",
        "일곱"
      ],
      "explanation": "홀수가 차례로 나와요: 1 → 3 → 5 → 7",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "6",
        "9"
      ]
    },
    {
      "id": "s1-q13",
      "prompt": "? 에 들어갈 수는?",
      "image": "/media/s1/edbf4439.svg",
      "imageAlt": "수 배열",
      "timeLimitSec": 20,
      "answerDisplay": "12",
      "accepted": [
        "12",
        "십이",
        "열두"
      ],
      "explanation": "3씩 커져요: 3 → 6 → 9 → 12",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "11",
        "15"
      ]
    },
    {
      "id": "s1-q14",
      "prompt": "지금 신호는 무슨 뜻일까요?",
      "image": "/media/s1/4a75d6b2.svg",
      "imageAlt": "신호등",
      "timeLimitSec": 20,
      "answerDisplay": "멈춤",
      "accepted": [
        "멈춤",
        "정지",
        "멈추시오",
        "서시오",
        "멈춰",
        "빨간불"
      ],
      "explanation": "빨간불은 멈추라는 신호예요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "출발",
        "조심"
      ]
    },
    {
      "id": "s1-q15",
      "prompt": "무지개는 몇 가지 색일까요?",
      "image": "/media/s1/b4ea51c0.svg",
      "imageAlt": "무지개",
      "timeLimitSec": 20,
      "answerDisplay": "7가지",
      "accepted": [
        "7",
        "7가지",
        "7개",
        "일곱",
        "일곱가지",
        "일곱 가지",
        "7색"
      ],
      "explanation": "빨주노초파남보 — 7가지 색이에요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "6가지",
        "5가지"
      ]
    },
    {
      "id": "s1-q16",
      "prompt": "주사위 눈은 몇일까요?",
      "image": "/media/s1/3d973441.svg",
      "imageAlt": "주사위",
      "timeLimitSec": 20,
      "answerDisplay": "4",
      "accepted": [
        "4",
        "넷",
        "사",
        "4개"
      ],
      "explanation": "점이 4개 — 4예요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "5",
        "3"
      ]
    },
    {
      "id": "s1-q17",
      "prompt": "가장 큰 원은 어느 것일까요?",
      "image": "/media/s1/7b41c057.svg",
      "imageAlt": "크기가 다른 원 세 개",
      "timeLimitSec": 20,
      "answerDisplay": "나",
      "accepted": [
        "나",
        "나번",
        "(나)"
      ],
      "explanation": "가운데 \"나\"가 가장 커요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "다",
        "가"
      ]
    },
    {
      "id": "s1-q18",
      "prompt": "화살표는 어느 쪽을 가리킬까요?",
      "image": "/media/s1/d724856f.svg",
      "imageAlt": "화살표",
      "timeLimitSec": 20,
      "answerDisplay": "오른쪽",
      "accepted": [
        "오른쪽",
        "우측",
        "오른편",
        "동쪽"
      ],
      "explanation": "뾰족한 끝이 오른쪽을 향해요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "왼쪽",
        "위쪽"
      ]
    },
    {
      "id": "s1-q19",
      "prompt": "삼각형은 몇 개일까요?",
      "image": "/media/s1/faa06cc1.svg",
      "imageAlt": "도형 여러 개",
      "timeLimitSec": 20,
      "answerDisplay": "4개",
      "accepted": [
        "4",
        "4개",
        "네개",
        "네 개",
        "넷"
      ],
      "explanation": "노란 삼각형이 위에 3개, 아래에 1개 — 모두 4개예요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "3개",
        "5개"
      ]
    },
    {
      "id": "s1-q20",
      "prompt": "이것은 무엇일까요?",
      "image": "/media/s1/5c79d800.svg",
      "imageAlt": "밤하늘 그림",
      "timeLimitSec": 20,
      "answerDisplay": "달",
      "accepted": [
        "달",
        "초승달",
        "그믐달"
      ],
      "explanation": "밤하늘에 뜬 초승달이에요.",
      "rules": {
        "ignoreSpaces": true,
        "caseInsensitive": true
      },
      "decoys": [
        "바나나",
        "해"
      ]
    }
  ],
};
