import { useRef } from "react";
import { Mic, Lock } from "lucide-react";
import { dictationInstructions, type useNativeDictation } from "@openwork/ui/react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";

export function NativeDictationControl({ dictation, disabled, input }: {
  dictation: ReturnType<typeof useNativeDictation>;
  disabled?: boolean;
  input(): HTMLElement | null;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const info = dictationInstructions(dictation.platform);
  const unsupported = dictation.platform === "unsupported";
  return (
    <Popover open={dictation.helpOpen} onOpenChange={dictation.setHelpOpen}>
      <Button ref={anchor} type="button" variant="ghost" size="icon" disabled={disabled || dictation.starting}
        aria-label="Dictate message" title="Dictate message" aria-haspopup="dialog" aria-expanded={dictation.helpOpen}
        aria-busy={dictation.starting || undefined}
        data-native-dictation
        className={`rounded-md text-dls-secondary hover:text-foreground ${dictation.reviewRequired ? "text-foreground" : ""}`}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => { if (dictation.helpOpen) dictation.setHelpOpen(false); else void dictation.start(); }}>
        {unsupported ? <Lock size={16} strokeWidth={1.5} /> : <Mic size={16} strokeWidth={1.5} />}
      </Button>
      <PopoverContent anchor={anchor} side="top" align="end" sideOffset={8} initialFocus={false} finalFocus={input}
        className="gap-3 rounded-xl p-3">
        <PopoverTitle className="text-sm">{dictation.failed ? "Couldn’t open system dictation" : info.title}</PopoverTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">{info.instruction}</p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Speech privacy</summary>
          <p className="pt-2">Your operating system handles audio and speech recognition under its settings. OpenWork receives only text in your draft. Check your system’s dictation settings for processing and sharing options.</p>
        </details>
        <Button variant="secondary" size="sm" onClick={() => { dictation.setHelpOpen(false); input()?.focus(); }}>Back to message</Button>
      </PopoverContent>
    </Popover>
  );
}

export function DictationReview({ onFinish }: { onFinish(): void }) {
  return <div data-dictation-review className="mt-2 flex items-center justify-between gap-2 text-xs text-dls-secondary">
    <span role="status">Review your text, then send · Enter adds a line</span>
    <Button variant="ghost" size="xs" onClick={onFinish}>Return to typing</Button>
  </div>;
}
