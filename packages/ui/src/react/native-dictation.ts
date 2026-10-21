import { useEffect, useRef, useState } from "react"

export type NativeDictationResult = { ok: true } | { ok: false; reason: "unavailable" | "not_focused" | "failed" }
export type DictationPlatform = "macos" | "windows" | "mobile" | "unsupported"

/** OS detection only selects instructions; it never selects a speech service. */
export function dictationPlatform(userAgent: string, touchPoints = 0): DictationPlatform {
  if (/iPhone|iPad|iPod|Android/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)) return "mobile"
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos"
  if (/Windows/i.test(userAgent)) return "windows"
  return "unsupported"
}

export function useNativeDictation(options: {
  enabled: boolean
  scope?: string
  text: string
  focusInput(): void
  startNative?: (signal: AbortSignal) => Promise<NativeDictationResult>
}) {
  const [platform, setPlatform] = useState<DictationPlatform>("unsupported")
  const [helpOpen, setHelpOpen] = useState(false)
  const [reviewRequired, setReviewRequired] = useState(false)
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  const pending = useRef(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    setPlatform(dictationPlatform(navigator.userAgent, navigator.maxTouchPoints))
  }, [])
  useEffect(() => {
    generation.current++
    pending.current = false
    setStarting(false)
    setHelpOpen(false)
    setReviewRequired(false)
    setFailed(false)
    return () => { generation.current++; request.current?.abort(); request.current = null }
  }, [options.enabled, options.scope])
  useEffect(() => {
    if (options.text !== "") return
    if (request.current) {
      generation.current++
      request.current.abort()
      request.current = null
      pending.current = false
      setStarting(false)
    }
    setReviewRequired(false)
  }, [options.text])

  async function start() {
    if (!options.enabled || pending.current) return
    options.focusInput()
    setFailed(false)
    if (platform === "unsupported") { setHelpOpen(true); return }
    // The OS owns its microphone UI. We cannot observe when it stops, so keep
    // Enter as a newline until the person explicitly returns to typing or sends.
    setReviewRequired(true)
    if (!options.startNative || platform === "mobile") { setHelpOpen(true); return }
    const current = generation.current
    const controller = new AbortController()
    request.current = controller
    pending.current = true
    setStarting(true)
    let result: NativeDictationResult
    try { result = await options.startNative(controller.signal) }
    catch { result = { ok: false, reason: "failed" } }
    if (generation.current !== current) return
    request.current = null
    pending.current = false
    setStarting(false)
    if (!result.ok) { setFailed(true); setHelpOpen(true) }
  }

  return {
    platform, helpOpen, setHelpOpen, reviewRequired, starting, failed, start,
    finishReview() {
      generation.current++
      request.current?.abort()
      request.current = null
      pending.current = false
      setStarting(false)
      setHelpOpen(false)
      setReviewRequired(false)
      options.focusInput()
    },
  }
}

export function dictationInstructions(platform: DictationPlatform) {
  switch (platform) {
    case "macos": return {
      title: "Use macOS Dictation",
      instruction: "Press your Dictation shortcut or the microphone key on your keyboard. Enable Dictation and choose its language in System Settings › Keyboard.",
    }
    case "windows": return {
      title: "Use Windows voice typing",
      instruction: "Press Windows + H with your cursor in the message. Windows manages your microphone, language and speech permissions. Voice typing may need an internet connection.",
    }
    case "mobile": return {
      title: "Use keyboard dictation",
      instruction: "Tap the microphone on your device’s keyboard to dictate into this message.",
    }
    case "unsupported": return {
      title: "Dictation isn’t available here",
      instruction: "Use your system’s speech input if available, or continue typing. OpenWork can open native dictation on macOS and Windows desktop.",
    }
  }
}
