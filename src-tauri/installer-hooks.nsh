; installer-hooks.nsh
; Runs before the installer begins - kills any running instance of the app
; so the uninstaller can complete cleanly (no "file in use" errors)

!macro NSIS_HOOK_PREINSTALL
  ; Kill old process names (both the old "Mtrii Notes" branding and current "notes")
  nsExec::Exec 'taskkill /F /IM "notes.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Mtrii Notes.exe" /T'
  ; Give Windows 1.5s to release all file handles
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM "notes.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Mtrii Notes.exe" /T'
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${Silent}
    ExecShell "" "$INSTDIR\Notes.exe"
  ${EndIf}
!macroend
