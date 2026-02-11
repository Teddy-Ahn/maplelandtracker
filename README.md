# 메이플랜드 트래커 (메트지지)

maplelandtracker.gg · 경험치 측정 등 메이플랜드 보조 기능을 제공하는 웹 앱입니다.

---

## 주요 기능

- **화면 공유** → 게임 화면 스트림 획득
- **영역 지정** → 경험치가 보이는 구역을 드래그로 선택 (자동 감지 지원)
- **OCR 측정** → 선택 영역을 Tesseract.js로 읽어 경험치·진행률 파싱
- **실시간 측정** → 경과 시간, 획득 경험치, EXP/h, 5·10·30·60분 구간 표시
- **PIP 모드** → 작은 창에서도 측정 조작·확인 가능
- **일시정지/재개** → 타이머·OCR 중단 후 이어서 측정
- **일시정지 중 경험치** → 재개 시 일시정지 동안 오른 경험치는 현재 옆 (+N)으로만 표시, 획득·EXP/h에서 제외

---

## 실행 방법

### 1. 의존성 설치 (최초 1회)

프로젝트 루트에서:

```bash
npm install
```

- `package.json` 에 적힌 라이브러리(react, react-dom, vite 등)가 `node_modules/` 에 설치됩니다.
- 서버 개발할 때의 “패키지 설치”와 같은 개념입니다.

### 2. 개발 서버 실행

```bash
npm run dev
```

- Vite 개발 서버가 뜹니다.
- 터미널에 나오는 주소(보통 `http://localhost:5173`)로 브라우저에서 접속하면 됩니다.
- 코드를 수정하면 **저장만 해도 브라우저가 자동으로 갱신**됩니다 (Hot Module Replacement).

### 3. 빌드 (배포용 파일 만들기)

```bash
npm run build
```

- `dist/` 폴더에 HTML, CSS, JS가 한 덩어리로 빌드됩니다.
- 이 폴더를 웹 서버에 올리면 실제 서비스할 수 있습니다.

### 4. 빌드 결과 미리 보기

```bash
npm run preview
```

- `dist/` 내용을 로컬에서 서빙해서, 배포 전에 확인할 때 씁니다.

---

## 프로젝트 구조 (프론트 초보용 설명)

```
maplelandtracker/
├── index.html          # 진입 HTML. <div id="root"> + main.jsx 로딩
├── package.json        # 스크립트(npm run dev 등), 의존성 목록
├── vite.config.js      # Vite 설정
├── public/             # 정적 파일 (favicon.svg 등)
├── src/
│   ├── main.jsx        # 진입점. React 앱을 #root 에 마운트
│   ├── App.jsx         # 루트 컴포넌트
│   ├── App.css, index.css
│   └── components/
│       ├── ExpTracker.jsx   # 경험치 측정 (화면 공유, OCR, PIP, 일시정지 등)
│       └── ExpTracker.css
├── exp-tracker-steps.md    # 구현 단계 체크리스트 (완료)
└── README.md
```

### 흐름 요약

1. **index.html**  
   브라우저가 이 파일을 연다 → `<script type="module" src="/src/main.jsx">` 로 **main.jsx** 를 불러온다.

2. **main.jsx**  
   `document.getElementById('root')` 로 HTML의 빈 div를 찾고, 그 안에 **App** 컴포넌트를 렌더링한다.

3. **App.jsx**  
   화면 전체 레이아웃(헤더, 메인)을 그리고, 메인 안에 **ExpTracker** 같은 자식 컴포넌트를 넣는다.

4. **components/***  
   버튼, 카드, 경험치 측정 UI처럼 **재사용 가능한 조각**을 여기 두고, `App.jsx` 나 다른 컴포넌트에서 `import` 해서 쓴다.

- **CSS**  
  - `index.css`: 전체 공통 스타일  
  - `App.css`: App 전용. 다른 컴포넌트는 각자 `.css` 를 만들고 해당 jsx에서 `import` 하면 됨.

---

## 사용 기술

- **React 18** (UI 라이브러리)
- **Vite** (개발 서버 + 빌드)
- **JavaScript (JSX)** — 나중에 TypeScript로 바꿀 수 있음

---

## 개발 백로그 (선택)

- 해상도 제한 안내, OCR·캡처 최적화
- 5/10/30/60분 구간 UI 개선, 캡처 애니메이션
- 프리셋 영역(해상도별 자동 영역), 단축키 등

---

이제 `npm install` 후 `npm run dev` 로 실행해 보시면 됩니다.
