import { useRef } from "react";
import { Popover } from "@base-ui/react/popover";
import { Button } from "@base-ui/react/button";
import { Lock, Mic } from "lucide-react";
import { dictationInstructions, type useNativeDictation } from "@openwork/ui/react";

export function WorkbotDictation({ dictation, disabled, input }: {
  dictation: ReturnType<typeof useNativeDictation>;
  disabled?: boolean;
  input(): HTMLTextAreaElement | null;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const info = dictationInstructions(dictation.platform);
  return <Popover.Root open={dictation.helpOpen} onOpenChange={dictation.setHelpOpen}>
    <Button ref={anchor} type="button" disabled={disabled} aria-label="Dictate message" title="Dictate message"
      aria-haspopup="dialog" aria-expanded={dictation.helpOpen} data-native-dictation
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => { if (dictation.helpOpen) dictation.setHelpOpen(false); else void dictation.start(); }}
      className={`grid size-9 shrink-0 place-items-center rounded-md text-[var(--wb-muted)] transition-colors duration-150 hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${dictation.reviewRequired ? "text-[var(--wb-text)]" : ""}`}>
      {dictation.platform === "unsupported" ? <Lock size={16} strokeWidth={1.5} /> : <Mic size={16} strokeWidth={1.5} />}
    </Button>
    <Popover.Portal>
      <Popover.Positioner anchor={anchor} side="top" align="end" sideOffset={10} collisionPadding={8} className="z-50">
        <Popover.Popup initialFocus={false} finalFocus={input} data-dictation-help
          className="workbot flex w-72 max-w-[var(--available-width)] max-h-[var(--available-height)] flex-col gap-3 overflow-y-auto rounded-xl bg-[var(--wb-surface)] p-3 text-[13px] leading-5 text-[var(--wb-text)] shadow-[var(--wb-composer-shadow)] outline-none">
          <Popover.Title className="font-medium">{info.title}</Popover.Title>
          <p className="text-[var(--wb-muted)]">{info.instruction}</p>
          <details className="text-[12px] text-[var(--wb-muted)]">
            <summary className="cursor-pointer">Speech privacy</summary>
            <p className="pt-2">Your operating system handles audio and speech recognition under its settings. Workbot receives only text in your draft. Check your system’s dictation settings for processing and sharing options.</p>
          </details>
          <Button className="h-8 rounded-lg bg-[var(--wb-chip)] px-3 font-medium focus-visible:shadow-[var(--wb-focus)]"
            onClick={() => { dictation.setHelpOpen(false); input()?.focus(); }}>Back to message</Button>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

export function WorkbotDictationReview({ onFinish }: { onFinish(): void }) {
  return <div data-dictation-review className="flex w-full items-center justify-between gap-2 px-2 pb-1 text-[12px] leading-4 text-[var(--wb-muted)]">
    <span role="status">Review your text, then send · Enter adds a line</span>
    <Button className="shrink-0 rounded px-1 py-1 underline underline-offset-2 focus-visible:shadow-[var(--wb-focus)]" onClick={onFinish}>Return to typing</Button>
  </div>;
}
