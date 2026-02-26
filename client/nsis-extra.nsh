; Суулгахаас өмнө хуучин апп-г хаах (file-in-use алдаа гарахгүй)
!macro customInit
  nsExec::Exec 'taskkill /F /IM "Mongolian Warcraft Gaming Platform.exe"'
  Sleep 1500
!macroend

; ZeroTier One далдуур суулгах
!macro customInstall
  DetailPrint "ZeroTier One суулгаж байна..."
  ExecWait 'msiexec /i "$INSTDIR\resources\ZeroTierOne.msi" /qn /norestart'
  DetailPrint "ZeroTier One суулгалт дууслаа."
!macroend

!macro customUnInstall
  ; Устгахаас өмнө апп-г хаах
  nsExec::Exec 'taskkill /F /IM "Mongolian Warcraft Gaming Platform.exe"'
  Sleep 1000
!macroend
