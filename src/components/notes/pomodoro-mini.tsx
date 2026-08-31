import { useState, useEffect } from "react";
import { useNotesStore } from "@/lib/notes/store";
import { getRemainingTime, pausePomodoro, resumePomodoro, cancelPomodoro } from "@/lib/notes/pomodoro";
import { Play, Pause, X, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PomodoroMini({ onOpenFull }: { onOpenFull: () => void }) {
  const session = useNotesStore((s) => s.pomodoroSession);
  const tick = useNotesStore((s) => s.pomodoroTick); // subscribe to tick
  const showMiniClock = useNotesStore((s) => s.settings.pomodoro.showMiniClock);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    setRemaining(getRemainingTime());
  }, [session, tick]);

  if (!session || !showMiniClock) return null;

  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const isPaused = session.lastPausedAt !== null;
  const progress = remaining / session.durationMs;
  
  const colors = {
     focus: "bg-red-500/20 text-red-500 border-red-500/30",
     shortBreak: "bg-green-500/20 text-green-500 border-green-500/30",
     longBreak: "bg-blue-500/20 text-blue-500 border-blue-500/30"
  };

  return (
    <div className={cn(
        "fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border bg-surface p-2 shadow-lg backdrop-blur-md",
        colors[session.phase]
      )}
      style={{ cursor: "grab" }}
    >
       <div className="relative flex h-10 w-10 items-center justify-center rounded-full border-2 border-current">
          <span className="text-xs font-bold font-mono">
            {minutes}:{seconds.toString().padStart(2, "0")}
          </span>
       </div>
       <div className="flex gap-1">
         {isPaused ? (
           <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full" onClick={() => void resumePomodoro()}>
             <Play className="h-4 w-4" />
           </Button>
         ) : (
           <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full" onClick={() => void pausePomodoro()}>
             <Pause className="h-4 w-4" />
           </Button>
         )}
         <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full" onClick={() => void cancelPomodoro()}>
           <X className="h-4 w-4" />
         </Button>
         <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full" onClick={onOpenFull}>
           <Maximize2 className="h-4 w-4" />
         </Button>
       </div>
    </div>
  );
}
