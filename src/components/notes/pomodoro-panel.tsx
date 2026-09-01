import { useNotesStore } from "@/lib/notes/store";
import { startPomodoro, pausePomodoro, resumePomodoro, cancelPomodoro, getRemainingTime } from "@/lib/notes/pomodoro";
import { Play, Pause, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export function PomodoroPanel({ onClose }: { onClose: () => void }) {
  const session = useNotesStore((s) => s.pomodoroSession);
  useNotesStore((s) => s.pomodoroTick);
  const settings = useNotesStore((s) => s.settings.pomodoro);
  
  const remaining = getRemainingTime();
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Pomodoro" className="sm:max-w-md">
        <div className="flex flex-col items-center py-6">
           <div className="text-6xl font-mono font-bold mb-4">
              {minutes}:{seconds.toString().padStart(2, "0")}
           </div>
           
           {session ? (
             <div className="flex gap-4">
               {session.lastPausedAt ? (
                  <Button onClick={() => void resumePomodoro()}><Play className="mr-2 h-4 w-4" /> Tiếp tục</Button>
               ) : (
                  <Button variant="outline" onClick={() => void pausePomodoro()}><Pause className="mr-2 h-4 w-4" /> Tạm dừng</Button>
               )}
               <Button variant="danger" onClick={async () => {
                   if (confirm("Bạn có chắc chắn muốn hủy phiên này?")) {
                       await cancelPomodoro();
                   }
               }}>
                  <Square className="mr-2 h-4 w-4" /> Hủy bỏ
               </Button>
             </div>
           ) : (
             <div className="flex gap-4">
                 <Button onClick={() => void startPomodoro("focus")}>Bắt đầu tập trung ({settings.focusDuration}m)</Button>
                <Button variant="outline" onClick={() => void startPomodoro("shortBreak")}>Nghỉ ngắn</Button>
             </div>
           )}
           
           <div className="mt-8 text-sm text-muted">
              Cài đặt (25-5-15) - Tự động đồng bộ và khôi phục khi tắt máy
           </div>
        </div>
    </Dialog>
  );
}
