/**
 * ExpTracker - 경험치 측정 (1~6번 구현)
 * 화면 공유 → 영역 선택 → OCR → OK → START → 실시간 타이머·EXP/h
 *
 * [나중에 적용]
 * - 해상도 제한: 특정 해상도 내에서만 측정 (너무 작으면 숫자 픽셀 깨져 OCR 불리)
 * - 프리셋 영역: 비율/해상도가 고정이면 경험치 위치를 미리 정의해 두고, 네모 그리기 생략 가능
 */
import { useState, useRef, useEffect } from 'react'
import './ExpTracker.css'

// Tesseract는 지연 로딩 (import('tesseract.js')) — 초기 번들·로딩 경감

/**
 * "23,456,789[45.03%]" 형태에서
 * - [] 앞 숫자 → 경험치 (쉼표 제거 후 정수)
 * - [] 안 숫자 → 진행률 퍼센트 (소수 가능)
 */
// [나중에] 허용 해상도 제한 시 사용. null = 테스트용 전체 허용
const ALLOWED_RESOLUTIONS = null // 예: [{ w: 1920, h: 1080 }, { w: 1280, h: 720 }] 또는 { minW: 1280, minH: 720 }

// [나중에] 해상도별 경험치 영역 프리셋 (비율 고정이면 네모 그리기 생략 가능)
const EXP_REGION_PRESETS = null // 예: { '1920x1080': { x: 100, y: 900, w: 300, h: 40 }, ... }

function parseExpAndPercent(text) {
  if (!text || typeof text !== 'string') return { exp: null, percent: null }
  const trimmed = text.trim()
  // [] 안 진행률: [45.03%] 또는 [45.03] → 퍼센트만 사용 (경험치로 쓰지 않음)
  const percentMatch = trimmed.match(/\[([\d.]+)%?\]/)
  const percent = percentMatch ? parseFloat(percentMatch[1]) : null
  // [] 앞 부분에서 경험치 후보: 1000 미만이면 퍼센트와 혼동 가능하므로 제외 (화면이 작을 때 [] 안 숫자가 경험치로 잡히는 것 방지)
  const beforeBracket = trimmed.includes('[') ? trimmed.slice(0, trimmed.indexOf('[')) : trimmed
  const expStr = beforeBracket.replace(/\s|,/g, '')
  const allNumbers = [...expStr.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10))
  const expCandidates = allNumbers.filter((n) => n >= 1000)
  const exp = expCandidates.length > 0 ? Math.max(...expCandidates) : (allNumbers.length > 0 ? Math.max(...allNumbers) : null)
  return { exp, percent }
}

