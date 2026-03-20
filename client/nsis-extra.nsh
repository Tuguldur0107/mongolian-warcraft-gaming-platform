; Суулгахаас өмнө хуучин апп-г хаах (file-in-use алдаа гарахгүй)
!macro customInit
  nsExec::Exec 'taskkill /F /IM "Mongolian Warcraft Gaming Platform.exe"'
  Sleep 1500
!macroend

!macro customInstall
!macroend

!macro customUnInstall
  ; Устгахаас өмнө апп-г хаах
  nsExec::Exec 'taskkill /F /IM "Mongolian Warcraft Gaming Platform.exe"'
  Sleep 1000
!macroend
