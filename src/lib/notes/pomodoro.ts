import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { useNotesStore } from "./store";
import { putPomodoroSession, putPomodoroRecord } from "./desktop-db";
import { PomodoroSession, PomodoroRecord, PomodoroPhase } from "./types";
import { nid } from "@/lib/utils";

let tickInterval: any = null;

function calculateRemaining(session: PomodoroSession) {
  if (session.lastPausedAt !== null) {
    return session.durationMs - ((session.lastPausedAt - session.startTime) - session.pausedTotalMs);
  }
  return session.durationMs - ((Date.now() - session.startTime) - session.pausedTotalMs);
}


let unlistenAction: any = null;
export function initPomodoroEngine() {
  if (!unlistenAction) {
     listen("pomodoro-action", (e: any) => {
        const action = e.payload;
        if (action === "pause") pausePomodoro();
        if (action === "resume") resumePomodoro();
        if (action === "cancel") cancelPomodoro();
     }).then(f => unlistenAction = f).catch(console.error);
  }
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    const session = useNotesStore.getState().pomodoroSession;
    if (!session || session.lastPausedAt !== null) return; // not running

    const remaining = calculateRemaining(session);
    if (remaining <= 0) {
      handleSessionComplete(session);
    } else {
      // Just force a re-render for UI by updating a transient timestamp, without saving to DB
      const now = Date.now(); useNotesStore.setState({ pomodoroTick: now }); syncToFloatingWindow(session, now);
    }
  }, 1000);
}

async function handleSessionComplete(session: PomodoroSession) {
  const settings = useNotesStore.getState().settings.pomodoro;
  if (settings.soundEnabled) {
     const audio = new Audio("/ping.mp3");
     audio.volume = settings.soundVolume;
     audio.play().catch(console.error);
  }
  // 1. Play sound & Notify
  const settings = useNotesStore.getState().settings.pomodoro;
  if (settings.notificationsEnabled) {
     try {
       const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
       let permissionGranted = await isPermissionGranted();
       if (!permissionGranted) {
           const permission = await requestPermission();
           permissionGranted = permission === "granted";
       }
       if (permissionGranted) {
           sendNotification({
              title: "Notes Pomodoro",
              body: session.phase === "focus" ? "Hết giờ tập trung! Đến lúc nghỉ ngơi." : "Hết giờ nghỉ! Quay lại làm việc nào."
           });
       }
     } catch (e) {
       console.error("Failed to send notification", e);
     }
  }

  // 2. Save record
  const record: PomodoroRecord = {
    id: nid(),
    startTime: session.startTime,
    endTime: Date.now(),
    durationMs: session.durationMs,
    phase: session.phase,
    status: "completed",
    taskName: session.taskName,
    notebookId: session.notebookId,
    pageId: session.pageId
  };
  await putPomodoroRecord(record);

  // 3. Determine next phase
  let nextPhase: PomodoroPhase = "shortBreak";
  let completed = session.completedSessions;
  if (session.phase === "focus") {
     completed += 1;
     if (completed % settings.longBreakInterval === 0) nextPhase = "longBreak";
     else nextPhase = "shortBreak";
  } else {
     nextPhase = "focus";
  }

  // Auto start?
  const autoStart = (nextPhase === "focus" && settings.autoStartFocus) || (nextPhase !== "focus" && settings.autoStartBreak);
  const nextDuration = nextPhase === "focus" ? settings.focusDuration * 60000 
                       : nextPhase === "shortBreak" ? settings.shortBreakDuration * 60000 
                       : settings.longBreakDuration * 60000;

  const nextSession: PomodoroSession = {
    phase: nextPhase,
    startTime: Date.now(),
    durationMs: nextDuration,
    pausedTotalMs: 0,
    lastPausedAt: autoStart ? null : Date.now(),
    taskId: session.taskId,
    taskName: session.taskName,
    notebookId: session.notebookId,
    pageId: session.pageId,
    completedSessions: completed
  };

  useNotesStore.setState({ pomodoroSession: nextSession });
  await putPomodoroSession(nextSession); syncToFloatingWindow(nextSession, Date.now());
  
  // Reload history
  const { getPomodoroHistory } = await import("./desktop-db");
  const history = await getPomodoroHistory();
  useNotesStore.setState({ pomodoroHistory: history });
}

export async function startPomodoro(phase: PomodoroPhase = "focus", taskName: string | null = null, notebookId: string | null = null, pageId: string | null = null) {
  const settings = useNotesStore.getState().settings.pomodoro;
  const durationMs = phase === "focus" ? settings.focusDuration * 60000 
                   : phase === "shortBreak" ? settings.shortBreakDuration * 60000 
                   : settings.longBreakDuration * 60000;
  
  const session: PomodoroSession = {
    phase,
    startTime: Date.now(),
    durationMs,
    pausedTotalMs: 0,
    lastPausedAt: null,
    taskId: null,
    taskName,
    notebookId,
    pageId,
    completedSessions: 0
  };
  
  useNotesStore.setState({ pomodoroSession: session });
  await putPomodoroSession(session); syncToFloatingWindow(session, Date.now());
}

export async function pausePomodoro() {
  const session = useNotesStore.getState().pomodoroSession;
  if (!session || session.lastPausedAt !== null) return;
  const next = { ...session, lastPausedAt: Date.now() };
  useNotesStore.setState({ pomodoroSession: next });
  await putPomodoroSession(next); syncToFloatingWindow(next, Date.now());
}

export async function resumePomodoro() {
  const session = useNotesStore.getState().pomodoroSession;
  if (!session || session.lastPausedAt === null) return;
  const pausedDuration = Date.now() - session.lastPausedAt;
  const next = { ...session, lastPausedAt: null, pausedTotalMs: session.pausedTotalMs + pausedDuration };
  useNotesStore.setState({ pomodoroSession: next });
  await putPomodoroSession(next);
}

export async function cancelPomodoro() {
  const session = useNotesStore.getState().pomodoroSession;
  if (session) {
     const record: PomodoroRecord = {
        id: nid(),
        startTime: session.startTime,
        endTime: Date.now(),
        durationMs: session.durationMs,
        phase: session.phase,
        status: "cancelled",
        taskName: session.taskName,
        notebookId: session.notebookId,
        pageId: session.pageId
     };
     await putPomodoroRecord(record);
     
     const { getPomodoroHistory } = await import("./desktop-db");
     const history = await getPomodoroHistory();
     useNotesStore.setState({ pomodoroHistory: history, pomodoroSession: null });
  }
  await putPomodoroSession(null); syncToFloatingWindow(null, Date.now());
}

export function getRemainingTime() {
   const s = useNotesStore.getState().pomodoroSession;
   if (!s) return 0;
   return Math.max(0, calculateRemaining(s));
}

function syncToFloatingWindow(session: PomodoroSession | null, tick: number) {
   emit("pomodoro-sync", { session, tick }).catch(console.error);
}
