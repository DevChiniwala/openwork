import { useEffect, useRef, useState } from "react"
import { browserSpeechConstructor, createBrowserDictation } from "./browser-dictation"

export type NativeDictationResult = { ok: true } | { ok: false; reason: "unavailable" | "not_focused" | "failed" }
export type DictationPlatform = "macos" | "windows" | "mobile" | "unsupported"
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
  onText(text: string): void
  selection(): { start: number; end: number }
  focusInput(): void
  startNative?: (signal: AbortSignal) => Promise<NativeDictationResult>
}) {
  const [platform, setPlatform] = useState<DictationPlatform>("unsupported")
  const [state, setState] = useState<"starting" | "listening" | "stopping" | "idle">("idle")
  const [nativeMode, setNativeMode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const session = useRef<ReturnType<typeof createBrowserDictation> | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const currentOptions = useRef(options)
  currentOptions.current = options
  const Constructor = browserSpeechConstructor()
  const native = Boolean(options.startNative && (platform === "macos" || platform === "windows"))
  const available = native || Boolean(Constructor)
  useEffect(() => { setPlatform(dictationPlatform(navigator.userAgent, navigator.maxTouchPoints)) }, [])
  useEffect(() => {
    setState("idle"); setNativeMode(false); setError(null)
    return () => {
      generation.current++
      request.current?.abort(); request.current = null
      session.current?.commit(); session.current = null
    }
  }, [options.enabled, options.scope])
  function commit() {
    generation.current++
    request.current?.abort(); request.current = null
    const text = session.current?.commit() ?? currentOptions.current.text
    session.current = null
    setState("idle"); setNativeMode(false)
    return text
  }
  useEffect(() => {
    // Edits outside the text input (chips, imported drafts, navigation) also
    // fence recognition so a late interim result cannot overwrite them.
    if (session.current && options.text !== session.current.text()) commit()
  }, [options.text])
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden" && session.current) commit() }
    document.addEventListener("visibilitychange", hidden)
    return () => document.removeEventListener("visibilitychange", hidden)
  }, [])
  async function toggle() {
    if (!options.enabled || request.current || state === "starting" || state === "stopping") return
    if (session.current) { if (state === "listening") session.current.stop(); return }
    options.focusInput()
    setError(null)
    if (native && options.startNative) {
      const id = ++generation.current
      const controller = new AbortController()
      request.current = controller
      setState("starting")
      try {
        const result = await options.startNative(controller.signal)
        if (id !== generation.current) return
        setNativeMode(result.ok)
        if (!result.ok) setError(platform === "windows" ? "Press Windows + H to dictate." : "Enable Dictation in System Settings › Keyboard.")
      } catch { if (id === generation.current) setError("Couldn’t open system dictation. Use your keyboard’s Dictation shortcut.") }
      finally { if (id === generation.current) { request.current = null; setState("idle") } }
      return
    }
    const Speech = browserSpeechConstructor()
    if (!Speech) return
    const id = ++generation.current
    const owner = createBrowserDictation({
      recognition: new Speech(), text: options.text, selection: options.selection(),
      language: document.documentElement.lang || navigator.language || "en-US",
      onText: text => { if (id === generation.current) currentOptions.current.onText(text) },
      onState: next => {
        if (id !== generation.current) return
        setState(next)
        if (next === "idle") session.current = null
      },
      onError: message => { if (id === generation.current) setError(message) },
    })
    session.current = owner
    owner.start()
  }
  return {
    available, error, nativeMode, state,
    active: options.enabled && (state !== "idle" || nativeMode),
    busy: state === "starting" || state === "stopping",
    toggle, commit,
    edit(text: string) {
      if (session.current && text !== session.current.text()) commit()
      currentOptions.current.onText(text)
    },
    title: error ?? (native ? "Dictate message with system dictation" : available
      ? state === "listening" ? "Stop dictation" : "Dictate message · Your browser handles speech recognition"
      : platform === "windows" ? "Use Windows + H to dictate" : platform === "macos" ? "Use your keyboard’s Dictation shortcut" : "Speech recognition isn’t available in this browser"),
  }
}