function ExpTracker() {
  // 1번: 화면 공유
  const [stream, setStream] = useState(null)
  const [error, setError] = useState(null)
  const [videoVisibleForCapture, setVideoVisibleForCapture] = useState(false) // 캡처 직전에만 잠깐 표시 (검은 화면 방지)
  const [showShareGuideModal, setShowShareGuideModal] = useState(false) // 화면 공유 전 안내 팝업
  const videoRef = useRef(null)
  const overlayCanvasRef = useRef(null)

  // 3번: 영역 선택 (캡처한 한 프레임 위에서만 지정, 공유 화면은 항상 숨김)
  const [showSnapshot, setShowSnapshot] = useState(false) // 캡처 프레임 + 영역 지정 UI 표시 여부
  const [selection, setSelection] = useState(null) // { x, y, w, h } (스냅샷 캔버스 좌표)
  const [isDrawing, setIsDrawing] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)
  const drawStartRef = useRef(null)
  const snapshotCanvasRef = useRef(null)
  const snapshotDimensionsRef = useRef(null) // { w, h } - 캡처 프레임 크기 (좌표 변환용)
  const captureCropRef = useRef(null) // 캡처 시 비디오에서 잘라낸 영역 (하단 10%, 가운데 1/3) { x, y, w, h } 비디오 픽셀
  const selectionVideoRef = useRef(null) // START 시 스냅샷 선택 영역을 비디오 픽셀로 변환해 저장 { x, y, w, h } — 측정 중 OCR은 이 영역만 사용

  // 4~5번: 경험치·OK·START
  const [currentExp, setCurrentExp] = useState(null)
  const [currentExpPercent, setCurrentExpPercent] = useState(null) // [] 안 진행률 (45.03 등)
  const [isReading, setIsReading] = useState(false)
  const [confirmedExp, setConfirmedExp] = useState(null) // OK 시 확정
  const [showStart, setShowStart] = useState(false)

  // 6번: 측정 중
  const [isRunning, setIsRunning] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [startTime, setStartTime] = useState(null)
  const [startExp, setStartExp] = useState(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [expGained, setExpGained] = useState(0)
  const [expPerHour, setExpPerHour] = useState(0)
  const [totalExpGainedDuringPause, setTotalExpGainedDuringPause] = useState(0) // 일시정지 중 오른 경험치(획득에서 제외, 현재 옆에 +N 표시)
  const [milestoneExp, setMilestoneExp] = useState({ 300: null, 600: null, 1800: null, 3600: null })
  const intervalRef = useRef(null)
  const latestCurrentExpRef = useRef(null)
  const pausedAtExpRef = useRef(null) // 일시정지 시점의 currentExp (재개 시 비교용)
  const timerRef = useRef(null)
  const captureDisplaySizeRef = useRef(null)
  // 탭 전환 후에도 측정 유지: 무음 재생으로 백그라운드 탭 스로틀 완화
  const silentAudioRef = useRef(null)
  // PIP: 작은 창에 측정 결과 표시 (aprud.me 스타일)
  const pipWindowRef = useRef(null)
  const pipPreStateRef = useRef(null)
  const pipUpdateNowRef = useRef(null)
  const milestoneExpRef = useRef(milestoneExp)
  const pipUpdateIntervalRef = useRef(null)
  const latestStatsRef = useRef({})
  const lastOcrResultRef = useRef({ exp: null, percent: null })
  const lastOcrTimeRef = useRef(0)
  const ocrInFlightRef = useRef(false)
  const ocrLoopRunningRef = useRef(false)
  const ocrRafIdRef = useRef(null)
  // 크롭 캔버스 캐시 (aprud.me cropRegion 캐시 — 메모리·성능)
  const cropCanvasCacheRef = useRef(new Map())
  // OCR 리사이즈용 캔버스 캐시 (MAX_OCR_PX 기준 small 캔버스, 크기별 재사용)
  const ocrResizeCanvasCacheRef = useRef(new Map())
  const OCR_RESIZE_CACHE_MAX = 3
  // Tesseract 지연 로딩 + 워커 재사용
  const tesseractModuleRef = useRef(null)
  const tesseractWorkerRef = useRef(null)
  // PIP 창에 표시할 단계/버튼 상태 (PIP이 먼저 열려도 단계별 UI 표시)
  const pipStateRef = useRef({ step: 2, hint: '', canReadExp: false, canOk: false, canStart: false, currentExp: null, confirmedExp: null, isRunning: false })
  // PIP 일시정지 버튼: 클릭 시점에 이 ref를 읽어 PAUSE/RESUME 전달 (타이밍 이슈 방지)
  const pipPauseResumeActionRef = useRef('PAUSE')
  // 자동 경험치 읽기/OK 플래그 (다시 측정하기 전용)
  const autoReadDoneRef = useRef(false)
  const autoOkDoneRef = useRef(false)
  const autoFlowRef = useRef(false)

  // 스트림을 video 요소에 연결
  useEffect(() => {
    if (!videoRef.current || !stream) return
    videoRef.current.srcObject = stream
  }, [stream])

  // 해상도 변경 시 안내 (aprud.me: 전체화면/창 전환 시 재감지)
  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return
    const handleResize = () => {
      const w = video.videoWidth
      const h = video.videoHeight
      if (w > 0 && h > 0 && captureCropRef.current != null && (captureCropRef.current.w !== w || captureCropRef.current.h !== h)) {
        setError('해상도가 변경되었습니다. 「다시 캡처」를 눌러 주세요.')
      }
    }
    video.addEventListener('resize', handleResize)
    return () => video.removeEventListener('resize', handleResize)
  }, [stream])

  // 공유 선택 직후 자동으로 한 프레임 캡처 후 스냅샷 화면 표시
  useEffect(() => {
    if (!stream) return
    const video = videoRef.current
    const onReady = () => setShowSnapshot(true)
    if (video && video.readyState >= 2) {
      const t = setTimeout(onReady, 300)
      return () => clearTimeout(t)
    }
    if (video) {
      video.addEventListener('loadeddata', onReady, { once: true })
      const t = setTimeout(onReady, 1500)
      return () => {
        video.removeEventListener('loadeddata', onReady)
        clearTimeout(t)
      }
    }
  }, [stream])

  // 스트림 해제
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop())
      }
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [stream])

  // 언마운트 시 OCR 워커 정리
  useEffect(() => {
    return () => {
      if (tesseractWorkerRef.current) {
        try {
          tesseractWorkerRef.current.terminate()
        } catch (_) {}
        tesseractWorkerRef.current = null
      }
    }
  }, [])

  // 1번: 화면 공유 시작
  const startScreenShare = async () => {
    setError(null)
    // 보안 컨텍스트: localhost 또는 HTTPS 에서만 동작
    if (!window.isSecureContext) {
      setError(
        '화면 공유는 보안 연결에서만 사용할 수 있습니다. 주소창이 https:// 이거나 http://localhost 로 열려 있는지 확인하세요. (파일로 직접 열면 안 됩니다.)'
      )
      return
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError(
        '이 브라우저는 화면 공유를 지원하지 않습니다. Chrome, Edge, Firefox 최신 버전에서 http://localhost:5173 으로 접속해 보세요.'
      )
      return
    }
    try {
      // 참조 사이트(aprud.me)와 동일: cursor 숨김, 3fps, 최대 1920x1080
      let mediaStream
      try {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: 'never',
            frameRate: { ideal: 3, max: 3 },
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
          },
          audio: false,
        })
      } catch (_) {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      }
      setStream(mediaStream)
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream
      }
      // 사용자가 브라우저 UI에서 화면 공유를 직접 중지한 경우도 초기 상태로 복귀
      mediaStream.getTracks().forEach((track) => {
        track.onended = () => stopScreenShare()
        track.oninactive = () => stopScreenShare()
      })
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        setError('화면 공유를 취소하셨거나 허용되지 않았습니다.')
      } else {
        setError(e.message || '화면 공유를 시작할 수 없습니다.')
      }
    }
  }

  const stopScreenShare = () => {
    stopSilentAudio()
    if (pipUpdateIntervalRef.current) {
      clearInterval(pipUpdateIntervalRef.current)
      pipUpdateIntervalRef.current = null
    }
    if (ocrRafIdRef.current && videoRef.current?.cancelVideoFrameCallback) {
      videoRef.current.cancelVideoFrameCallback(ocrRafIdRef.current)
      ocrRafIdRef.current = null
    }
    ocrLoopRunningRef.current = false
    if (pipWindowRef.current && !pipWindowRef.current.closed) {
      pipWindowRef.current.close()
      pipWindowRef.current = null
    }
    setShowSnapshot(false)
    snapshotDimensionsRef.current = null
    captureCropRef.current = null
    selectionVideoRef.current = null
    captureDisplaySizeRef.current = null
    if (stream) {
      const tracks = stream.getTracks()
      tracks.forEach((t) => {
        t.stop()
        stream.removeTrack(t)
      })
      setStream(null)
    }
    const video = videoRef.current
    if (video) {
      video.pause()
      video.srcObject = null
      video.load()
    }
    cropCanvasCacheRef.current.forEach((cached) => {
      if (cached.canvas) {
        cached.ctx = null
        cached.canvas.width = 0
        cached.canvas.height = 0
      }
    })
    cropCanvasCacheRef.current.clear()
    ocrResizeCanvasCacheRef.current.clear()
    setSelection(null)
    setCurrentExp(null)
    setCurrentExpPercent(null)
    setConfirmedExp(null)
    setShowStart(false)
    setIsRunning(false)
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    terminateOcrWorker()
  }

  const getTesseract = async () => {
    if (tesseractModuleRef.current) return tesseractModuleRef.current
    const Tesseract = (await import('tesseract.js')).default
    tesseractModuleRef.current = Tesseract
    return Tesseract
  }

  const ensureOcrWorker = async () => {
    if (tesseractWorkerRef.current) return tesseractWorkerRef.current
    const Tesseract = await getTesseract()
    const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
    await worker.initialize('eng')
    tesseractWorkerRef.current = worker
    return worker
  }

  const terminateOcrWorker = () => {
    if (tesseractWorkerRef.current) {
      try {
        tesseractWorkerRef.current.terminate()
      } catch (_) {}
      tesseractWorkerRef.current = null
    }
  }

  // 화면 공유 시 하단 영역·가운데 1/3만 캡처. 저해상도에서는 영역 넓히고 스냅샷 확대해 OCR 인식률 확보
  const captureFrameToSnapshot = async () => {
    const snap = snapshotCanvasRef.current
    const overlay = overlayCanvasRef.current
    const video = videoRef.current
    if (!snap || !overlay || !stream) return

    const maxW = 1280
    const MIN_SNAP_WIDTH = 480 // 저해상도에서도 Tesseract가 읽을 수 있도록 최소 너비
    const CROP_MIDDLE_THIRD = 1 / 3
    let vw, vh
    let usedImageCapture = false

    const track = stream.getVideoTracks()[0]
    if (track && typeof ImageCapture !== 'undefined') {
      try {
        const imageCapture = new ImageCapture(track)
        const imageBitmap = await imageCapture.grabFrame()
        vw = imageBitmap.width
        vh = imageBitmap.height
        const isLowRes = vh < 600
        const cropBottomRatio = isLowRes ? 0.2 : 0.1
        const cropX = Math.floor(vw * CROP_MIDDLE_THIRD)
        const cropY = Math.floor(vh * (1 - cropBottomRatio))
        const cropW = Math.floor(vw * CROP_MIDDLE_THIRD)
        const cropH = vh - cropY
        const sw = cropW < MIN_SNAP_WIDTH ? MIN_SNAP_WIDTH : Math.min(maxW, cropW)
        const sh = Math.round(cropH * (sw / cropW))
        snap.width = sw
        snap.height = sh
        snap.getContext('2d').drawImage(imageBitmap, cropX, cropY, cropW, cropH, 0, 0, sw, sh)
        captureCropRef.current = { x: cropX, y: cropY, w: cropW, h: cropH }
        imageBitmap.close()
        usedImageCapture = true
      } catch (_) {}
    }

    if (!usedImageCapture && video) {
      setVideoVisibleForCapture(true)
      await new Promise((r) => setTimeout(r, 600))
      if (video.readyState >= 2) {
        vw = video.videoWidth
        vh = video.videoHeight
        const isLowRes = vh < 600
        const cropBottomRatio = isLowRes ? 0.2 : 0.1
        const cropX = Math.floor(vw * CROP_MIDDLE_THIRD)
        const cropY = Math.floor(vh * (1 - cropBottomRatio))
        const cropW = Math.floor(vw * CROP_MIDDLE_THIRD)
        const cropH = vh - cropY
        const sw = cropW < MIN_SNAP_WIDTH ? MIN_SNAP_WIDTH : Math.min(maxW, cropW)
        const sh = Math.round(cropH * (sw / cropW))
        snap.width = sw
        snap.height = sh
        snap.getContext('2d').drawImage(video, cropX, cropY, cropW, cropH, 0, 0, sw, sh)
        captureCropRef.current = { x: cropX, y: cropY, w: cropW, h: cropH }
      }
      setVideoVisibleForCapture(false)
    }

    overlay.width = snap.width
    overlay.height = snap.height
    snapshotDimensionsRef.current = { w: snap.width, h: snap.height }
    setSelection(null)
  }

  // 스냅샷 UI가 떴을 때 한 프레임 캡처 후, 경험치 영역 자동 감지 (네모 그리기 없이 최적 영역 사용)
  useEffect(() => {
    if (!showSnapshot || !stream) return
    let cancelled = false
    const run = async () => {
      await new Promise((r) => setTimeout(r, 200))
      if (cancelled) return
      await captureFrameToSnapshot()
      if (cancelled) return
      const region = await detectExpRegion()
      if (cancelled || !region) return
      setSelection(region)
    }
    run()
    return () => { cancelled = true }
  }, [showSnapshot, stream])

  // 3번: 사각형 그리기 (드래그)
  const getCanvasPoint = (e) => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const onCanvasMouseDown = (e) => {
    const p = getCanvasPoint(e)
    if (!p) return
    setIsDrawing(true)
    drawStartRef.current = p
    setSelection(null)
  }

  const onCanvasMouseMove = (e) => {
    if (!isDrawing || !drawStartRef.current) return
    const p = getCanvasPoint(e)
    if (!p) return
    const sx = drawStartRef.current.x
    const sy = drawStartRef.current.y
    const x = Math.min(sx, p.x)
    const y = Math.min(sy, p.y)
    const w = Math.abs(p.x - sx)
    const h = Math.abs(p.y - sy)
    setSelection({ x, y, w, h })
    drawSelectionRect({ x, y, w, h })
  }

  const onCanvasMouseUp = () => {
    setIsDrawing(false)
    drawStartRef.current = null
  }

  // 영역이 바뀌면 자동 읽기/OK 다시 시도할 수 있게 플래그 초기화
  useEffect(() => {
    autoReadDoneRef.current = false
    autoOkDoneRef.current = false
  }, [selection])

  const drawSelectionRect = (sel) => {
    const canvas = overlayCanvasRef.current
    if (!canvas || !sel) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (sel.w > 0 && sel.h > 0) {
      ctx.strokeStyle = '#00ff00'
      ctx.lineWidth = 2
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h)
    }
  }

  // 선택 영역 그리기 유지
  useEffect(() => {
    if (selection && overlayCanvasRef.current) {
      drawSelectionRect(selection)
    }
  }, [selection])

  // EXP 텍스트 + 숫자 + [%] 포함 영역 반환. 저해상도에서도 인식되도록 관대한 조건 + 필요 시 2배 확대 OCR
  const detectExpRegion = async () => {
    const snap = snapshotCanvasRef.current
    const video = videoRef.current
    if (snap && snap.width > 0 && snap.height > 0) {
      const worker = await ensureOcrWorker()
      const runOcr = (source) =>
        worker.recognize(source, {
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,[]% ',
          tessedit_pageseg_mode: 6,
        }).then((r) => r.data?.words ?? [])

      const cw = snap.width
      const ch = snap.height
      let words = await runOcr(snap)
      let scale = 1
      if (words.length === 0 && (cw < 400 || ch < 60)) {
        const up = document.createElement('canvas')
        up.width = cw * 2
        up.height = ch * 2
        const ctx = up.getContext('2d')
        ctx.drawImage(snap, 0, 0, cw, ch, 0, 0, up.width, up.height)
        words = await runOcr(up)
        scale = 2
      }

      const expWord = words.find((w) => /^EXP\.?$/i.test((w.text || '').trim()))
      if (!expWord?.bbox) return null

      const b = (v) => (typeof v === 'number' ? v / scale : v)
      const x0 = b(expWord.bbox.x0)
      const y0 = b(expWord.bbox.y0)
      const x1 = b(expWord.bbox.x1)
      const y1 = b(expWord.bbox.y1)
      let right = x1
      let top = y0
      let bottom = y1
      const expCenterY = (y0 + y1) / 2
      const lineTolerance = Math.max((y1 - y0) * 2.5, 28)
      const expLineWords = []
      for (const w of words) {
        if (!w.bbox) continue
        const wx0 = b(w.bbox.x0)
        const wy0 = b(w.bbox.y0)
        const wx1 = b(w.bbox.x1)
        const wy1 = b(w.bbox.y1)
        const txt = (w.text || '').trim()
        if (wx0 < x1 - 5) continue
        if (Math.abs((wy0 + wy1) / 2 - expCenterY) > lineTolerance) continue
        if (!/[\d\[\]%]/.test(txt)) continue
        if (!/^[\d,.\[\]%\s]+$/.test(txt)) continue
        expLineWords.push({ ...w, bbox: { x0: wx0, y0: wy0, x1: wx1, y1: wy1 } })
      }
      const percentEndWord = expLineWords.find((w) => (w.text || '').includes(']'))
      if (percentEndWord?.bbox) {
        right = percentEndWord.bbox.x1
        top = Math.min(top, percentEndWord.bbox.y0)
        bottom = Math.max(bottom, percentEndWord.bbox.y1)
      } else {
        for (const w of expLineWords) {
          if (w.bbox.x1 > right) right = w.bbox.x1
          top = Math.min(top, w.bbox.y0)
          bottom = Math.max(bottom, w.bbox.y1)
        }
      }
      for (const w of expLineWords) {
        if (w.bbox.x1 <= right) {
          top = Math.min(top, w.bbox.y0)
          bottom = Math.max(bottom, w.bbox.y1)
        }
      }
      if (percentEndWord == null && expLineWords.length === 0) {
        right = Math.min(cw - 2, x1 + Math.min(200, Math.floor(cw * 0.5)))
      }
      const pad = 6
      const rx = Math.max(0, x0 - 4)
      const ry = Math.max(0, top - 4)
      const rw = Math.min(cw - rx, right - rx + pad)
      const rh = Math.min(ch - ry, bottom - ry + pad)
      if (rw < 40 || rh < 8) return null
      return { x: rx, y: ry, w: rw, h: rh }
    }
    if (!video || video.readyState < 2) return null
    const vw = video.videoWidth
    const vh = video.videoHeight
    const cropY = Math.floor(vh * 0.58)
    const cropH = vh - cropY
    if (cropH < 40) return null
    const crop = document.createElement('canvas')
    crop.width = vw
    crop.height = cropH
    crop.getContext('2d').drawImage(video, 0, cropY, vw, cropH, 0, 0, vw, cropH)
    const worker = await ensureOcrWorker()
    const { data } = await worker.recognize(crop, {
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,[]% ',
      tessedit_pageseg_mode: 6,
    })
    const words = data?.words ?? []
    const expWord = words.find((w) => /^EXP\.?$/i.test((w.text || '').trim()))
    if (!expWord?.bbox) return null
    const { x0, y0, x1, y1 } = expWord.bbox
    const pad = 8
    const rx = Math.min(x1 + pad, vw - 50)
    const rw = Math.min(450, vw - rx)
    const ry = Math.max(0, y0 - 4)
    const rh = Math.min(70, cropH - ry, (y1 - y0) + 24)
    if (rw < 80 || rh < 15) return null
    return { x: rx, y: cropY + ry, w: rw, h: rh }
  }

  const runAutoDetect = async () => {
    const overlay = overlayCanvasRef.current
    if (!overlay) return
    setIsDetecting(true)
    setError(null)
    setSelection(null)
    try {
      const region = await detectExpRegion()
      if (region) {
        const snap = snapshotCanvasRef.current
        if (snap && snap.width > 0) {
          setSelection(region)
        } else {
          const video = videoRef.current
          if (video) {
            const vw = video.videoWidth
            const vh = video.videoHeight
            const dw = overlay.width
            const dh = overlay.height
            setSelection({
              x: (region.x / vw) * dw,
              y: (region.y / vh) * dh,
              w: (region.w / vw) * dw,
              h: (region.h / vh) * dh,
            })
          }
        }
      } else {
        setError('현재 해상도로는 경험치 영역을 찾기 어렵습니다. 아래에서 영역을 수동으로 드래그해 지정해 주세요.')
      }
    } finally {
      setIsDetecting(false)
    }
  }

  // 4번: 선택 영역만 캡처 후 OCR
  const captureAndOcr = async () => {
    const video = videoRef.current
    const snapshotCanvas = snapshotCanvasRef.current
    if (!video || !selection || selection.w < 5 || selection.h < 5) return null

    let crop
    let sw, sh

    if (!isRunning && snapshotCanvas && snapshotCanvas.width > 0) {
      // 영역 지정 단계: 사용자가 그린 스냅샷 캔버스에서 바로 잘라서 고화질 유지
      const sx = Math.max(0, Math.floor(selection.x))
      const sy = Math.max(0, Math.floor(selection.y))
      sw = Math.min(snapshotCanvas.width - sx, Math.ceil(selection.w))
      sh = Math.min(snapshotCanvas.height - sy, Math.ceil(selection.h))
      if (sw < 5 || sh < 5) return null
      crop = document.createElement('canvas')
      crop.width = sw
      crop.height = sh
      crop.getContext('2d').drawImage(snapshotCanvas, sx, sy, sw, sh, 0, 0, sw, sh)
    } else {
      // 측정 중: ROI만 직접 캡처 (aprud.me cropRegion 스타일) + 캔버스 캐시 재사용
      const rect = selectionVideoRef.current
      if (!rect || rect.w < 5 || rect.h < 5) return null

      const sx = Math.max(0, Math.floor(rect.x))
      const sy = Math.max(0, Math.floor(rect.y))
      sw = Math.ceil(rect.w)
      sh = Math.ceil(rect.h)
      if (sw < 5 || sh < 5) return null

      const cacheKey = `exp_${sw}_${sh}`
      let cached = cropCanvasCacheRef.current.get(cacheKey)
      if (!cached || !cached.canvas) {
        cached = {
          canvas: document.createElement('canvas'),
          ctx: null,
        }
        cached.canvas.width = sw
        cached.canvas.height = sh
        cached.ctx = cached.canvas.getContext('2d')
        cropCanvasCacheRef.current.set(cacheKey, cached)
      }

      const stream = video.srcObject
      if (stream && typeof ImageCapture !== 'undefined') {
        const track = stream.getVideoTracks()[0]
        if (track) {
          try {
            const imageCapture = new ImageCapture(track)
            const bitmap = await imageCapture.grabFrame()
            const vw = bitmap.width
            const vh = bitmap.height
            if (vw >= 10 && vh >= 10) {
              const clipSx = Math.min(sx, vw - 5)
              const clipSy = Math.min(sy, vh - 5)
              const clipW = Math.min(sw, vw - clipSx)
              const clipH = Math.min(sh, vh - clipSy)
              if (clipW >= 5 && clipH >= 5) {
                cached.ctx.drawImage(bitmap, clipSx, clipSy, clipW, clipH, 0, 0, clipW, clipH)
                crop = cached.canvas
                sw = clipW
                sh = clipH
              }
            }
            bitmap.close()
          } catch (_) {}
        }
      }

      if (!crop && video.videoWidth >= 10 && video.videoHeight >= 10) {
        const vw = video.videoWidth
        const vh = video.videoHeight
        const clipW = Math.min(sw, vw - sx)
        const clipH = Math.min(sh, vh - sy)
        if (clipW >= 5 && clipH >= 5) {
          cached.ctx.drawImage(video, sx, sy, clipW, clipH, 0, 0, clipW, clipH)
          crop = cached.canvas
          sw = clipW
          sh = clipH
        }
      }
      if (!crop) return null
    }

    // 2) OCR 입력: 화질이 너무 낮으면 인식 실패하므로 최대 400px까지 유지 (리사이즈 캔버스 캐시)
    const MAX_OCR_PX = 400
    let src = crop
    if (sw > MAX_OCR_PX || sh > MAX_OCR_PX) {
      const r = Math.min(MAX_OCR_PX / sw, MAX_OCR_PX / sh)
      const smallW = Math.round(sw * r)
      const smallH = Math.round(sh * r)
      const cacheKey = `ocr_${smallW}_${smallH}`
      const cache = ocrResizeCanvasCacheRef.current
      let cached = cache.get(cacheKey)
      if (!cached?.canvas) {
        if (cache.size >= OCR_RESIZE_CACHE_MAX) {
          const firstKey = cache.keys().next().value
          if (firstKey != null) cache.delete(firstKey)
        }
        cached = {
          canvas: document.createElement('canvas'),
          ctx: null,
        }
        cached.canvas.width = smallW
        cached.canvas.height = smallH
        cached.ctx = cached.canvas.getContext('2d')
        cache.set(cacheKey, cached)
      }
      cached.ctx.drawImage(crop, 0, 0, sw, sh, 0, 0, smallW, smallH)
      src = cached.canvas
    }

    const worker = await ensureOcrWorker()
    const { data: { text } } = await worker.recognize(src, {
      tessedit_char_whitelist: '0123456789.,[]%',
      tessedit_pageseg_mode: 7, // PSM 7 = 한 줄, 인식 속도 향상
    })
    return parseExpAndPercent(text)
  }

  const readExp = async () => {
    if (!selection) return
    setIsReading(true)
    setCurrentExp(null)
    setCurrentExpPercent(null)
    setError(null)
    try {
      const result = await captureAndOcr()
      if (result && (result.exp != null || result.percent != null)) {
        setCurrentExp(result.exp)
        setCurrentExpPercent(result.percent)
      } else {
        setError('경험치를 읽지 못했습니다. 영역을 다시 넓게 지정하거나, 다시 캡처 후 시도해 주세요.')
      }
    } finally {
      setIsReading(false)
    }
  }

  // 스냅샷 단계에서 영역이 있고 아직 값이 없으면 자동으로 한 번 읽기
  useEffect(() => {
    if (!showSnapshot || !selection || currentExp !== null || isReading) return
    if (!autoFlowRef.current) return
    if (autoReadDoneRef.current) return
    autoReadDoneRef.current = true
    readExp()
  }, [showSnapshot, selection, currentExp, isReading])

  const onOk = () => {
    if (currentExp === null) return
    setConfirmedExp(currentExp)
    setShowStart(true)
    setShowSnapshot(false)
  }

  // 값이 읽힌 뒤에는 자동으로 측정 준비 단계까지 넘기기 (OK 자동)
  useEffect(() => {
    if (!showSnapshot) return
    if (currentExp === null || showStart) return
    if (!autoFlowRef.current) return
    if (autoOkDoneRef.current) return
    autoOkDoneRef.current = true
    onOk()
    autoFlowRef.current = false
  }, [currentExp, showSnapshot, showStart])

  const startSilentAudio = () => {
    if (silentAudioRef.current) return
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      src.connect(ctx.destination)
      src.start(0)
      silentAudioRef.current = { ctx, src }
    } catch (_) {}
  }

  const stopSilentAudio = () => {
    const ref = silentAudioRef.current
    if (!ref) return
    try {
      ref.src.stop()
      ref.ctx.close()
    } catch (_) {}
    silentAudioRef.current = null
  }

  const onStart = () => {
    openPip()
    // 기존 타이머/OCR 정리 (중복·캐시 방지: 이전에 남은 interval이 있으면 제거)
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = null
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    if (ocrRafIdRef.current && videoRef.current?.cancelVideoFrameCallback) {
      videoRef.current.cancelVideoFrameCallback(ocrRafIdRef.current)
      ocrRafIdRef.current = null
    }
    ocrLoopRunningRef.current = false

    // 스냅샷 메타가 없으면 비디오 기준으로 생성
    const ensureCaptureMeta = () => {
      const video = videoRef.current
      if (!video || video.videoWidth < 10 || video.videoHeight < 10) return
      if (captureCropRef.current && snapshotDimensionsRef.current) return
      const vw = video.videoWidth
      const vh = video.videoHeight
      const isLowRes = vh < 600
      const cropBottomRatio = isLowRes ? 0.2 : 0.1
      const cropX = Math.floor(vw * (1 / 3))
      const cropY = Math.floor(vh * (1 - cropBottomRatio))
      const cropW = Math.floor(vw * (1 / 3))
      const cropH = vh - cropY
      const maxW = 1280
      const MIN_SNAP_WIDTH = 480
      const sw = cropW < MIN_SNAP_WIDTH ? MIN_SNAP_WIDTH : Math.min(maxW, cropW)
      const sh = Math.round(cropH * (sw / cropW))
      if (!captureCropRef.current) {
        captureCropRef.current = { x: cropX, y: cropY, w: cropW, h: cropH }
      }
      if (!snapshotDimensionsRef.current) {
        snapshotDimensionsRef.current = { w: sw, h: sh }
      }
    }
    ensureCaptureMeta()
    const cap = captureCropRef.current
    const snapDim = snapshotDimensionsRef.current
    if (snapDim) {
      captureDisplaySizeRef.current = { w: snapDim.w, h: snapDim.h }
    } else if (overlayCanvasRef.current?.width > 0) {
      captureDisplaySizeRef.current = { w: overlayCanvasRef.current.width, h: overlayCanvasRef.current.height }
    }
    // 측정 중에는 이 비디오 픽셀 영역만 OCR — 스냅샷 좌표를 여기서 한 번만 변환
    if (selection && cap && snapDim && snapDim.w >= 10 && snapDim.h >= 10) {
      const scaleX = cap.w / snapDim.w
      const scaleY = cap.h / snapDim.h
      selectionVideoRef.current = {
        x: cap.x + selection.x * scaleX,
        y: cap.y + selection.y * scaleY,
        w: selection.w * scaleX,
        h: selection.h * scaleY,
      }
    } else {
      selectionVideoRef.current = null
    }
    // 폴백: 캡처 크롭 정보가 없을 때도 비디오 기준으로 계산
    if (!selectionVideoRef.current && selection && videoRef.current && overlayCanvasRef.current) {
      const video = videoRef.current
      const overlay = overlayCanvasRef.current
      if (video.videoWidth > 0 && video.videoHeight > 0 && overlay.width > 0 && overlay.height > 0) {
        const scaleX = video.videoWidth / overlay.width
        const scaleY = video.videoHeight / overlay.height
        selectionVideoRef.current = {
          x: selection.x * scaleX,
          y: selection.y * scaleY,
          w: selection.w * scaleX,
          h: selection.h * scaleY,
        }
      }
    }
    startSilentAudio()
    setStartTime(Date.now())
    setStartExp(confirmedExp)
    setIsRunning(true)
    setIsPaused(false)
    setElapsedSec(0)
    setExpGained(0)
    setExpPerHour(0)
    setTotalExpGainedDuringPause(0)
    pausedAtExpRef.current = null
    // PIP 즉시 반영용 (렌더 전이라도 화면 전환)
    pipStateRef.current = {
      ...pipStateRef.current,
      isRunning: true,
      step: 6,
      showSnapshot: false,
    }
    // PIP 화면 즉시 전환 보장
    if (pipWindowRef.current && !pipWindowRef.current.closed) {
      const doc = pipWindowRef.current.document
      const stepPanel = doc.getElementById('pip-step-panel')
      const statsPanel = doc.getElementById('pip-stats')
      if (stepPanel) stepPanel.style.display = 'none'
      if (statsPanel) statsPanel.style.display = 'block'
    }

    const tick = () => {
      setElapsedSec((s) => s + 1)
    }
    timerRef.current = setInterval(tick, 1000)

    const applyOcrResult = (result) => {
      if (!result) return
      if (result.exp != null && result.exp !== lastOcrResultRef.current.exp) {
        lastOcrResultRef.current.exp = result.exp
        setCurrentExp(result.exp)
      }
      if (result.percent !== lastOcrResultRef.current.percent) {
        lastOcrResultRef.current.percent = result.percent
        setCurrentExpPercent(result.percent)
      }
    }

    const ocrLoop = async () => {
      if (!ocrLoopRunningRef.current) return
      const now = performance.now()
      if (!ocrInFlightRef.current && now - lastOcrTimeRef.current >= 1000) {
        ocrInFlightRef.current = true
        lastOcrTimeRef.current = now
        try {
          const result = await captureAndOcr()
          applyOcrResult(result)
        } finally {
          ocrInFlightRef.current = false
        }
      }
      if (videoRef.current?.requestVideoFrameCallback) {
        ocrRafIdRef.current = videoRef.current.requestVideoFrameCallback(ocrLoop)
      }
    }

    ocrLoopRunningRef.current = true
    lastOcrTimeRef.current = 0
    ocrInFlightRef.current = false
    if (videoRef.current?.requestVideoFrameCallback) {
      ocrRafIdRef.current = videoRef.current.requestVideoFrameCallback(ocrLoop)
    } else {
      const ocrInterval = async () => {
        if (!ocrLoopRunningRef.current || ocrInFlightRef.current) return
        ocrInFlightRef.current = true
        try {
          const result = await captureAndOcr()
          applyOcrResult(result)
        } finally {
          ocrInFlightRef.current = false
        }
      }
      ocrInterval()
      intervalRef.current = setInterval(ocrInterval, 1000)
    }
  }

  // 일시정지: 타이머 + OCR 둘 다 멈춤. 재개 시 그대로 이어서 측정(일시정지 동안 오른 경험치도 재개 후 첫 OCR에 반영됨).
  const onPause = () => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = null
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    if (ocrRafIdRef.current && videoRef.current?.cancelVideoFrameCallback) {
      videoRef.current.cancelVideoFrameCallback(ocrRafIdRef.current)
      ocrRafIdRef.current = null
    }
    ocrLoopRunningRef.current = false
    setIsPaused(true)
    pausedAtExpRef.current = latestCurrentExpRef.current ?? null // 재개 시 일시정지 중 오른 경험치 계산용
    // PIP에서 버튼이 즉시 "재개"로 바뀌도록 ref·PIP 동기 갱신
    pipStateRef.current = { ...pipStateRef.current, isPaused: true }
    pipPauseResumeActionRef.current = 'RESUME'
    if (pipUpdateNowRef.current) pipUpdateNowRef.current()
  }

  const onResume = () => {
    // 재개 시 기존 타이머/OCR 정리 후 새로 시작 (연타·중복 클릭 시 타이머 중복 방지)
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = null
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    if (ocrRafIdRef.current && videoRef.current?.cancelVideoFrameCallback) {
      videoRef.current.cancelVideoFrameCallback(ocrRafIdRef.current)
      ocrRafIdRef.current = null
    }
    ocrLoopRunningRef.current = false

    setIsPaused(false)
    // PIP에서 버튼이 즉시 "일시정지"로 바뀌도록 ref·PIP 동기 갱신
    pipStateRef.current = { ...pipStateRef.current, isPaused: false }
    pipPauseResumeActionRef.current = 'PAUSE'
    if (pipUpdateNowRef.current) pipUpdateNowRef.current()

    const tick = () => setElapsedSec((s) => s + 1)
    timerRef.current = setInterval(tick, 1000)

    const applyOcrResult = (result) => {
      if (!result) return
      if (result.exp != null && result.exp !== lastOcrResultRef.current.exp) {
        lastOcrResultRef.current.exp = result.exp
        setCurrentExp(result.exp)
      }
      if (result.percent !== lastOcrResultRef.current.percent) {
        lastOcrResultRef.current.percent = result.percent
        setCurrentExpPercent(result.percent)
      }
    }

    const ocrLoop = async () => {
      if (!ocrLoopRunningRef.current) return
      const now = performance.now()
      if (!ocrInFlightRef.current && now - lastOcrTimeRef.current >= 1000) {
        ocrInFlightRef.current = true
        lastOcrTimeRef.current = now
        try {
          const result = await captureAndOcr()
          applyOcrResult(result)
        } finally {
          ocrInFlightRef.current = false
        }
      }
      if (videoRef.current?.requestVideoFrameCallback) {
        ocrRafIdRef.current = videoRef.current.requestVideoFrameCallback(ocrLoop)
      }
    }

    ocrLoopRunningRef.current = true
    lastOcrTimeRef.current = 0
    ocrInFlightRef.current = false
    if (videoRef.current?.requestVideoFrameCallback) {
      ocrRafIdRef.current = videoRef.current.requestVideoFrameCallback(ocrLoop)
    } else {
      const ocrInterval = async () => {
        if (!ocrLoopRunningRef.current || ocrInFlightRef.current) return
        ocrInFlightRef.current = true
        try {
          const result = await captureAndOcr()
          applyOcrResult(result)
        } finally {
          ocrInFlightRef.current = false
        }
      }
      ocrInterval()
      intervalRef.current = setInterval(ocrInterval, 1000)
    }
  }

  const onStop = () => {
    stopSilentAudio()
    if (pipUpdateIntervalRef.current) {
      clearInterval(pipUpdateIntervalRef.current)
      pipUpdateIntervalRef.current = null
    }
    if (pipWindowRef.current && !pipWindowRef.current.closed) {
      pipWindowRef.current.close()
      pipWindowRef.current = null
    }
    setIsRunning(false)
    setIsPaused(false)
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    if (ocrRafIdRef.current && videoRef.current?.cancelVideoFrameCallback) {
      videoRef.current.cancelVideoFrameCallback(ocrRafIdRef.current)
      ocrRafIdRef.current = null
    }
    ocrLoopRunningRef.current = false
    autoReadDoneRef.current = false
    autoOkDoneRef.current = false
    autoFlowRef.current = false
    setStartTime(null)
    setStartExp(null)
    setElapsedSec(0)
    setExpGained(0)
    setExpPerHour(0)
    setTotalExpGainedDuringPause(0)
    pausedAtExpRef.current = null
  }

  const handleAction = (action) => {
    if (action === 'READ_EXP') readExp()
    else if (action === 'OK') onOk()
    else if (action === 'START') onStart()
    else if (action === 'RESET') resetMeasurement()
    else if (action === 'RESELECT') reselectRegion()
    else if (action === 'STOP') stopScreenShare()
    else if (action === 'PAUSE') onPause()
    else if (action === 'RESUME') onResume()
  }
  const pipActionRef = useRef(handleAction)
  pipActionRef.current = handleAction

  // 화면 공유·영역은 유지한 채 측정만 처음부터 다시 시작
  const resetMeasurement = () => {
    stopSilentAudio()
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    setIsRunning(false)
    setIsPaused(false)
    setStartTime(null)
    setStartExp(null)
    setElapsedSec(0)
    setExpGained(0)
    setExpPerHour(0)
    setTotalExpGainedDuringPause(0)
    pausedAtExpRef.current = null
    setMilestoneExp({ 300: null, 600: null, 1800: null, 3600: null })
    setCurrentExp(null)
    setCurrentExpPercent(null)
    setConfirmedExp(null)
    autoReadDoneRef.current = false
    autoOkDoneRef.current = false
    autoFlowRef.current = true
    setShowStart(false)
    setShowSnapshot(true)
  }

  const recaptureSnapshot = () => {
    setShowSnapshot(false)
    setSelection(null)
    setTimeout(() => setShowSnapshot(true), 150)
  }

  const reselectRegion = () => {
    if (!stream) return
    recaptureSnapshot()
    setTimeout(() => {
      runAutoDetect()
    }, 200)
  }

  const formatTimeForPip = (sec) => {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const openPip = async () => {
    const existingPip = pipWindowRef.current && !pipWindowRef.current.closed
    pipPreStateRef.current = {
      showSnapshot,
      showStart,
      currentExp,
      currentExpPercent,
      confirmedExp,
      isRunning,
    }
    let win
    const pipWidth = 300
    const pipHeight = 330
    const mainWindow = window
    try {
      if (existingPip) {
        win = pipWindowRef.current
      } else if (window.documentPictureInPicture) {
        win = await window.documentPictureInPicture.requestWindow({ width: pipWidth, height: pipHeight })
      } else {
        win = window.open('', 'exp-tracker-pip', `width=${pipWidth},height=${pipHeight},left=100,top=100`)
        if (!win) {
          setError('PIP 창을 열 수 없습니다. 팝업 차단을 해제해 주세요.')
          return
        }
      }
    } catch (e) {
      win = window.open('', 'exp-tracker-pip', `width=${pipWidth},height=${pipHeight},left=100,top=100`)
      if (!win) {
        setError('PIP 창을 열 수 없습니다. 팝업 차단을 해제해 주세요.')
        return
      }
    }
    pipWindowRef.current = win
    if (pipUpdateIntervalRef.current) {
      clearInterval(pipUpdateIntervalRef.current)
      pipUpdateIntervalRef.current = null
    }
    win.document.title = '경험치 트래커'
    const stepLabels = ['', '화면 공유', '영역 선택', '경험치 읽기', '값 확인', '측정 준비', '측정 중']
    let lastPipHeight = 0
    win.document.body.innerHTML = `
      <style>
        html, body {
          margin: 0;
          padding: 0;
          width: 100%;
          height: 100%;
          background: #0f172a;
          color: #e2e8f0;
          overflow: auto;
        }
        #pip-root {
          font-family: system-ui, sans-serif;
          padding: 4px;
          background: #0f172a;
          color: #e2e8f0;
          height: auto;
          box-sizing: border-box;
        }
        #pip-root * {
          box-sizing: border-box;
        }
        .pip-container {
          width: 96%;
          margin: 0 auto;
          text-align: center;
        }
        .pip-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          margin-bottom: 6px;
        }
        .pip-actions--stats {
          margin-top: 10px;
          margin-bottom: 8px;
          padding-top: 6px;
          border-top: 1px solid rgba(148, 163, 184, 0.25);
        }
        .pip-actions--single {
          grid-template-columns: 1fr;
        }
        .pip-btn {
          padding: 6px 12px;
          font-size: 12px;
          border: 1px solid #334155;
          border-radius: 999px;
          background: radial-gradient(circle at top left, rgba(51, 65, 85, 0.9), rgba(15, 23, 42, 0.95));
          color: #e2e8f0;
          cursor: pointer;
          transition:
            background 0.18s ease,
            border-color 0.18s ease,
            box-shadow 0.18s ease,
            transform 0.12s ease;
        }
        .pip-btn:hover:not(:disabled) {
          background: radial-gradient(circle at top left, rgba(71, 85, 105, 1), rgba(15, 23, 42, 0.98));
          box-shadow:
            0 10px 25px rgba(15, 23, 42, 0.9),
            0 0 14px rgba(56, 189, 248, 0.35);
          transform: translateY(-1px);
        }
        .pip-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .pip-btn.danger {
          background: #7f1d1d;
          border-color: #991b1b;
          color: #fff;
        }
        .pip-btn.danger:hover:not(:disabled) {
          background: #991b1b;
        }
        .pip-btn.secondary {
          background: transparent;
          color: #94a3b8;
        }
        .pip-btn.primary {
          background: radial-gradient(circle at top left, #2563eb, #0ea5e9);
          border-color: rgba(56, 189, 248, 0.9);
          color: #f9fafb;
          box-shadow:
            0 14px 30px rgba(37, 99, 235, 0.65),
            0 0 22px rgba(56, 189, 248, 0.6);
        }
        .pip-btn.primary:hover:not(:disabled) {
          background: radial-gradient(circle at top left, #1d4ed8, #0284c7);
        }
        .pip-brand {
          font-size: 11px;
          color: #93c5fd;
          margin-bottom: 4px;
          letter-spacing: 0.2px;
        }
        .pip-title {
          font-weight: 700;
          margin-bottom: 6px;
        }
        .pip-stats-line {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          border: 1px solid rgba(148, 163, 184, 0.35);
          background: rgba(15, 23, 42, 0.5);
          border-radius: 8px;
          font-size: 12px;
          margin-bottom: 4px;
        }
        .pip-stats-label {
          color: #cbd5f5;
        }
        .pip-stats-value {
          color: #e2e8f0;
          font-weight: 600;
        }
        .pip-highlight {
          border-color: rgba(134, 239, 172, 0.6);
          background: rgba(22, 163, 74, 0.2);
          color: #86efac;
        }
        .pip-milestones {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 4px;
          margin-top: 12px;
          padding-top: 8px;
          border-top: 1px solid rgba(148, 163, 184, 0.25);
        }
        .pip-milestone {
          padding: 4px 6px;
          border-radius: 6px;
          border: 1px solid rgba(127, 29, 29, 0.9);
          background: rgba(127, 29, 29, 0.65);
          font-size: 11px;
        }
        .pip-milestone-label {
          display: block;
          color: #fecaca;
          margin-bottom: 2px;
        }
        .pip-milestone-value {
          display: block;
          color: #fee2e2;
          font-weight: 600;
        }
        .pip-milestone-delta {
          font-size: 10px;
          opacity: 0.75;
          margin-left: 4px;
        }
        .pip-milestone--passed {
          border-color: #4ade80;
          background: rgba(22, 163, 74, 0.4);
          box-shadow:
            0 0 8px rgba(74, 222, 128, 0.6),
            0 0 14px rgba(22, 163, 74, 0.45);
        }
        .pip-milestone--pre {
          border-color: #fbbf24;
          animation: pip-milestone-pre 0.8s ease-in-out infinite alternate;
        }
        @keyframes pip-milestone-pre {
          from {
            box-shadow:
              0 0 4px rgba(250, 191, 36, 0.4),
              0 0 10px rgba(250, 204, 21, 0.3);
          }
          to {
            box-shadow:
              0 0 14px rgba(250, 204, 21, 0.85),
              0 0 20px rgba(250, 250, 150, 0.6);
          }
        }
      </style>
      <div id="pip-root">
        <div class="pip-container">
        <div id="pip-step-panel">
          <div style="font-weight:700;margin-bottom:6px;" id="pip-step-label">영역 선택</div>
          <div style="font-size:12px;color:#94a3b8;margin-bottom:12px;" id="pip-hint"></div>
          <div class="pip-actions pip-actions--single">
            <button type="button" id="pip-btn-read" class="pip-btn">경험치 읽기</button>
            <button type="button" id="pip-btn-ok" class="pip-btn">이 값으로 준비</button>
            <button type="button" id="pip-btn-start" class="pip-btn primary">측정 시작</button>
          </div>
          <div class="pip-actions">
            <button type="button" id="pip-btn-reset" class="pip-btn danger">처음부터 다시 측정</button>
            <button type="button" id="pip-btn-stop" class="pip-btn secondary">중지</button>
          </div>
        </div>
        <div id="pip-stats" style="display:none;">
          <div class="pip-brand">https://MaplelandTracker.gg</div>
          <div class="pip-title">경험치 측정기</div>
          <div id="pip-paused-hint" style="display:none; font-size:12px; color:#94a3b8; margin-bottom:8px;">일시정지 중</div>
          <div id="pip-elapsed" class="pip-stats-line">
            <span class="pip-stats-label">경과</span>
            <span class="pip-stats-value">0:00</span>
          </div>
          <div id="pip-exp" class="pip-stats-line">
            <span class="pip-stats-label">현재</span>
            <span class="pip-stats-value">-</span>
          </div>
          <div id="pip-gained" class="pip-stats-line pip-highlight">
            <span class="pip-stats-label">획득</span>
            <span class="pip-stats-value">-</span>
          </div>
          <div class="pip-actions pip-actions--stats">
            <button type="button" id="pip-btn-pause" class="pip-btn secondary">일시정지</button>
            <button type="button" id="pip-btn-stop-run" class="pip-btn danger">중지</button>
          </div>
          <div class="pip-milestones">
            <div id="pip-m-300" class="pip-milestone">
              <span id="pip-m-300-label" class="pip-milestone-label">5분 예상</span>
              <span id="pip-m-300-value" class="pip-milestone-value">-</span>
            </div>
            <div id="pip-m-600" class="pip-milestone">
              <span id="pip-m-600-label" class="pip-milestone-label">10분 예상</span>
              <span id="pip-m-600-value" class="pip-milestone-value">-</span>
            </div>
            <div id="pip-m-1800" class="pip-milestone">
              <span id="pip-m-1800-label" class="pip-milestone-label">30분 예상</span>
              <span id="pip-m-1800-value" class="pip-milestone-value">-</span>
            </div>
            <div id="pip-m-3600" class="pip-milestone">
              <span id="pip-m-3600-label" class="pip-milestone-label">1시간 예상</span>
              <span id="pip-m-3600-value" class="pip-milestone-value">-</span>
            </div>
          </div>
        </div>
        </div>
      </div>
    `
    const sendAction = (action) => {
      // PIP -> 본체로 최대한 확실하게 전달
      if (mainWindow?.__expTrackerHandleAction) {
        mainWindow.__expTrackerHandleAction(action)
      } else {
        handleAction(action)
      }
      mainWindow?.postMessage({ type: 'EXP_TRACKER_ACTION', action }, '*')
      try {
        mainWindow?.dispatchEvent(new CustomEvent('EXP_TRACKER_ACTION_CUSTOM', { detail: action }))
      } catch {}
    }
    win.document.getElementById('pip-btn-read').onclick = () => sendAction('READ_EXP')
    win.document.getElementById('pip-btn-ok').onclick = () => sendAction('OK')
    win.document.getElementById('pip-btn-start').onclick = () => sendAction('START')
    win.document.getElementById('pip-btn-reset').onclick = () => sendAction('RESET')
    win.document.getElementById('pip-btn-stop').onclick = () => sendAction('STOP')
    win.document.getElementById('pip-btn-stop-run').onclick = () => sendAction('STOP')

    const fitPipWindow = () => {
      if (!pipWindowRef.current || pipWindowRef.current.closed) return
      const body = pipWindowRef.current.document.body
      if (!body || typeof pipWindowRef.current.resizeTo !== 'function') return
      const targetHeight = Math.min(420, Math.max(220, body.scrollHeight + 16))
      const currentHeight = pipWindowRef.current.innerHeight || 0
      // 콘텐츠보다 작게 줄어들면 즉시 복구(스크롤바 방지)
      if (currentHeight < targetHeight && Math.abs(lastPipHeight - targetHeight) >= 1) {
        lastPipHeight = targetHeight
        pipWindowRef.current.resizeTo(pipWidth, targetHeight)
      }
    }

    const updatePipContent = () => {
      if (!pipWindowRef.current || pipWindowRef.current.closed) {
        if (pipUpdateIntervalRef.current) clearInterval(pipUpdateIntervalRef.current)
        pipUpdateIntervalRef.current = null
        return
      }
      const doc = pipWindowRef.current.document
      const ps = pipStateRef.current
      const setBtn = (id, opts) => {
        const el = doc.getElementById(id)
        if (!el) return
        if (opts?.disabled !== undefined) el.disabled = opts.disabled
        if (opts?.show !== undefined) el.style.display = opts.show ? 'block' : 'none'
        if (opts?.text) el.textContent = opts.text
        if (opts?.className !== undefined) el.className = opts.className
      }
      const stepPanel = doc.getElementById('pip-step-panel')
      const statsPanel = doc.getElementById('pip-stats')
      const s = latestStatsRef.current
      const running = !!ps.isRunning || (s.elapsedSec ?? 0) > 0
      if (running) {
        if (stepPanel) stepPanel.style.display = 'none'
        if (statsPanel) statsPanel.style.display = 'block'
        const expPerHour = s.expPerHour ?? 0
        const elapsedEl = doc.getElementById('pip-elapsed')
        if (elapsedEl) {
          const val = elapsedEl.querySelector('.pip-stats-value')
          if (val) val.textContent = `${formatTimeForPip(s.elapsedSec ?? 0)}`
        }
        const expEl = doc.getElementById('pip-exp')
        if (expEl) {
          const val = expEl.querySelector('.pip-stats-value')
          const pauseGain = s.totalExpGainedDuringPause ?? 0
          if (val) val.textContent = `${s.currentExp != null ? s.currentExp.toLocaleString() : '-'}${s.currentExpPercent != null ? ` [${s.currentExpPercent}%]` : ''}${pauseGain > 0 ? ` (+${pauseGain.toLocaleString()})` : ''}`
        }
        const gainedEl = doc.getElementById('pip-gained')
        if (gainedEl) {
          const val = gainedEl.querySelector('.pip-stats-value')
          if (val) val.textContent = `${(s.expGained ?? 0).toLocaleString()}`
        }
        // EXP/h는 PIP에서 표시하지 않음. 일시정지/재개 버튼은 본체와 동일: 문구·스타일 토글
        setBtn('pip-btn-pause', {
          show: !!ps.stream,
          text: ps.isPaused ? '▶ 재개' : '⏸ 일시정지',
          className: ps.isPaused ? 'pip-btn primary' : 'pip-btn secondary',
        })
        const pauseBtn = doc.getElementById('pip-btn-pause')
        if (pauseBtn) pauseBtn.onclick = () => sendAction(pipPauseResumeActionRef.current)
        const pipPausedHint = doc.getElementById('pip-paused-hint')
        if (pipPausedHint) pipPausedHint.style.display = ps.isPaused ? 'block' : 'none'
        setBtn('pip-btn-stop-run', { show: !!ps.stream, disabled: !ps.stream })
        const checkpoints = [300, 600, 1800, 3600]
        const elapsed = s.elapsedSec ?? 0
        const secLabel = { 300: '5분', 600: '10분', 1800: '30분', 3600: '1시간' }
        checkpoints.forEach((sec) => {
          const box = doc.getElementById(`pip-m-${sec}`)
          const labelEl = doc.getElementById(`pip-m-${sec}-label`)
          const valueEl = doc.getElementById(`pip-m-${sec}-value`)
          if (!box || !labelEl || !valueEl) return
          const passed = elapsed >= sec
          const pre = !passed && elapsed >= sec - 3
          box.className = `pip-milestone${passed ? ' pip-milestone--passed' : ''}${pre ? ' pip-milestone--pre' : ''}`
          labelEl.textContent = passed ? `${secLabel[sec] || `${sec}초`} 완료` : `${secLabel[sec] || `${sec}초`} 예상`
          const frozen = milestoneExpRef.current?.[sec]
          const val = frozen != null ? frozen : Math.round((expPerHour * sec) / 3600)
          valueEl.textContent = Number.isFinite(val) ? `${val.toLocaleString()} EXP` : '-'
        })
      } else {
        if (stepPanel) stepPanel.style.display = 'block'
        if (statsPanel) statsPanel.style.display = 'none'
        const stepNum = { 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤', 6: '⑥' }
        if (doc.getElementById('pip-step-label')) doc.getElementById('pip-step-label').textContent = `${stepNum[ps.step] || ''} ${stepLabels[ps.step] || ''}`
        if (doc.getElementById('pip-hint')) doc.getElementById('pip-hint').textContent = ps.hint || ''
        const canRead = !!ps.stream && !!ps.showSnapshot && ps.currentExp == null && ps.canReadExp
        const canOk = ps.currentExp != null && !ps.showStart
        const canStart = (ps.confirmedExp != null) && !ps.isRunning
        setBtn('pip-btn-read', { disabled: !ps.canReadExp, show: !!ps.stream && ps.currentExp == null, text: ps.canReadExp ? '경험치 읽기' : '영역 지정 후 가능' })
        setBtn('pip-btn-ok', { disabled: !ps.canOk, show: ps.currentExp != null && !ps.showStart })
        setBtn('pip-btn-start', { disabled: !canStart, show: canStart })
        setBtn('pip-btn-reset', { disabled: !(ps.confirmedExp != null && !ps.isRunning), show: ps.confirmedExp != null && !ps.isRunning })
        setBtn('pip-btn-stop', { disabled: !ps.stream, show: !!ps.stream })
      }
      fitPipWindow()
    }
    pipUpdateNowRef.current = updatePipContent
    updatePipContent()
    pipUpdateIntervalRef.current = setInterval(updatePipContent, 500)
    win.addEventListener('pagehide', () => {
      if (pipUpdateIntervalRef.current) clearInterval(pipUpdateIntervalRef.current)
      pipUpdateIntervalRef.current = null
      pipWindowRef.current = null
      // PIP 종료 시, PIP 열기 직전 단계로 복귀
      if (pipPreStateRef.current) {
        onStop()
        const prev = pipPreStateRef.current
        setShowSnapshot(prev.showSnapshot)
        setShowStart(prev.showStart)
        setCurrentExp(prev.currentExp)
        setCurrentExpPercent(prev.currentExpPercent)
        setConfirmedExp(prev.confirmedExp)
      }
    })
  }

  // 실시간 경험치/EXP per hour 갱신. 일시정지 중 오른 경험치는 totalExpGainedDuringPause로 빼서 표시.
  useEffect(() => {
    if (!isRunning || startTime == null || startExp == null || currentExp == null) return
    latestCurrentExpRef.current = currentExp

    let totalPaused = totalExpGainedDuringPause
    if (pausedAtExpRef.current != null) {
      const delta = Math.max(0, currentExp - pausedAtExpRef.current)
      totalPaused += delta
      setTotalExpGainedDuringPause((prev) => prev + delta)
      pausedAtExpRef.current = null
    }

    const gained = currentExp - startExp - totalPaused
    setExpGained(gained)
    const sec = elapsedSec || 1
    setExpPerHour(Math.round(gained / (sec / 3600)))
  }, [isRunning, startTime, startExp, currentExp, elapsedSec, totalExpGainedDuringPause])

  useEffect(() => {
    milestoneExpRef.current = milestoneExp
  }, [milestoneExp])

  useEffect(() => {
    if (pipUpdateNowRef.current) pipUpdateNowRef.current()
  }, [elapsedSec, currentExp, currentExpPercent, expGained, expPerHour, isRunning, isPaused, totalExpGainedDuringPause])

  // 마일스톤(5분/10분/30분/1시간) 예상 EXP 스냅샷 고정
  useEffect(() => {
    if (!isRunning) {
      setMilestoneExp({ 300: null, 600: null, 1800: null, 3600: null })
      return
    }
    const secs = [300, 600, 1800, 3600]
    setMilestoneExp((prev) => {
      const next = { ...prev }
      let changed = false
      secs.forEach((s) => {
        if (elapsedSec >= s && next[s] == null) {
          // expPerHour 기준, s초 동안의 예상 EXP
          next[s] = Math.round((expPerHour * s) / 3600)
          changed = true
        }
      })
      return changed ? next : prev
    })
  }, [isRunning, elapsedSec, expPerHour])

  // PIP 창 갱신용: 측정 중일 때 최신 수치를 ref에 동기화 (일시정지 중 오른 경험치 제외한 획득)
  useEffect(() => {
    if (!isRunning) return
    const gained = startExp != null && currentExp != null ? currentExp - startExp - totalExpGainedDuringPause : 0
    const expPerHourVal = elapsedSec >= 1 && startExp != null && currentExp != null
      ? Math.round(gained / (elapsedSec / 3600))
      : 0
    latestStatsRef.current = {
      elapsedSec,
      startExp,
      currentExp,
      currentExpPercent: currentExpPercent ?? null,
      expGained: gained,
      expPerHour: expPerHourVal,
      totalExpGainedDuringPause,
    }
  }, [isRunning, elapsedSec, startExp, currentExp, currentExpPercent, totalExpGainedDuringPause])

  useEffect(() => {
    const msgHandler = (e) => {
      if (e.data?.type !== 'EXP_TRACKER_ACTION') return
      handleAction(e.data.action)
    }
    const customHandler = (e) => {
      handleAction(e.detail)
    }
    window.__expTrackerHandleAction = handleAction
    window.addEventListener('message', msgHandler)
    window.addEventListener('EXP_TRACKER_ACTION_CUSTOM', customHandler)
    return () => {
      window.removeEventListener('message', msgHandler)
      window.removeEventListener('EXP_TRACKER_ACTION_CUSTOM', customHandler)
    }
  }, [handleAction])

  // PIP에 전달할 단계/버튼 상태 동기화 (스냅샷·START 전에도 PIP에서 조작 가능하게)
  useEffect(() => {
    const s = !stream ? 1 : isRunning ? 6 : showStart ? 5 : currentExp !== null && !showStart ? 4 : showSnapshot && selection ? 3 : 2
    const hints = {
      1: 'STEP 1 · 화면 공유',
      2: 'STEP 2 · 경험치 바 선택',
      3: 'STEP 3 · 값 읽기',
      4: 'STEP 3 · 값 확인',
      5: 'STEP 4 · 측정 준비',
      6: 'STEP 4 · 측정 중',
    }
    const hint = s === 2 && !selection ? '경험치 영역 찾는 중…' : (hints[s] || '')
    pipStateRef.current = {
      step: s,
      hint,
      stream: !!stream,
      showSnapshot,
      showStart,
      canReadExp: !!stream && !!showSnapshot && !!selection && selection.w >= 5 && selection.h >= 5 && !isReading,
      canOk: currentExp !== null && !showStart,
      canStart: showStart && !isRunning && confirmedExp != null,
      isDetecting,
      isReading,
      currentExp,
      confirmedExp,
      isRunning,
      isPaused,
      elapsedSec: latestStatsRef.current.elapsedSec ?? 0,
      expPerHour: latestStatsRef.current.expPerHour ?? 0,
      expGained: latestStatsRef.current.expGained ?? 0,
    }
    pipPauseResumeActionRef.current = isPaused ? 'RESUME' : 'PAUSE'
  }, [stream, showSnapshot, showStart, selection, currentExp, confirmedExp, isRunning, isPaused, isReading, isDetecting])

  const formatTime = (sec) => {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }

  // 단계: 1 화면 공유 → 2 영역 확인 → 3 경험치 읽기 → 4 확인(OK) → 5 START → 6 측정 중
  const getStep = () => {
    if (!stream) return 1
    if (isRunning) return 6
    if (showStart) return 5
    if (currentExp !== null && !showStart) return 4
    if (showSnapshot && selection && (currentExp === null || isReading)) return 3
    if (showSnapshot) return 2
    return 2
  }
  const step = getStep()
  const STEP_LABELS = ['', '화면 공유', '영역 선택', '경험치 읽기', '값 확인', '측정 준비', '측정 중']
  const STEP_HINTS = {
    1: 'STEP 1 · 화면 공유',
    2: 'STEP 2 · 경험치 바 선택',
    3: 'STEP 3 · 값 읽기',
    4: 'STEP 3 · 값 확인',
    5: 'STEP 4 · 측정 준비',
    6: 'STEP 4 · 측정 중',
  }

  // 마일스톤 구간별(300→600, 600→1800, 1800→3600) 분당 효율 증감률(%) 계산
  const milestoneDurations = { 300: 300, 600: 600, 1800: 1800, 3600: 3600 }
  const getMilestoneValue = (sec) => (
    milestoneExp[sec] != null ? milestoneExp[sec] : Math.round((expPerHour * sec) / 3600)
  )
  const getMilestoneDelta = (currentKey, prevKey) => {
    const cur = getMilestoneValue(currentKey)
    const prev = getMilestoneValue(prevKey)
    if (cur == null || prev == null || prev <= 0) return null
    const curPer = cur / milestoneDurations[currentKey]
    const prevPer = prev / milestoneDurations[prevKey]
    if (!Number.isFinite(curPer) || !Number.isFinite(prevPer) || prevPer === 0) return null
    const diff = (curPer / prevPer - 1) * 100
    if (!Number.isFinite(diff)) return null
    return Math.round(diff)
  }

  const pipModeOnly = true

  if (!stream) {
    return (
      <section className="exp-tracker">
        <h2>경험치 트래커</h2>
        <p className="exp-tracker-desc">화면을 공유하고 몇 번만 클릭하면 시간당 EXP를 자동으로 계산합니다.</p>
        {error && <p className="exp-tracker-error">{error}</p>}
        <button type="button" className="exp-tracker-btn primary" onClick={() => setShowShareGuideModal(true)}>
          화면 공유 시작
        </button>

        {showShareGuideModal && (
          <div className="exp-tracker-modal-overlay" onClick={() => setShowShareGuideModal(false)} aria-hidden="false">
            <div className="exp-tracker-modal" onClick={(e) => e.stopPropagation()}>
              <p className="exp-tracker-modal-title">화면 공유 안내</p>
              <p className="exp-tracker-modal-body">
                1. Window 탭 이동<br />2. MapleStory Worlds 선택
              </p>
              <div className="exp-tracker-modal-note">
                <p>공유한 화면은 누구도 볼 수 없습니다.</p>
                <p>제작자인 저도 볼 수 없습니다.</p>
              </div>
              <div className="exp-tracker-modal-actions">
                <button type="button" className="exp-tracker-btn secondary" onClick={() => setShowShareGuideModal(false)}>
                  취소
                </button>
                <button
                  type="button"
                  className="exp-tracker-btn primary"
                  onClick={() => {
                    setShowShareGuideModal(false)
                    startScreenShare()
                  }}
                >
                  확인
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="exp-tracker-assurance">
          <p className="exp-tracker-assurance-title">안심하고 이용하세요</p>
          <ul className="exp-tracker-assurance-list">
            <li>이 사이트는 <strong>서버에 데이터를 절대 저장하지 않습니다.</strong> 경험치 측정은 모두 사용자 기기에서만 처리됩니다.</li>
            <li>화면 공유는 <strong>보여주기만</strong> 하며, 키보드·마우스 조작 권한을 요구하거나 가질 수 없습니다.</li>
            <li>공유할 화면·창은 <strong>브라우저가 묻는 대로 사용자가 직접 선택</strong>하며, 언제든 중지할 수 있습니다.</li>
            <li>화면 공유를 해도 스트림을 어딘가로 보내지 않기 때문에, <strong>화면 공유가 해킹당할 염려는 없습니다.</strong></li>
          </ul>
        </div>
        <p className="exp-tracker-test-badge">1.0 version(test)</p>
      </section>
    )
  }

  return (
    <section className="exp-tracker">
      <h2>경험치 트래커</h2>
      {/* 공유 화면: 기본 숨김. 측정 중엔 2px만 보이게 해서 디코딩 유지(OCR 동작). 캡처 시엔 잠깐 표시 */}
      <div
        className={`exp-tracker-video-wrap${videoVisibleForCapture ? ' exp-tracker-video-wrap--capturing' : ''}${isRunning ? ' exp-tracker-video-wrap--measuring' : ''}`}
        aria-hidden
      >
        <video ref={videoRef} autoPlay muted playsInline />
      </div>

      {error && <p className="exp-tracker-error">{error}</p>}

      <div className="exp-tracker-stepper" aria-label="진행 단계">
        {[2, 3, 4, 5, 6].map((i) => (
          <span
            key={i}
            className={`exp-tracker-step${step >= i ? ' exp-tracker-step--active' : ''}${step === i ? ' exp-tracker-step--current' : ''}`}
          >
            {i === 2 && '② '}
            {i === 3 && '③ '}
            {i === 4 && '④ '}
            {i === 5 && '⑤ '}
            {i === 6 && '⑥ '}
            {STEP_LABELS[i]}
          </span>
        ))}
      </div>
      <p className="exp-tracker-hint exp-tracker-step-hint">
        {step === 2 && !selection ? '경험치 영역 찾는 중…' : STEP_HINTS[step]}
      </p>

      {showSnapshot && (
        <>
          {currentExp === null && (
            <div className="exp-tracker-snapshot-wrap">
              <canvas ref={snapshotCanvasRef} className="exp-tracker-snapshot" />
              <canvas
                ref={overlayCanvasRef}
                className="exp-tracker-overlay"
                style={{ pointerEvents: currentExp === null ? 'auto' : 'none' }}
                onMouseDown={onCanvasMouseDown}
                onMouseMove={onCanvasMouseMove}
                onMouseUp={onCanvasMouseUp}
                onMouseLeave={onCanvasMouseUp}
              />
            </div>
          )}
          <div className="exp-tracker-actions exp-tracker-actions--primary">
            {currentExp === null ? (
              <button
                type="button"
                className="exp-tracker-btn primary exp-tracker-btn--main"
                onClick={readExp}
                disabled={!selection || selection.w < 5 || selection.h < 5 || isReading}
              >
                {isReading ? '읽는 중…' : '경험치 읽기'}
              </button>
            ) : (
              <>
                <span className="exp-tracker-current">
                  현재 경험치: {currentExp.toLocaleString()}
                  {currentExpPercent != null && ` [${currentExpPercent}%]`}
                </span>
                <button type="button" className="exp-tracker-btn primary exp-tracker-btn--main" onClick={onOk}>
                  이 값으로 측정 준비
                </button>
              </>
            )}
          </div>
          <div className="exp-tracker-actions exp-tracker-actions--secondary">
            <button type="button" className="exp-tracker-btn secondary" onClick={openPip} title="작은 창에서도 조작 가능">
              📺 PIP 열기
            </button>
            <button type="button" className="exp-tracker-btn secondary" onClick={reselectRegion} disabled={isDetecting}>
              {isDetecting ? '찾는 중…' : '영역 다시 찾기'}
            </button>
            <button type="button" className="exp-tracker-btn secondary" onClick={stopScreenShare}>
              중지
            </button>
          </div>
        </>
      )}

      {!showSnapshot && !showStart && <p className="exp-tracker-hint">캡처 중…</p>}

      {!showSnapshot && showStart && (
        <div className="exp-tracker-actions exp-tracker-actions--secondary">
          {!isRunning && (
            <button type="button" className="exp-tracker-btn primary exp-tracker-btn--main exp-tracker-btn--start" onClick={onStart}>
              ▶ 측정 시작
            </button>
          )}
        </div>
      )}

      {isRunning && (
        <div className="exp-tracker-stats">
          <div className="exp-tracker-brand">https://MaplelandTracker.gg</div>
          <div className="exp-tracker-title">경험치 측정기</div>
          {isPaused && (
            <p className="exp-tracker-hint" style={{ marginBottom: 8 }}>일시정지 중</p>
          )}
          <div className="exp-tracker-stat-line">
            <span className="exp-tracker-stat-label">경과</span>
            <span className="exp-tracker-stat-value">{formatTime(elapsedSec)}</span>
          </div>
          <div className="exp-tracker-stat-line">
            <span className="exp-tracker-stat-label">현재</span>
            <span className="exp-tracker-stat-value">
              {currentExp?.toLocaleString() ?? '-'}{currentExpPercent != null ? ` [${currentExpPercent}%]` : ''}
              {totalExpGainedDuringPause > 0 && ` (+${totalExpGainedDuringPause.toLocaleString()})`}
            </span>
          </div>
          <div className="exp-tracker-stat-line exp-tracker-stat-highlight">
            <span className="exp-tracker-stat-label">획득</span>
            <span className="exp-tracker-stat-value">{expGained.toLocaleString()}</span>
          </div>

          <div className="exp-tracker-milestones">
            <div
              className={`exp-tracker-milestone${
                elapsedSec >= 300 ? ' exp-tracker-milestone--passed' : elapsedSec >= 300 - 3 ? ' exp-tracker-milestone--pre' : ''
              }`}
            >
              <span className="exp-tracker-milestone-label">{milestoneExp[300] != null ? '5분 완료' : '5분 예상'}</span>
              <span className="exp-tracker-milestone-value">
                {(milestoneExp[300] != null
                  ? milestoneExp[300]
                  : Math.round((expPerHour * 300) / 3600)
                ).toLocaleString()} EXP
              </span>
            </div>
            <div
              className={`exp-tracker-milestone${
                elapsedSec >= 600 ? ' exp-tracker-milestone--passed' : elapsedSec >= 600 - 3 ? ' exp-tracker-milestone--pre' : ''
              }`}
            >
              <span className="exp-tracker-milestone-label">{milestoneExp[600] != null ? '10분 완료' : '10분 예상'}</span>
              <span className="exp-tracker-milestone-value">
                {(() => {
                  const base = getMilestoneValue(600)
                  const delta = getMilestoneDelta(600, 300)
                  return (
                    <>
                      {base.toLocaleString()} EXP
                      {delta != null && (
                        <span className="exp-tracker-milestone-delta">
                          {` (${delta >= 0 ? '+' : ''}${delta}%)`}
                        </span>
                      )}
                    </>
                  )
                })()}
              </span>
            </div>
            <div
              className={`exp-tracker-milestone${
                elapsedSec >= 1800 ? ' exp-tracker-milestone--passed' : elapsedSec >= 1800 - 3 ? ' exp-tracker-milestone--pre' : ''
              }`}
            >
              <span className="exp-tracker-milestone-label">{milestoneExp[1800] != null ? '30분 완료' : '30분 예상'}</span>
              <span className="exp-tracker-milestone-value">
                {(() => {
                  const base = getMilestoneValue(1800)
                  const delta = getMilestoneDelta(1800, 600)
                  return (
                    <>
                      {base.toLocaleString()} EXP
                      {delta != null && (
                        <span className="exp-tracker-milestone-delta">
                          {` (${delta >= 0 ? '+' : ''}${delta}%)`}
                        </span>
                      )}
                    </>
                  )
                })()}
              </span>
            </div>
            <div
              className={`exp-tracker-milestone${
                elapsedSec >= 3600 ? ' exp-tracker-milestone--passed' : elapsedSec >= 3600 - 3 ? ' exp-tracker-milestone--pre' : ''
              }`}
            >
              <span className="exp-tracker-milestone-label">{milestoneExp[3600] != null ? '1시간 완료' : '1시간 예상'}</span>
              <span className="exp-tracker-milestone-value">
                {(() => {
                  const base = getMilestoneValue(3600)
                  const delta = getMilestoneDelta(3600, 1800)
                  return (
                    <>
                      {base.toLocaleString()} EXP
                      {delta != null && (
                        <span className="exp-tracker-milestone-delta">
                          {` (${delta >= 0 ? '+' : ''}${delta}%)`}
                        </span>
                      )}
                    </>
                  )
                })()}
              </span>
            </div>
          </div>
          <div className="exp-tracker-actions exp-tracker-actions--secondary" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
            {isPaused ? (
              <button type="button" className="exp-tracker-btn primary" onClick={onResume}>▶ 재개</button>
            ) : (
              <button type="button" className="exp-tracker-btn secondary" onClick={onPause}>⏸ 일시정지</button>
            )}
            <button type="button" className="exp-tracker-btn danger" onClick={stopScreenShare}>측정 중지</button>
          </div>
        </div>
      )}
    </section>
  )
}

export default ExpTracker
