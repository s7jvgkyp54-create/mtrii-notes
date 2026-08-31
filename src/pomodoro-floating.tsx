import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Play, Pause, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PomodoroSession } from "@/lib/notes/types";
import { cn } from "@/lib/utils";
import "./styles.css"; // Ensure styles are loaded

export function PomodoroFloatingApp() {
  const [session, setSession] = useState<PomodoroSession | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const unlisten = listen("pomodoro-sync", (event: any) => {
       const { session: s, tick: t } = event.payload;
       setSession(s);
       setTick(t);
       
       // Auto close floating window if session is null
       if (!s) {
           getCurrentWindow().close();
       }
    });
    
    // Request initial state from main window?
    // For now we assume main window emits frequently enough
    
    return () => {
       unlisten.then(f => f());
    };
  }, []);

  if (!session) return null;

  // Re-calculate remaining using local time vs session.startTime
  // But wait, we should trust tick if we have it, or compute locally?
  // We can compute locally for smoothness.
  let remaining = 0;
  if (session.lastPausedAt !== null) {
    remaining = session.durationMs - ((session.lastPausedAt - session.startTime) - session.pausedTotalMs);
  } else {
    remaining = session.durationMs - ((Date.now() - session.startTime) - session.pausedTotalMs);
  }
  remaining = Math.max(0, remaining);

  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const isPaused = session.lastPausedAt !== null;

  const colors = {
     focus: "bg-red-500/20 text-red-500 border-red-500/30",
     shortBreak: "bg-green-500/20 text-green-500 border-green-500/30",
     longBreak: "bg-blue-500/20 text-blue-500 border-blue-500/30"
  };

  // We send actions back to main window via IPC or just emit events
  // But wait, the main window Tick Engine is running. If we pause here, we can't directly call `pausePomodoro` because we are in a different JS context!
  // We must emit to main window to do it!
  const sendAction = (action: string) => {
      // For simplicity, we can emit an event that main window listens to!
      // But we can't use invoke() unless we write a rust command.
      // So we use emit() from @tauri-apps/api/event and let main window listen!
      import("@tauri-apps/api/event").then(m => m.emit("pomodoro-action", action));
  };

  return (
    <div 
       data-tauri-drag-region 
       className={cn(
        "flex h-screen w-screen items-center justify-center gap-2 rounded-full border bg-surface/90 shadow-lg backdrop-blur-md",
        colors[session.phase]
      )}
    >
       <div data-tauri-drag-region className="relative flex h-12 w-12 items-center justify-center rounded-full border-2 border-current pointer-events-none">
          <span className="text-sm font-bold font-mono">
            {minutes}:{seconds.toString().padStart(2, "0")}
          </span>
       </div>
       <div className="flex flex-col gap-1">
         {isPaused ? (
           <Button size="icon" variant="ghost" className="h-6 w-6 rounded-full" onClick={() => sendAction("resume")}>
             <Play className="h-3 w-3" />
           </Button>
         ) : (
           <Button size="icon" variant="ghost" className="h-6 w-6 rounded-full" onClick={() => sendAction("pause")}>
             <Pause className="h-3 w-3" />
           </Button>
         )}
         <Button size="icon" variant="ghost" className="h-6 w-6 rounded-full" onClick={() => sendAction("cancel")}>
           <X className="h-3 w-3" />
         </Button>
       </div>
    </div>
  );
}
